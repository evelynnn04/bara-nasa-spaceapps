"""Monthly fire activity forecast for an area, one to three months ahead (see `docs/forecast.md`).

**Target.** The harmonised fire activity of an area in a calendar month (MODIS-equivalent fire
cell-days), forecast on the log scale `z = ln(1 + activity)` because monthly activity spans four
orders of magnitude.

**Predictors**, all known at the end of the issue month t:

- the area's **normal** for the target calendar month: the mean of z over the complete years used;
- the area's **current anomaly**: z in month t minus its normal for that calendar month;
- the **Oceanic Nino Index** of the three-month season ending in month t - 1 (NOAA CPC publishes
  a season early in the following month), for leads up to `ONI_LEADS` only. El Nino brings drought
  and severe fire to Indonesia; from lead 3 the index did not improve the forecast.

**Model.** For each lead h and target calendar month, `z(t + h) = normal + b0 + b1 * anomaly
(+ b2 * ONI)`, fitted by least squares over the provinces and cities/regencies with at least
`FIT_MIN_ANNUAL` fire cell-days a year. The coefficients are shared by every area, so any area or
drawn polygon can be forecast from its own normal and anomaly.

**Uncertainty.** Residuals divided by each area's spread of z in the target calendar month give
the interval (`INTERVAL` quantiles, scaled back by the area's spread) and the probability that
the month reaches the anomaly module's `elevated` label against all earlier years.

Evaluated by `python -m app validate-forecast` on held-out years.
"""

from __future__ import annotations

import bisect
import datetime as dt
import math
from dataclasses import dataclass, field
from statistics import mean, stdev

import duckdb

from . import anomaly, config

#: Leads, in months after the issue month, that are forecast.
LEADS = (1, 2, 3)
#: Leads that use the Oceanic Nino Index.
ONI_LEADS = (1, 2)
#: Quantiles of the forecast interval.
INTERVAL = (0.1, 0.9)
#: Areas used to fit the shared coefficients: at least this many fire cell-days a year.
FIT_MIN_ANNUAL = 2.0
#: Lowest spread of z used to scale residuals, so areas with constant history keep an interval.
MIN_SPREAD = 0.05
#: Fewest complete years needed for a normal.
MIN_YEARS = 3
#: Anomaly score from which a month is `elevated` (the anomaly module's lowest alert label).
ELEVATED = dict(anomaly.THRESHOLDS)["elevated"]
#: Mean annual activity (fire cell-days) from which a forecast is of moderate, then high confidence.
#: Below the first, the probability of an elevated month scored worse than a constant guess on
#: held-out years, so it is not given.
CONFIDENCE_FROM = {"moderate": 20.0, "high": 200.0}
#: Probability of an elevated month from which the outlook says `elevated possible`, then `elevated likely`.
OUTLOOK_FROM = {"elevated possible": 0.3, "elevated likely": 0.5}
ONI_SEASONS = ("DJF", "JFM", "FMA", "MAM", "AMJ", "MJJ", "JJA", "JAS", "ASO", "SON", "OND", "NDJ")

LIMITATIONS = (
    "Forecasts come from the area's own fire history and, one and two months ahead, the El Nino state; "
    "weather, land use and fire suppression are not modelled.",
    "Skill fades with lead time and is lowest for areas with little fire; check the confidence and interval.",
    "Satellites miss fires under cloud and smoke, so actual burning can exceed the counts forecast.",
    "Coefficients are fitted on 2003 to the last complete year; a fire regime unlike that period is not foreseen.",
)

Month = tuple[int, int]


def oni_path():
    """Local copy of the NOAA CPC Oceanic Nino Index table."""
    return config.raw_dir() / "indices" / "oni.ascii.txt"


def read_oni(text: str) -> dict[Month, float]:
    """ONI anomalies keyed by the last month of each three-month season (DJF 2015 -> (2015, 2))."""
    out = {}
    for line in text.splitlines()[1:]:
        parts = line.split()
        if len(parts) != 4 or parts[0] not in ONI_SEASONS:
            continue
        end = ONI_SEASONS.index(parts[0]) + 2
        out[(int(parts[1]) + (end > 12), (end - 1) % 12 + 1)] = float(parts[3])
    return out


