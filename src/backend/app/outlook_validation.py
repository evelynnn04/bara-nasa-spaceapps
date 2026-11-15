"""Held-out evaluation of the fire outlook per cell (see `docs/fire-outlook.md`).

Run `python -m app validate-outlook` after the cache is built. For every test year from
`FIRST_TEST_YEAR` to the last complete year, the tables and normals are counted on the complete
years before it only, and the outlook is scored on targets inside the test year:

- **day:** issue days every `DAY_EVERY` days whose target lies in the test year, leads `DAY_LEADS`;
- **month:** every issue month whose target lies in the test year, leads 1 to 12;
- **year:** issue years with at least `MIN_YEARS` complete years before them, leads 1 to 4.

Each outlook is compared with three baselines: the cell's **normal** over all earlier years (the
long-term chance of fire in that calendar month or year), its **recent normal** over the last
three earlier years, and the **calibrated normal**, the table's chance for the cell's normal class
whatever its recent fire. The gain over the calibrated normal is what recent fire adds. Scores,
over all land cells and over fire-prone cells: Brier skill against each baseline, area under the
ROC curve, and calibration (mean chance given against the share that burned, in bands of chance).
"""

from __future__ import annotations

import logging
from collections import defaultdict

from . import outlook as ol
from . import store
from .harmonise import weights

log = logging.getLogger("app.outlook_validation")

FIRST_TEST_YEAR = 2016
DAY_LEADS = (1, 2, 3, 5, 7, 10, 14, 21, 30)
DAY_EVERY = 7
MIN_YEARS = 3
#: Fire-prone cells: at least this many fire days a year (day step) or months with fire (month step).
BUSY = {"day": 5, "month": 2}
BANDS = (0.0, 0.01, 0.05, 0.1, 0.2, 0.3, 0.5, 0.7, 1.01)


def auc(hist: dict) -> float | None:
    """Area under the ROC curve from {score: [negatives, positives]} (ties counted half)."""
    neg_total = sum(v[0] for v in hist.values())
    pos_total = sum(v[1] for v in hist.values())
    if not neg_total or not pos_total:
        return None
    below, area = 0, 0.0
    for score in sorted(hist):
        neg, pos = hist[score]
        area += pos * (below + neg / 2)
        below += neg
    return area / (neg_total * pos_total)


class Scores:
    """Brier sums of the outlook and both baselines, ROC histograms and calibration bands."""

    def __init__(self) -> None:
        self.sums = defaultdict(float)
        self.roc = defaultdict(lambda: defaultdict(lambda: [0, 0]))
        self.bands = defaultdict(lambda: [0, 0.0, 0])

    def add(self, rows: list[tuple]) -> None:
        """Rows (tier, n, Brier sum of the outlook, the normal, the recent and the calibrated normal)."""
        for tier, n, bm, bn, br, bc in rows:
            self.sums[(tier, "n")] += n
            self.sums[(tier, "outlook")] += bm
            self.sums[(tier, "normal")] += bn
            self.sums[(tier, "recent")] += br
            self.sums[(tier, "calibrated")] += bc

    def add_roc(self, rows: list[tuple]) -> None:
        for kind, score, neg, pos in rows:
            h = self.roc[kind][score]
            h[0] += neg
            h[1] += pos

    def add_bands(self, rows: list[tuple]) -> None:
        for band, n, sum_p, hits in rows:
            b = self.bands[band]
            b[0] += n
            b[1] += sum_p
            b[2] += hits

    def summary(self) -> dict:
        out = {}
        for tier in ("all", "busy"):
            n = self.sums[(tier, "n")]
            if not n:
                continue
            bm, bn, br, bc = (self.sums[(tier, k)] for k in ("outlook", "normal", "recent", "calibrated"))
            out[tier] = {"n": int(n), "skill_vs_normal": 1 - bm / bn if bn else None,
                         "skill_vs_recent": 1 - bm / br if br else None,
                         "skill_vs_calibrated": 1 - bm / bc if bc else None,
                         "recent_vs_normal": 1 - br / bn if bn else None}
        out["auc"] = {kind: auc(h) for kind, h in self.roc.items()}
        out["bands"] = {BANDS[b]: (v[1] / v[0], v[2] / v[0], v[0]) for b, v in sorted(self.bands.items()) if v[0]}
        return out


def _band_sql(p: str) -> str:
    return "(" + " + ".join(f"CAST({p} >= {e} AS INTEGER)" for e in BANDS[1:-1]) + ")"


