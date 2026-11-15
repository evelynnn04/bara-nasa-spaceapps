"""Evaluation of the monthly fire activity forecast on held-out years.

Run `python -m app validate-forecast` after the cache is built and `python -m app indices` has
fetched the ONI table. It reproduces the evaluation tables of `docs/forecast.md`.

Rolling origin: for every test year from `FIRST_TEST_YEAR` to the last complete year, every model
is fitted on the complete years before it only (normals, coefficients, residuals and the
`elevated` thresholds included) and then forecasts each month of the test year at leads 1 to 6
from the issue month the lead implies. Nothing from the test year or later enters a forecast,
and the ONI used is the season ending the month before the issue month, as it was published.

Models compared:

- `normal`: the area's normal for the calendar month (climatology);
- `last year`: the same month a year earlier (no interval or probability);
- `anomaly`: normal plus the current anomaly;
- `anomaly + ONI 1-2`: the model in use, the ONI at leads 1 and 2 only;
- `anomaly + ONI all`: the ONI at every lead.

Scores per group of areas and lead: MAE and RMSE in fire cell-days per month, MAE skill against
the normal, coverage of the 80 % interval, Brier skill of the probability of an `elevated` month
against the constant probability 0.2, and precision and recall when that probability is at least
0.5 or 0.3.
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field
from statistics import mean

from . import forecast as fc
from . import store
from .harmonise import weights

log = logging.getLogger("app.forecast_validation")

FIRST_TEST_YEAR = 2008
EVAL_LEADS = (1, 2, 3, 4, 5, 6)
DRY_SEASON = (7, 8, 9, 10, 11)
REFERENCE_P = round(1 - fc.ELEVATED, 2)
MODELS = {
    "normal": {"anomaly_term": False, "oni_leads": ()},
    "last year": None,
    "anomaly": {"anomaly_term": True, "oni_leads": ()},
    "anomaly + ONI 1-2": {"anomaly_term": True, "oni_leads": fc.ONI_LEADS},
    "anomaly + ONI all": {"anomaly_term": True, "oni_leads": EVAL_LEADS},
}


@dataclass
class Scores:
    """Forecast and outcome pairs of one model, group and lead."""

    pairs: list[tuple] = field(default_factory=list)

    def add(self, truth: float, median: float, low: float | None, high: float | None,
            p: float | None, event: bool | None) -> None:
        self.pairs.append((truth, median, low, high, p, event))

    def summary(self, reference_mae: float | None = None) -> dict:
        if not self.pairs:
            return {}
        err = [t - m for t, m, *_ in self.pairs]
        mae = mean(abs(e) for e in err)
        out = {"n": len(err), "mae": mae, "rmse": math.sqrt(mean(e * e for e in err)),
               "skill": None if not reference_mae else 1 - mae / reference_mae}
        cov = [lo <= t <= hi for t, _, lo, hi, *_ in self.pairs if lo is not None]
        out["coverage"] = mean(cov) if cov else None
        prob = [(p, e) for *_, p, e in self.pairs if p is not None and e is not None]
        if prob:
            brier = mean((p - e) ** 2 for p, e in prob)
            ref = mean((REFERENCE_P - e) ** 2 for _, e in prob)
            out["brier_skill"] = 1 - brier / ref if ref else None
            for cut in (0.5, 0.3):
                hit = sum(1 for p, e in prob if p >= cut and e)
                said = sum(1 for p, _ in prob if p >= cut)
                happened = sum(1 for _, e in prob if e)
                out[f"precision_{cut}"] = hit / said if said else None
                out[f"recall_{cut}"] = hit / happened if happened else None
        return out


def groups(level: str, mean_annual: float) -> list[str]:
    """Report groups an area belongs to."""
    out = []
    if level == "country":
        out.append("country")
    elif level == "province":
        out.append("provinces")
    elif level == "regency":
        for lo, hi in ((2, 20), (20, 200), (200, math.inf)):
            if lo <= mean_annual < hi:
                out.append(f"regencies {lo}-{hi:g}/yr" if hi != math.inf else f"regencies {lo}+/yr")
    return out


def evaluate(regions: dict, oni: dict) -> dict:
    """{(group, model, lead, season): Scores} over every test year."""
    z_all = {rid: (level, fc.log_series(totals), totals) for rid, (level, totals) in regions.items()}
    last_year = max(y for _, z, _ in z_all.values() for y in fc.complete_years(z))
    out: dict = {}
    for ty in range(FIRST_TEST_YEAR, last_year + 1):
        train = list(range(fc.config.AQUA_START.year + 1, ty))
        fits = {name: fc.fit(fc.fit_areas(regions, train), oni, train, EVAL_LEADS, **kw)
                for name, kw in MODELS.items() if kw is not None}
        log.info("test year %d: fitted on %d-%d", ty, train[0], train[-1])
        for rid, (level, z, totals) in z_all.items():
            n = fc.normal(z, train)
            if n is None:
                continue
            annual = sum(totals.get((y, c), 0.0) for y in train for c in range(1, 13)) / len(train)
            names = groups(level, annual)
            if not names:
                continue
            for c in range(1, 13):
                target = (ty, c)
                if target not in z:
                    continue
                truth = totals[target]
                th = fc.elevated_threshold(n, c)
                event = None if th is None else z[target] > th
                for lead in EVAL_LEADS:
                    issue = fc.shift(target, -lead)
                    rows = {}
                    for name, f in fits.items():
                        p = fc.predict(f, n, z, oni, issue, lead)
                        if p is not None:
                            rows[name] = (p["median"], p["low"], p["high"], p["p_elevated"])
                    prev = fc.shift(target, -12)
                    if prev in totals:
                        rows["last year"] = (totals[prev], None, None, None)
                    if len(rows) < len(MODELS):
                        continue
                    for g in names:
                        for season in ("all", "dry") if c in DRY_SEASON else ("all",):
                            for name, (m, lo, hi, p) in rows.items():
                                out.setdefault((g, name, lead, season), Scores()).add(truth, m, lo, hi, p, event)
    return out


def _fmt(v: float | None, pct: bool = False) -> str:
    if v is None:
        return "-"
    return f"{100 * v:+.0f}%" if pct else f"{v:.2f}"


def report(results: dict) -> None:
    """Prints the evaluation tables."""
    order = ["country", "provinces", "regencies 200+/yr", "regencies 20-200/yr", "regencies 2-20/yr"]
    for season, label in (("all", "all months"), ("dry", "July to November targets")):
        print(f"\n=== {label} ===")
        for g in order:
            print(f"\n{g}")
            print(f"  {'model':20} {'lead':>4} {'n':>6} {'MAE':>9} {'RMSE':>9} {'skill':>6} {'cover80':>7} "
                  f"{'Brier sk':>8} {'P/R p>=0.5':>11} {'P/R p>=0.3':>11}")
            for lead in EVAL_LEADS:
                ref = results.get((g, "normal", lead, season))
                ref_mae = ref.summary()["mae"] if ref and ref.pairs else None
                for name in MODELS:
                    s = results.get((g, name, lead, season))
                    if not s or not s.pairs:
                        continue
                    r = s.summary(ref_mae)
                    pr = lambda c: (f"{_fmt(r.get(f'precision_{c}'))}/{_fmt(r.get(f'recall_{c}'))}"
                                    if f"precision_{c}" in r else "-")
                    print(f"  {name:20} {lead:4} {r['n']:6} {r['mae']:9.1f} {r['rmse']:9.1f} "
                          f"{_fmt(r['skill'], True):>6} {_fmt(r['coverage']):>7} {_fmt(r.get('brier_skill')):>8} "
                          f"{pr(0.5):>11} {pr(0.3):>11}")


def run() -> None:
    """Loads every area's monthly record and prints the evaluation."""
    con = store.connect(weights.load_params())
    if not store.has(con, "days", "region_daily"):
        raise SystemExit("The derived tables are missing. Run `python -m app all` first.")
    oni = fc.load_oni()
    if not oni:
        raise SystemExit("The ONI table is missing. Run `python -m app indices` first.")
    report(evaluate(fc.region_monthly(con, "all"), oni))