def load_oni() -> dict[Month, float]:
    """The local ONI table, or an empty one when it has not been downloaded."""
    path = oni_path()
    return read_oni(path.read_text(encoding="utf-8")) if path.is_file() else {}


def shift(m: Month, k: int) -> Month:
    """The month k months after m."""
    i = m[0] * 12 + m[1] - 1 + k
    return i // 12, i % 12 + 1


def monthly(days: list[dt.date], values: list[float | None]) -> dict[Month, float]:
    """Totals of every complete month of a daily record (unobserved days count as no fire)."""
    out: dict[Month, float] = {}
    for d, v in zip(days, values):
        out[(d.year, d.month)] = out.get((d.year, d.month), 0.0) + (v or 0.0)
    if days and (days[-1] + dt.timedelta(days=1)).month == days[-1].month:
        out.pop((days[-1].year, days[-1].month), None)
    if days and days[0].day != 1:
        out.pop((days[0].year, days[0].month), None)
    return out


@dataclass
class Normal:
    """Mean and spread of z per calendar month over complete years, and the yearly values."""

    mean: dict[int, float]
    spread: dict[int, float]
    values: dict[int, list[float]]
    years: list[int]

    def anomaly(self, z: dict[Month, float], m: Month) -> float | None:
        return z[m] - self.mean[m[1]] if m in z else None


def normal(z: dict[Month, float], years: list[int]) -> Normal | None:
    """The normal of an area over the given complete years, or None with fewer than `MIN_YEARS`."""
    if len(years) < MIN_YEARS:
        return None
    vals = {c: [z.get((y, c), 0.0) for y in years] for c in range(1, 13)}
    return Normal({c: mean(v) for c, v in vals.items()},
                  {c: max(stdev(v), MIN_SPREAD) for c, v in vals.items()}, vals, years)


def predictors(n: Normal, z: dict[Month, float], oni: dict[Month, float], t: Month, lead: int,
               f: "Fit") -> list[float] | None:
    """[1, (anomaly), (ONI)] for an issue month as the fit `f` uses them, or None when one is not
    known."""
    row = [1.0]
    if f.anomaly:
        a = n.anomaly(z, t)
        if a is None:
            return None
        row.append(a)
    if lead in f.oni_leads:
        x = oni.get(shift(t, -1))
        if x is None:
            return None
        row.append(x)
    return row


def _solve(a: list[list[float]], b: list[float]) -> list[float]:
    """Solves a small linear system by Gaussian elimination with partial pivoting."""
    k = len(b)
    m = [row[:] + [b[i]] for i, row in enumerate(a)]
    for c in range(k):
        p = max(range(c, k), key=lambda r: abs(m[r][c]))
        m[c], m[p] = m[p], m[c]
        if abs(m[c][c]) < 1e-12:
            return [0.0] * k
        for r in range(k):
            if r != c:
                f = m[r][c] / m[c][c]
                m[r] = [x - f * y for x, y in zip(m[r], m[c])]
    return [m[i][k] / m[i][i] for i in range(k)]


def least_squares(rows: list[list[float]], ys: list[float]) -> list[float]:
    """Ordinary least squares coefficients."""
    k = len(rows[0])
    xtx = [[sum(r[i] * r[j] for r in rows) for j in range(k)] for i in range(k)]
    xty = [sum(r[i] * y for r, y in zip(rows, ys)) for i in range(k)]
    return _solve(xtx, xty)


@dataclass
class Fit:
    """Shared coefficients and sorted standardised residuals per (lead, target calendar month).

    `anomaly` says whether the current anomaly is a predictor, `oni_leads` at which leads the ONI
    is (none when the index is not available)."""

    anomaly: bool = True
    oni_leads: tuple[int, ...] = ONI_LEADS
    years: list[int] = field(default_factory=list)
    coef: dict[tuple[int, int], list[float]] = field(default_factory=dict)
    residuals: dict[tuple[int, int], list[float]] = field(default_factory=dict)