def _score(con, rows_sql: str, scores: Scores) -> None:
    """Adds the scores of a relation with columns k, p, f (normal), fr (recent normal), pc (calibrated
    normal), y (0/1) and busy."""
    con.execute(f"CREATE OR REPLACE TEMP TABLE ov_rows AS {rows_sql}")
    for k, in con.execute("SELECT DISTINCT k FROM ov_rows ORDER BY k").fetchall():
        s = scores.setdefault(k, Scores()) if isinstance(scores, dict) else scores
        s.add(con.execute(f"""
            SELECT tier, count(*), sum((p - y) ^ 2), sum((f - y) ^ 2), sum((fr - y) ^ 2), sum((pc - y) ^ 2) FROM (
                SELECT 'all' AS tier, * FROM ov_rows WHERE k = {k}
                UNION ALL SELECT 'busy', * FROM ov_rows WHERE k = {k} AND busy) GROUP BY tier""").fetchall())
        s.add_roc(con.execute(f"""
            SELECT 'outlook', round(p, 6), count(*) - sum(y), sum(y) FROM ov_rows WHERE k = {k} GROUP BY 2
            UNION ALL SELECT 'normal', round(f, 5), count(*) - sum(y), sum(y) FROM ov_rows WHERE k = {k} GROUP BY 2
            UNION ALL SELECT 'recent', round(fr, 5), count(*) - sum(y), sum(y) FROM ov_rows WHERE k = {k} GROUP BY 2
            UNION ALL SELECT 'calibrated', round(pc, 6), count(*) - sum(y), sum(y) FROM ov_rows WHERE k = {k} GROUP BY 2
        """).fetchall())
        s.add_bands(con.execute(f"""SELECT {_band_sql('p')} AS band, count(*), sum(p), sum(y) FROM ov_rows
                                    WHERE k = {k} GROUP BY band""").fetchall())


