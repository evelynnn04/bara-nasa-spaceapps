"""Fire outlook per 0.05° cell for the forecast timeline (see `docs/fire-outlook.md`).

The chance that a cell holds fire (at least one vegetation hotspot of the record satellite) at
each step after the last data, for three step sizes:

- **day:** fire on day d + k, k = 1 to `DAY_LEADS`, issued on the last data day d;
- **month:** fire in month t + k, k = 1 to `MONTH_LEADS`, issued after the last complete month t;
- **year:** fire in year Y + k, k = 1 to `YEAR_LEADS`, where Y is the year of the last data day.

Every chance is a frequency counted in the record (VIIRS era, from `config.SPLICE`): no fitted
curve, so the chances are calibrated by construction. Each count is over cells sharing:

- the **normal** of the cell, its share of fire for the target calendar month over the years
  used (days with fire for the day step, years with fire for the month step), in classes
  (`DAY_NORMAL_EDGES`, `MONTH_NORMAL_EDGES`). While counting, the target's own year is left out
  of the normal, so the table does not learn from the outcome it predicts;
- its **recent fire**: for the day step, whether it burns on the issue day, on how many of the
  last 7 days, and how many of its 8 neighbours burn on the issue day; for the month step,
  whether it burned in the issue month and how many neighbours did.

A chance is `(hits + SMOOTH * p_class) / (trials + SMOOTH)`, drawn towards the chance of its
normal class alone where a combination is rare. The year step is the cell's normal over the
complete years (the record held no better yearly predictor; see the document).

Each step also carries a **label** from the held-out evaluation (`LABELS`): `forecast` where
recent fire clearly improves on the normal, `weak forecast` where it improves on it a little, and
`seasonal` (or `baseline` for years) where the outlook is essentially the normal.
"""

from __future__ import annotations

import datetime as dt
import json
import logging
from pathlib import Path

import duckdb

from . import config
from .harmonise import weights

log = logging.getLogger("app.outlook")

DAY_LEADS = 30
MONTH_LEADS = 12
YEAR_LEADS = 5
#: Upper edges of the classes of a cell's daily fire frequency in a calendar month.
DAY_NORMAL_EDGES = (0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.05)
#: Upper edges of the classes of a cell's share of years with fire in a calendar month.
MONTH_NORMAL_EDGES = (0.03, 0.08, 0.15, 0.25, 0.4, 0.6, 0.8)
#: Pseudo-counts drawing a normal towards the month's mean over all cells.
NORMAL_PRIOR = 30
#: Pseudo-counts drawing a table chance towards the chance of its normal class.
SMOOTH = 50
#: Chances below this are not stored or sent.
MIN_CHANCE = 0.002

#: Label of each lead, from the held-out evaluation (`python -m app validate-outlook`): `forecast`
#: where recent fire improves on the calibrated normal by at least 4 % (Brier skill), `weak
#: forecast` by at least 2 %, `seasonal` below that.
LABELS = {
    "day": {k: "forecast" if k <= 3 else "weak forecast" if k <= 10 else "seasonal" for k in range(1, DAY_LEADS + 1)},
    "month": {k: "forecast" if k == 1 else "weak forecast" if k == 2 else "seasonal" for k in range(1, MONTH_LEADS + 1)},
    "year": {k: "baseline" for k in range(1, YEAR_LEADS + 1)},
}
NB8 = ", ".join(f"({dx}, {dy})" for dx in (-1, 0, 1) for dy in (-1, 0, 1) if dx or dy)


def path() -> Path:
    return config.derived_dir() / "outlook.parquet"


def target(step: str, issued: dict, lead: int) -> str:
    """The day (YYYY-MM-DD), month (YYYY-MM) or year a lead of a step falls on."""
    if step == "day":
        return str(dt.date.fromisoformat(issued["day"]) + dt.timedelta(days=lead))
    if step == "month":
        y, m = map(int, issued["month"].split("-"))
        i = y * 12 + m - 1 + lead
        return f"{i // 12}-{i % 12 + 1:02d}"
    return str(int(issued["year"]) + lead)