def fit(areas: list[dict[Month, float]], oni: dict[Month, float], years: list[int],
        leads: tuple[int, ...] = LEADS, anomaly_term: bool = True, oni_leads: tuple[int, ...] = ONI_LEADS) -> Fit:
    """Fits the shared coefficients on the monthly z of the given areas over complete `years`.

    Only targets inside `years` are used, so a fit on earlier years can be scored on later ones.
    Without an ONI table the index is left out at every lead."""
    last = (years[-1], 12)
    first = (years[0], 1)
    data = [(z, n) for z in areas if (n := normal(z, years)) is not None]
    out = Fit(anomaly_term, oni_leads if oni else (), years)
    for lead in leads:
        for c in range(1, 13):
            rows, ys, spreads = [], [], []
            for z, n in data:
                for y in years:
                    target = (y, c)
                    t = shift(target, -lead)
                    if target < first or target > last or target not in z:
                        continue
                    x = predictors(n, z, oni, t, lead, out)
                    if x is None:
                        continue
                    rows.append(x)
                    ys.append(z[target] - n.mean[c])
                    spreads.append(n.spread[c])
            if not rows:
                continue
            b = least_squares(rows, ys)
            out.coef[(lead, c)] = b
            out.residuals[(lead, c)] = sorted((y - sum(p * q for p, q in zip(r, b))) / s
                                              for r, y, s in zip(rows, ys, spreads))
    return out


def log_series(totals: dict[Month, float]) -> dict[Month, float]:
    return {m: math.log1p(max(v, 0.0)) for m, v in totals.items()}


def complete_years(z: dict[Month, float], first_year: int = config.AQUA_START.year + 1) -> list[int]:
    """Years from `first_year` with all twelve months in the record."""
    return sorted(y for y in {m[0] for m in z} if y >= first_year and all((y, c) in z for c in range(1, 13)))


def elevated_threshold(n: Normal, c: int) -> float | None:
    """Lowest z above which a month of calendar month c scores `elevated` against the normal's years,
    or None when the years are too few to reach that label."""
    ref = sorted(n.values[c], reverse=True)
    if len(ref) < anomaly.MIN_REFERENCE:
        return None
    k = math.floor((1 - ELEVATED) * (len(ref) + 1) - 1 + 1e-9)
    return ref[k] if k >= 0 else None


def predict(f: Fit, n: Normal, z: dict[Month, float], oni: dict[Month, float], t: Month, lead: int) -> dict | None:
    """Forecast of month t + lead issued at the end of month t, or None without coefficients."""
    target = shift(t, lead)
    c = target[1]
    b = f.coef.get((lead, c))
    x = predictors(n, z, oni, t, lead, f)
    if b is None or x is None or len(x) != len(b):
        return None
    zh = n.mean[c] + sum(p * q for p, q in zip(x, b))
    res = f.residuals[(lead, c)]
    s = n.spread[c]
    lo, hi = zh + anomaly.quantile(res, INTERVAL[0]) * s, zh + anomaly.quantile(res, INTERVAL[1]) * s
    th = elevated_threshold(n, c)
    p = None
    if th is not None:
        p = 1 - bisect.bisect_right(res, (th - zh) / s) / len(res)
    return {"month": f"{target[0]}-{target[1]:02d}", "lead": lead, "z": zh,
            "median": math.expm1(zh), "low": max(math.expm1(lo), 0.0), "high": max(math.expm1(hi), 0.0),
            "normal": math.expm1(n.mean[c]), "elevated_from": None if th is None else math.expm1(th),
            "p_elevated": p, "uses_oni": lead in f.oni_leads}


def outlook(p: float | None) -> str | None:
    """`near or below normal`, `elevated possible` or `elevated likely` from the probability of an
    elevated month, or None without one."""
    if p is None:
        return None
    label = "near or below normal"
    for name, start in OUTLOOK_FROM.items():
        if p >= start:
            label = name
    return label


def confidence(mean_annual: float) -> str:
    """`low`, `moderate` or `high`, from an area's mean annual activity."""
    level = "low"
    for name, start in CONFIDENCE_FROM.items():
        if mean_annual >= start:
            level = name
    return level