def evaluate(con) -> dict:
    """{step: {lead: Scores}} over every test year."""
    ol.prepare(con)
    years = ol.complete_years(con)
    out: dict = {"day": {}, "month": {}, "year": {}}
    for test in [y for y in years if y >= FIRST_TEST_YEAR]:
        train = [y for y in years if y < test]
        recent = train[-3:]
        day_counts = ol.day_table(con, train, list(DAY_LEADS))
        month_counts = ol.month_table(con, train, list(range(1, ol.MONTH_LEADS + 1)))
        n_day, n_month = len(ol.DAY_NORMAL_EDGES) + 1, len(ol.MONTH_NORMAL_EDGES) + 1
        ol.load_tables(con, ol.chances(day_counts, n_day, ol.DAY_COMBOS), ol.chances(month_counts, n_month, ol.MONTH_COMBOS))
        for name, counts, n in (("ov_dc", day_counts, n_day), ("ov_mc", month_counts, n_month)):
            con.execute(f"CREATE OR REPLACE TEMP TABLE {name} (k INTEGER, b INTEGER, p DOUBLE)")
            con.executemany(f"INSERT INTO {name} VALUES (?, ?, ?)",
                            [(k, b, v) for (k, b), v in ol.class_chances(counts, n).items()])
        con.execute(f"CREATE OR REPLACE TEMP TABLE ov_dn_recent AS {ol._day_normal_sql(recent, loo=False)}")
        con.execute(f"""CREATE OR REPLACE TEMP TABLE ov_busy_day AS SELECT cx, cy FROM ol_k
                        WHERE y IN ({ol._years(train)}) GROUP BY cx, cy HAVING sum(k) >= {BUSY['day']} * {len(train)}""")
        ol.day_inputs(con, train, f"""SELECT d FROM ol_days WHERE d BETWEEN make_date({test}, 1, 1) - {max(DAY_LEADS)}
                                      AND make_date({test}, 12, 31) AND (d - make_date({test - 1}, 1, 1)) % {DAY_EVERY} = 0""")
        _score(con, f"""
            SELECT pr.k, pr.p, pr.f, r.f AS fr, c.p AS pc, CAST(a.cx IS NOT NULL AS INTEGER) AS y,
                   (pr.cx, pr.cy) IN (SELECT cx, cy FROM ov_busy_day) AS busy
            FROM ({ol.day_predict_sql(list(DAY_LEADS))}) pr
            JOIN ov_dn_recent r ON r.cx = pr.cx AND r.cy = pr.cy AND r.m = month(pr.d + pr.k)
            JOIN ov_dc c ON c.k = pr.k AND c.b = {ol._class_sql('pr.f', ol.DAY_NORMAL_EDGES)}
            JOIN ol_days o ON o.d = pr.d + pr.k
            LEFT JOIN ol_act a ON a.d = pr.d + pr.k AND a.cx = pr.cx AND a.cy = pr.cy
            WHERE year(pr.d + pr.k) = {test}""", out["day"])
        ol.month_inputs(con, recent, "SELECT 0 AS y, 0 AS m WHERE FALSE")
        con.execute("CREATE OR REPLACE TEMP TABLE ov_mn_recent AS SELECT * FROM ol_mn_p")
        con.execute(f"""CREATE OR REPLACE TEMP TABLE ov_busy_month AS SELECT cx, cy FROM ol_m
                        WHERE y IN ({ol._years(train)}) GROUP BY cx, cy HAVING count(*) >= {BUSY['month']} * {len(train)}""")
        ol.month_inputs(con, train, f"""SELECT DISTINCT y, m FROM ol_n
                                        WHERE make_date(y, m, 1) BETWEEN make_date({test - 1}, 1, 1) AND make_date({test}, 11, 1)""")
        _score(con, f"""
            SELECT pr.k, pr.p, pr.f, r.f AS fr, c.p AS pc, CAST(t.cx IS NOT NULL AS INTEGER) AS y,
                   (pr.cx, pr.cy) IN (SELECT cx, cy FROM ov_busy_month) AS busy
            FROM ({ol.month_predict_sql(list(range(1, ol.MONTH_LEADS + 1)))}) pr
            JOIN ov_mn_recent r ON r.cx = pr.cx AND r.cy = pr.cy AND r.m = pr.tm
            JOIN ov_mc c ON c.k = pr.k AND c.b = {ol._class_sql('pr.f', ol.MONTH_NORMAL_EDGES)}
            JOIN ol_n n ON n.y = pr.ty AND n.m = pr.tm
            LEFT JOIN ol_m t ON t.cx = pr.cx AND t.cy = pr.cy AND t.y = pr.ty AND t.m = pr.tm
            WHERE pr.ty = {test}""", out["month"])
        log.info("test year %d scored", test)
    for k in range(1, ol.YEAR_LEADS + 1):
        for issue in years:
            before = [y for y in years if y <= issue]
            if len(before) < MIN_YEARS or issue + k not in years:
                continue
            _score(con, f"""
                SELECT {k} AS k, n.f AS p, n.f, r.f AS fr, n.f AS pc,
                       CAST(EXISTS (SELECT 1 FROM ol_m t WHERE t.cx = n.cx AND t.cy = n.cy AND t.y = {issue + k}) AS INTEGER) AS y,
                       FALSE AS busy
                FROM ({ol.year_normal_sql(before)}) n JOIN ({ol.year_normal_sql(before[-3:])}) r USING (cx, cy)""",
                   out["year"])
    return out


def report(results: dict) -> None:
    """Prints the evaluation tables."""
    for step, leads in results.items():
        print(f"\n=== {step} step ===")
        print(f"  {'lead':>4} {'label':14} {'rows':>10} {'vs normal':>10} {'vs calibrated':>14} {'fire-prone':>11} "
              f"{'vs recent':>10} {'recent vs normal':>17} {'AUC outlook':>12} {'AUC normal':>11}")
        for k, s in sorted(leads.items()):
            r = s.summary()
            a, b = r.get("all", {}), r.get("busy", {})
            pct = lambda v: "-" if v is None else f"{100 * v:+.1f}%"
            au = r["auc"]
            print(f"  {k:4} {ol.LABELS[step].get(k, '-'):14} {a.get('n', 0):10} {pct(a.get('skill_vs_normal')):>10} "
                  f"{pct(a.get('skill_vs_calibrated')):>14} {pct(b.get('skill_vs_calibrated')):>11} "
                  f"{pct(a.get('skill_vs_recent')):>10} {pct(a.get('recent_vs_normal')):>17} "
                  f"{au.get('outlook') or 0:12.3f} {au.get('normal') or 0:11.3f}")
        first = min(leads) if leads else None
        if first is not None and step != "year":
            bands = leads[first].summary()["bands"]
            print(f"  calibration, lead {first}: " + "; ".join(f"from {lo:g}: given {p:.3f}, burned {o:.3f} (n={n})"
                                                          for lo, (p, o, n) in bands.items()))


def run() -> None:
    """Scores the outlook on held-out years and prints the tables."""
    con = store.connect(weights.load_params())
    if not store.has(con, "celldays", "days", "cells"):
        raise SystemExit("The derived tables are missing. Run `python -m app all` first.")
    report(evaluate(con))