def load_meta() -> dict | None:
    """The description written by `build`, or None when the outlook has not been built."""
    p = meta_path()
    return json.loads(p.read_text(encoding="utf-8")) if p.is_file() else None


def meta_path() -> Path:
    return config.derived_dir() / "outlook.json"


def _class_sql(value: str, edges: tuple[float, ...]) -> str:
    return "(" + " + ".join(f"CAST({value} >= {e} AS INTEGER)" for e in edges) + ")"


def prepare(con: duckdb.DuckDBPyConnection, hotspots: str = "vegetation") -> None:
    """Temp tables shared by every step: active cell-days `ol_act(d, cx, cy)` of the VIIRS era,
    observed days `ol_days(d)`, active days per cell, year and month `ol_k`, observed days per
    year and month `ol_n`, and monthly fire `ol_m(cx, cy, y, m)`."""
    where = f"c.local_date >= DATE '{config.SPLICE}'"
    con.execute(f"CREATE OR REPLACE TEMP TABLE ol_act AS SELECT DISTINCT c.local_date AS d, c.cx, c.cy "
                f"FROM ({weights.record_sql(where, hotspots)}) c")
    con.execute(f"CREATE OR REPLACE TEMP TABLE ol_days AS SELECT local_date AS d FROM days "
                f"WHERE record_platform IS NOT NULL AND local_date >= DATE '{config.SPLICE}'")
    con.execute("""CREATE OR REPLACE TEMP TABLE ol_k AS SELECT cx, cy, year(d) AS y, month(d) AS m, count(*) AS k
                   FROM ol_act GROUP BY ALL""")
    con.execute("CREATE OR REPLACE TEMP TABLE ol_n AS SELECT year(d) AS y, month(d) AS m, count(*) AS n FROM ol_days GROUP BY ALL")
    con.execute("CREATE OR REPLACE TEMP TABLE ol_m AS SELECT DISTINCT cx, cy, y, m FROM ol_k")


def complete_years(con: duckdb.DuckDBPyConnection) -> list[int]:
    """Calendar years of the VIIRS era the record covers completely."""
    first, last = con.execute("SELECT min(d), max(d) FROM ol_days").fetchone()
    if first is None:
        return []
    return [y for y in range(first.year, last.year + 1) if first <= dt.date(y, 1, 1) and dt.date(y, 12, 31) <= last]


def _years(years: list[int]) -> str:
    return ", ".join(str(y) for y in years) or "NULL"


def _day_normal_sql(years: list[int], loo: bool) -> str:
    """Daily fire frequency per (cx, cy, m) over `years`, or with `loo` per (cx, cy, y, m) leaving
    year y out. Columns cx, cy, m (, y), f."""
    ys = _years(years)
    base = f"""
        tot AS (SELECT cx, cy, m, sum(k) AS k FROM ol_k WHERE y IN ({ys}) GROUP BY ALL),
        nm AS (SELECT m, sum(n) AS n FROM ol_n WHERE y IN ({ys}) GROUP BY m),
        p0 AS (SELECT t.m, sum(t.k) / (any_value(nm.n) * (SELECT count(*) FROM cells)) AS p
               FROM tot t JOIN nm USING (m) GROUP BY t.m)"""
    if not loo:
        return f"""WITH {base}
            SELECT k.cx, k.cy, nm.m, (coalesce(t.k, 0) + {NORMAL_PRIOR} * coalesce(p0.p, 0)) / (nm.n + {NORMAL_PRIOR}) AS f
            FROM cells k CROSS JOIN nm LEFT JOIN p0 ON p0.m = nm.m LEFT JOIN tot t ON t.cx = k.cx AND t.cy = k.cy AND t.m = nm.m"""
    return f"""WITH {base}
        SELECT k.cx, k.cy, n.y, n.m,
               (coalesce(t.k, 0) - coalesce(o.k, 0) + {NORMAL_PRIOR} * coalesce(p0.p, 0)) / (nm.n - n.n + {NORMAL_PRIOR}) AS f
        FROM cells k CROSS JOIN (SELECT * FROM ol_n WHERE y IN ({ys})) n
        JOIN nm ON nm.m = n.m LEFT JOIN p0 ON p0.m = n.m
        LEFT JOIN tot t ON t.cx = k.cx AND t.cy = k.cy AND t.m = n.m
        LEFT JOIN ol_k o ON o.cx = k.cx AND o.cy = k.cy AND o.y = n.y AND o.m = n.m"""