def region_monthly(con: duckdb.DuckDBPyConnection, daynight: str) -> dict[str, tuple[str, dict[Month, float]]]:
    """{region id: (level, {month: total})} for every named area of the region cache, over the
    harmonised record (complete months only)."""
    start, last = con.execute(f"SELECT min(local_date), max(local_date) FROM days "
                              f"WHERE local_date >= DATE '{config.AQUA_START}'").fetchone()
    rows = con.execute(f"""
        SELECT r.region_id, any_value(r.level), year(r.local_date), month(r.local_date),
               sum(CASE WHEN r.local_date < DATE '{config.SPLICE}' THEN r.aqua_cd ELSE r.viirs_w END)
        FROM region_daily r JOIN days d USING (local_date)
        WHERE r.daynight = '{daynight}' AND d.record_platform IS NOT NULL
          AND r.local_date >= DATE '{config.AQUA_START}'
        GROUP BY r.region_id, year(r.local_date), month(r.local_date)
    """).fetchall()
    levels = dict(con.execute(f"SELECT DISTINCT region_id, level FROM region_daily "
                              f"WHERE daynight = '{daynight}'").fetchall())
    first = (start.year, start.month) if start.day == 1 else shift((start.year, start.month), 1)
    end = (last.year, last.month) if (last + dt.timedelta(days=1)).month != last.month else shift((last.year, last.month), -1)
    months = []
    m = first
    while m <= end:
        months.append(m)
        m = shift(m, 1)
    out = {rid: (level, {mm: 0.0 for mm in months}) for rid, level in levels.items()}
    for rid, _, y, mo, v in rows:
        if (y, mo) in out[rid][1]:
            out[rid][1][(y, mo)] = float(v or 0.0)
    return out


def fit_areas(regions: dict[str, tuple[str, dict[Month, float]]], years: list[int]) -> list[dict[Month, float]]:
    """Log monthly series of the provinces and cities/regencies active enough to fit on."""
    out = []
    for level, totals in regions.values():
        if level not in ("province", "regency"):
            continue
        annual = sum(totals.get((y, c), 0.0) for y in years for c in range(1, 13)) / len(years)
        if annual >= FIT_MIN_ANNUAL:
            out.append(log_series(totals))
    return out


def forecast(days: list[dt.date], values: list[float | None], f: Fit, oni: dict[Month, float]) -> dict:
    """The forecast of an area from its daily record, issued at the end of its last complete month."""
    totals = monthly(days, values)
    z = log_series(totals)
    years = complete_years(z)
    n = normal(z, years)
    issue = max(totals) if totals else None
    annual = sum(totals[(y, c)] for y in years for c in range(1, 13)) / len(years) if years else 0.0
    out = {
        "method": {"target": "monthly fire activity (MODIS-equivalent fire cell-days)", "leads": list(LEADS),
                   "oni_leads": list(f.oni_leads), "interval": list(INTERVAL), "elevated_score": ELEVATED,
                   "fit_years": [f.years[0], f.years[-1]] if f.years else None},
        "issued_after": None if issue is None else f"{issue[0]}-{issue[1]:02d}",
        "predictors": ["normal"] + (["current_anomaly"] if f.anomaly else []) + (["oni"] if f.oni_leads else []),
        "oni": None,
        "normal_years": [years[0], years[-1]] if years else None,
        "activity": {"mean_annual": round(annual, 3), "confidence": confidence(annual)},
        "forecasts": [],
        "recent": [],
        "limitations": list(LIMITATIONS),
    }
    if n is None or issue is None:
        out["limitations"].insert(0, "Too few complete years to forecast this area.")
        return out
    if f.oni_leads:
        x = oni.get(shift(issue, -1))
        centre = shift(issue, -2)
        out["oni"] = None if x is None else {"season": f"{ONI_SEASONS[centre[1] - 1]} {centre[0]}", "anomaly": x}
    low = out["activity"]["confidence"] == "low"
    if low:
        out["limitations"].insert(0, "This area has little fire, so no probability of an elevated month is given "
                                     "and the range is wide.")
    for lead in LEADS:
        p = predict(f, n, z, oni, issue, lead)
        if p is None:
            continue
        p.pop("z")
        if low:
            p["p_elevated"] = None
        p["outlook"] = outlook(p["p_elevated"])
        out["forecasts"].append({k: (round(v, 3) if isinstance(v, float) else v) for k, v in p.items()})
    for k in range(11, -1, -1):
        m = shift(issue, -k)
        if m in totals:
            out["recent"].append({"month": f"{m[0]}-{m[1]:02d}", "activity": round(totals[m], 3),
                                  "normal": round(math.expm1(n.mean[m[1]]), 3)})
    return out