def _day_features_sql(where_d: str) -> str:
    """Cells with any recent fire on issue days matching `where_d` (over alias `d`): today (0/1),
    week (active days d-6..d), nbs (active neighbours on d). Cells without are all zero."""
    return f"""
        SELECT d, cx, cy, max(today) AS today, sum(wk) AS week, sum(nb) AS nbs FROM (
            SELECT d, cx, cy, 1 AS today, 1 AS wk, 0 AS nb FROM ol_act
            UNION ALL SELECT a.d + CAST(i AS INTEGER), a.cx, a.cy, 0, 1, 0 FROM ol_act a, range(1, 7) r(i)
            UNION ALL SELECT a.d, a.cx + o.dx, a.cy + o.dy, 0, 0, 1 FROM ol_act a, (VALUES {NB8}) o(dx, dy)
        ) f WHERE {where_d}
        GROUP BY d, cx, cy"""


WEEK_CLASS = "CASE WHEN week = 0 THEN 0 WHEN week = 1 THEN 1 WHEN week <= 3 THEN 2 ELSE 3 END"
NB_CLASS = "CASE WHEN nbs = 0 THEN 0 WHEN nbs = 1 THEN 1 ELSE 2 END"


def day_table(con: duckdb.DuckDBPyConnection, years: list[int], leads: list[int]) -> dict:
    """Counts (trials, hits) per (lead, normal class, today, week class, neighbour class) over issue
    days whose target lies in `years`, with each normal leaving the target's year out."""
    ys = _years(years)
    con.execute(f"CREATE OR REPLACE TEMP TABLE ol_dn AS {_day_normal_sql(years, loo=True)}")
    con.execute(f"""CREATE OR REPLACE TEMP TABLE ol_dn_c AS
                    SELECT cx, cy, y, m, {_class_sql('f', DAY_NORMAL_EDGES)} AS b FROM ol_dn""")
    con.execute(f"""CREATE OR REPLACE TEMP TABLE ol_df AS {_day_features_sql('d IN (SELECT d FROM ol_days)')}""")
    con.execute("CREATE OR REPLACE TEMP TABLE ol_cells AS SELECT cx, cy FROM cells")
    counts: dict = {}
    for k in leads:
        # Issue days with an observed target day k later inside the years.
        con.execute(f"""CREATE OR REPLACE TEMP TABLE ol_pairs AS
                        SELECT o.d AS d, t.d AS t FROM ol_days o JOIN ol_days t ON t.d = o.d + {k}
                        WHERE year(t.d) IN ({ys})""")
        nonzero = con.execute(f"""
            SELECT c.b, f.today, {WEEK_CLASS} AS w, {NB_CLASS} AS nb, count(*) AS trials, count(a.cx) AS hits
            FROM ol_df f JOIN ol_pairs p ON p.d = f.d
            JOIN ol_dn_c c ON c.cx = f.cx AND c.cy = f.cy AND c.y = year(p.t) AND c.m = month(p.t)
            LEFT JOIN ol_act a ON a.d = p.t AND a.cx = f.cx AND a.cy = f.cy
            GROUP BY ALL""").fetchall()
        totals = con.execute("""
            WITH per AS (SELECT year(t) AS y, month(t) AS m, count(*) AS n FROM ol_pairs GROUP BY ALL),
            hits AS (SELECT a.cx, a.cy, year(p.t) AS y, month(p.t) AS m, count(*) AS h
                     FROM ol_pairs p JOIN ol_act a ON a.d = p.t GROUP BY ALL)
            SELECT c.b, sum(per.n) AS trials, sum(coalesce(h.h, 0)) AS hits
            FROM ol_dn_c c JOIN per ON per.y = c.y AND per.m = c.m
            LEFT JOIN hits h ON h.cx = c.cx AND h.cy = c.cy AND h.y = c.y AND h.m = c.m
            GROUP BY c.b""").fetchall()
        zero = {b: [int(t), int(h)] for b, t, h in totals}
        for b, today, w, nb, t, h in nonzero:
            counts[(k, b, today, w, nb)] = [int(t), int(h)]
            zero[b][0] -= int(t)
            zero[b][1] -= int(h)
        for b, (t, h) in zero.items():
            counts[(k, b, 0, 0, 0)] = [t, h]
    return counts


def month_table(con: duckdb.DuckDBPyConnection, years: list[int], leads: list[int]) -> dict:
    """Counts (trials, hits) per (lead, normal class, fire in the issue month, neighbour class)
    over issue months whose target lies in `years`, with each normal leaving the target's year out."""
    ys = _years(years)
    con.execute(f"""CREATE OR REPLACE TEMP TABLE ol_mn AS
        WITH tot AS (SELECT cx, cy, m, count(*) AS k FROM ol_m WHERE y IN ({ys}) GROUP BY ALL),
        n AS (SELECT {len(years)} AS n),
        p0 AS (SELECT m, sum(k) / ((SELECT n FROM n) * (SELECT count(*) FROM cells)) AS p FROM tot GROUP BY m)
        SELECT k.cx, k.cy, yy.y, mm.m,
               {_class_sql(f"(coalesce(t.k, 0) - CAST(o.cx IS NOT NULL AS INTEGER) + {NORMAL_PRIOR / 10} * coalesce(p0.p, 0)) / ((SELECT n FROM n) - 1 + {NORMAL_PRIOR / 10})", MONTH_NORMAL_EDGES)} AS b
        FROM cells k CROSS JOIN (SELECT unnest([{ys}]) AS y) yy CROSS JOIN (SELECT CAST(m AS INTEGER) AS m FROM range(1, 13) r(m)) mm
        LEFT JOIN p0 ON p0.m = mm.m
        LEFT JOIN tot t ON t.cx = k.cx AND t.cy = k.cy AND t.m = mm.m
        LEFT JOIN ol_m o ON o.cx = k.cx AND o.cy = k.cy AND o.y = yy.y AND o.m = mm.m""")
    con.execute(f"""CREATE OR REPLACE TEMP TABLE ol_mf AS
        SELECT o.cx, o.cy, o.y, o.m, max(CAST(o.dx = 0 AND o.dy = 0 AS INTEGER)) AS last,
               sum(CAST(o.dx <> 0 OR o.dy <> 0 AS INTEGER)) AS nbs FROM (
            SELECT cx, cy, y, m, 0 AS dx, 0 AS dy FROM ol_m
            UNION ALL SELECT a.cx + v.dx, a.cy + v.dy, a.y, a.m, v.dx, v.dy FROM ol_m a, (VALUES {NB8}) v(dx, dy)
        ) o GROUP BY ALL""")
    counts: dict = {}
    for k in leads:
        rows = con.execute(f"""
            WITH issue AS (SELECT DISTINCT y, m FROM ol_n),
            pairs AS (SELECT i.y, i.m, CAST(year(make_date(i.y, i.m, 1) + INTERVAL {k} MONTH) AS INTEGER) AS ty,
                             CAST(month(make_date(i.y, i.m, 1) + INTERVAL {k} MONTH) AS INTEGER) AS tm FROM issue i),
            valid AS (SELECT p.* FROM pairs p JOIN ol_n n ON n.y = p.ty AND n.m = p.tm WHERE p.ty IN ({ys}))
            SELECT c.b, coalesce(f.last, 0) AS last, {NB_CLASS.replace('nbs', 'coalesce(f.nbs, 0)')} AS nb,
                   count(*) AS trials, count(t.cx) AS hits
            FROM valid v CROSS JOIN cells k
            JOIN ol_mn c ON c.cx = k.cx AND c.cy = k.cy AND c.y = v.ty AND c.m = v.tm
            LEFT JOIN ol_mf f ON f.cx = k.cx AND f.cy = k.cy AND f.y = v.y AND f.m = v.m
            LEFT JOIN ol_m t ON t.cx = k.cx AND t.cy = k.cy AND t.y = v.ty AND t.m = v.tm
            GROUP BY ALL""").fetchall()
        for b, last, nb, t, h in rows:
            counts[(k, b, last, nb)] = [int(t), int(h)]
    return counts


DAY_COMBOS = [(t, w, n) for t in (0, 1) for w in range(4) for n in range(3)]
MONTH_COMBOS = [(last, n) for last in (0, 1) for n in range(3)]


def class_chances(counts: dict, n_classes: int) -> dict:
    """Chance of fire per (lead, normal class) whatever the recent fire, for every class: a class
    without trials takes the nearest class that has some."""
    by_class: dict = {}
    for key, (t, h) in counts.items():
        acc = by_class.setdefault(key[:2], [0, 0])
        acc[0] += t
        acc[1] += h
    out = {}
    for k in sorted({key[0] for key in counts}):
        seen = {b: h / t for (kk, b), (t, h) in by_class.items() if kk == k and t}
        for b in range(n_classes):
            near = min(seen, key=lambda c: (abs(c - b), c)) if seen else None
            out[(k, b)] = seen[near] if near is not None else 0.0
    return out


def chances(counts: dict, n_classes: int, combos: list[tuple]) -> dict:
    """Chance per (lead, normal class, *recent fire) for every combination, drawn towards the chance
    of its class where trials are few; a combination never seen takes its class's chance."""
    pc = class_chances(counts, n_classes)
    out = {}
    for (k, b), p in pc.items():
        for combo in combos:
            t, h = counts.get((k, b, *combo), (0, 0))
            out[(k, b, *combo)] = (h + SMOOTH * p) / (t + SMOOTH)
    return out


def load_tables(con: duckdb.DuckDBPyConnection, day: dict, month: dict) -> None:
    """Temp tables `ol_dt(k, b, today, w, nb, p)` and `ol_mt(k, b, last, nb, p)` of the chances."""
    con.execute("CREATE OR REPLACE TEMP TABLE ol_dt (k INTEGER, b INTEGER, today INTEGER, w INTEGER, nb INTEGER, p DOUBLE)")
    con.executemany("INSERT INTO ol_dt VALUES (?, ?, ?, ?, ?, ?)", [(*key, v) for key, v in day.items()])
    con.execute("CREATE OR REPLACE TEMP TABLE ol_mt (k INTEGER, b INTEGER, last INTEGER, nb INTEGER, p DOUBLE)")
    con.executemany("INSERT INTO ol_mt VALUES (?, ?, ?, ?, ?)", [(*key, v) for key, v in month.items()])


def day_inputs(con: duckdb.DuckDBPyConnection, years: list[int], issues_sql: str) -> None:
    """Temp tables for day predictions: normals over `years` (`ol_dn_p`), issue days (`ol_di`, from
    a query returning column d) and their recent-fire features (`ol_df_p`)."""
    con.execute(f"CREATE OR REPLACE TEMP TABLE ol_dn_p AS {_day_normal_sql(years, loo=False)}")
    con.execute(f"CREATE OR REPLACE TEMP TABLE ol_di AS {issues_sql}")
    con.execute(f"CREATE OR REPLACE TEMP TABLE ol_df_p AS {_day_features_sql('d IN (SELECT d FROM ol_di)')}")


def day_predict_sql(leads: list[int]) -> str:
    """Issue day d, lead k, cell and chance p for every issue day of `ol_di` and cell (see `day_inputs`);
    `f` is the cell's normal daily frequency of the target's month."""
    ks = ", ".join(str(k) for k in leads)
    return f"""
        SELECT i.d, l.k, n.cx, n.cy, t.p, n.f FROM ol_di i
        CROSS JOIN (SELECT unnest([{ks}]) AS k) l
        JOIN ol_dn_p n ON n.m = month(i.d + l.k)
        LEFT JOIN ol_df_p f ON f.d = i.d AND f.cx = n.cx AND f.cy = n.cy
        JOIN ol_dt t ON t.k = l.k AND t.b = {_class_sql('n.f', DAY_NORMAL_EDGES)}
            AND t.today = coalesce(f.today, 0) AND t.w = {WEEK_CLASS.replace('week', 'coalesce(f.week, 0)')}
            AND t.nb = {NB_CLASS.replace('nbs', 'coalesce(f.nbs, 0)')}"""


def month_inputs(con: duckdb.DuckDBPyConnection, years: list[int], issues_sql: str) -> None:
    """Temp tables for month predictions: each cell's share of `years` with fire per calendar month
    (`ol_mn_p`), issue months (`ol_mi`, from a query returning columns y, m) and the monthly
    features (`ol_mf`, from `month_table`, or built here)."""
    ys = _years(years)
    con.execute(f"""CREATE OR REPLACE TEMP TABLE ol_mn_p AS
        WITH tot AS (SELECT cx, cy, m, count(*) AS c FROM ol_m WHERE y IN ({ys}) GROUP BY ALL),
        p0 AS (SELECT m, sum(c) / ({max(1, len(years))} * (SELECT count(*) FROM cells)) AS p FROM tot GROUP BY m)
        SELECT k.cx, k.cy, mm.m, (coalesce(t.c, 0) + {NORMAL_PRIOR / 10} * coalesce(p0.p, 0)) / ({len(years)} + {NORMAL_PRIOR / 10}) AS f
        FROM cells k CROSS JOIN (SELECT CAST(m AS INTEGER) AS m FROM range(1, 13) r(m)) mm
        LEFT JOIN p0 ON p0.m = mm.m LEFT JOIN tot t ON t.cx = k.cx AND t.cy = k.cy AND t.m = mm.m""")
    con.execute(f"CREATE OR REPLACE TEMP TABLE ol_mi AS {issues_sql}")
    con.execute(f"""CREATE OR REPLACE TEMP TABLE ol_mf AS
        SELECT o.cx, o.cy, o.y, o.m, max(CAST(o.dx = 0 AND o.dy = 0 AS INTEGER)) AS last,
               sum(CAST(o.dx <> 0 OR o.dy <> 0 AS INTEGER)) AS nbs FROM (
            SELECT cx, cy, y, m, 0 AS dx, 0 AS dy FROM ol_m
            UNION ALL SELECT a.cx + v.dx, a.cy + v.dy, a.y, a.m, v.dx, v.dy FROM ol_m a, (VALUES {NB8}) v(dx, dy)
        ) o GROUP BY ALL""")


def month_predict_sql(leads: list[int]) -> str:
    """Issue month (y, m), lead k, target (ty, tm), cell, chance p and normal f for every issue month
    of `ol_mi` and cell (see `month_inputs`)."""
    ks = ", ".join(str(k) for k in leads)
    return f"""
        WITH l AS (SELECT i.y, i.m, k.k,
                          CAST(year(make_date(i.y, i.m, 1) + to_months(k.k)) AS INTEGER) AS ty,
                          CAST(month(make_date(i.y, i.m, 1) + to_months(k.k)) AS INTEGER) AS tm
                   FROM ol_mi i CROSS JOIN (SELECT unnest([{ks}]) AS k) k)
        SELECT l.y, l.m, l.k, l.ty, l.tm, n.cx, n.cy, t.p, n.f FROM l
        JOIN ol_mn_p n ON n.m = l.tm
        LEFT JOIN ol_mf f ON f.cx = n.cx AND f.cy = n.cy AND f.y = l.y AND f.m = l.m
        JOIN ol_mt t ON t.k = l.k AND t.b = {_class_sql('n.f', MONTH_NORMAL_EDGES)}
            AND t.last = coalesce(f.last, 0) AND t.nb = {NB_CLASS.replace('nbs', 'coalesce(f.nbs, 0)')}"""


def year_normal_sql(years: list[int]) -> str:
    """Each cell's share of `years` with fire (cx, cy, f)."""
    ys = _years(years)
    return f"""
        WITH fy AS (SELECT cx, cy, count(DISTINCT y) AS c FROM ol_m WHERE y IN ({ys}) GROUP BY ALL),
        p0 AS (SELECT coalesce(sum(c), 0) / ({max(1, len(years))} * (SELECT count(*) FROM cells)) AS p FROM fy)
        SELECT k.cx, k.cy, (coalesce(fy.c, 0) + p0.p) / ({len(years)} + 1.0) AS f
        FROM cells k CROSS JOIN p0 LEFT JOIN fy ON fy.cx = k.cx AND fy.cy = k.cy"""


def issue_dates(con: duckdb.DuckDBPyConnection) -> dict:
    """Issue day (last data day), month (last complete month) and year (the year of the last data
    day, so that year leads are years still to come; the year normal uses complete years only)."""
    last = con.execute("SELECT max(d) FROM ol_days").fetchone()[0]
    first_of_month = dt.date(last.year, last.month, 1)
    month_end = (first_of_month + dt.timedelta(days=32)).replace(day=1) - dt.timedelta(days=1)
    prev = first_of_month - dt.timedelta(days=1)
    month = (last.year, last.month) if last == month_end else (prev.year, prev.month)
    return {"day": last, "month": month, "year": last.year}


def build(con: duckdb.DuckDBPyConnection, hotspots: str = "vegetation") -> dict:
    """Counts the tables over every complete VIIRS-era year and writes the outlook of every step
    (`outlook.parquet`: step, lead, cx, cy, chance) and its description (`outlook.json`)."""
    prepare(con, hotspots)
    years = complete_years(con)
    issued = issue_dates(con)
    day_leads, month_leads = list(range(1, DAY_LEADS + 1)), list(range(1, MONTH_LEADS + 1))
    load_tables(con, chances(day_table(con, years, day_leads), len(DAY_NORMAL_EDGES) + 1, DAY_COMBOS),
                chances(month_table(con, years, month_leads), len(MONTH_NORMAL_EDGES) + 1, MONTH_COMBOS))
    day_inputs(con, years, f"SELECT DATE '{issued['day']}' AS d")
    y, m = issued["month"]
    month_inputs(con, years, f"SELECT {y} AS y, {m} AS m")
    out = path()
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(".part")
    con.execute(f"""COPY (
        SELECT 'day' AS step, k AS lead, cx, cy, p AS chance FROM ({day_predict_sql(day_leads)}) WHERE p >= {MIN_CHANCE}
        UNION ALL SELECT 'month', k, cx, cy, p FROM ({month_predict_sql(month_leads)}) WHERE p >= {MIN_CHANCE}
        UNION ALL SELECT 'year', CAST(r.k AS INTEGER), n.cx, n.cy, n.f FROM ({year_normal_sql(years)}) n
                  CROSS JOIN range(1, {YEAR_LEADS + 1}) r(k) WHERE n.f >= {MIN_CHANCE}
        ORDER BY 1, 2, 3, 4) TO '{tmp}' (FORMAT parquet)""")
    tmp.replace(out)
    meta = {
        "years": [years[0], years[-1]] if years else None,
        "issued": {"day": str(issued["day"]), "month": f"{y}-{m:02d}", "year": issued["year"]},
        "labels": {step: {str(k): v for k, v in lab.items()} for step, lab in LABELS.items()},
    }
    meta_path().write_text(json.dumps(meta), encoding="utf-8")
    log.info("outlook issued %s", meta["issued"])
    return meta
