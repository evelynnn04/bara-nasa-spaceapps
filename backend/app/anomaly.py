"""Fire activity anomalies: how unusual a month's fire activity is in an area, compared with the
same calendar month in other years of the harmonised record.

The method (see `docs/anomaly.md`):

1. **Record.** The harmonised MODIS-VIIRS record: Aqua MODIS from 4 July 2002, the day's VIIRS
   reference satellite from 1 February 2012. Two indicators, both MODIS-equivalent:
   - **activity**, in hotspots (`weights.weight_sql`): an Aqua hotspot counts 1, a VIIRS hotspot
     `1 / k_d[island group, month]` for its half of the day `d`;
   - **FRP**, summed fire radiative power in MW (`weights.frp_sql`): Aqua FRP as it is, VIIRS FRP
     of each half divided by `kf_d[island group, month]`.
   Hotspots follow the hotspot type setting as everywhere else (`vegetation`: presumed vegetation
   fires, static thermal sources removed; `all`: every hotspot). A day the record's satellite did
   not observe Indonesia is missing, never zero.
2. **Units.** A selected area (summed over its own 0.05° cells), or on request 0.25° grid cells
   (`gx = floor(lon / 0.25)`, `gy = floor(lat / 0.25)`).
3. **Baseline.** The month is summed over days 1 to D, where D is the month's length, or the last
   data day for the unfinished current month. Every other year (or, with `reference=prior`, every
   earlier year) contributes the same days of the same calendar month when its satellite observed at
   least `MIN_COVERAGE` of them.
4. **Score.** For observation x and the n reference values X_j of one indicator,
   `p_upper = (1 + #{X_j >= x}) / (n + 1)` and `A = 1 - p_upper`, per indicator.
5. **Label.** `A` below 0.80 is normal, from 0.80 elevated, from 0.90 anomalous, from 0.97 extreme.
   The highest attainable score is n / (n + 1), so with too few reference years some labels cannot
   be reached; the response says which, and a score at that ceiling is a lower bound. Below
   `MIN_REFERENCE` years no label is given at all. A unit whose reference median is zero is flagged
   `sparse_history`, and an alert there carries a `disclaimer`.

The thresholds are provisional and uncalibrated; `evaluate` measures how often each label fires
when every year is held out in turn.
"""

from __future__ import annotations

import calendar
import datetime as dt
import math
from collections import defaultdict
from dataclasses import dataclass, field

import duckdb

from . import config
from .harmonise import weights

#: Side of an anomaly grid cell, in degrees, and in 0.05° cells.
GRID_DEG = 0.25
GRID_CELLS = round(GRID_DEG / config.GRID)

#: A reference year counts only when its satellite observed at least this share of the window days.
MIN_COVERAGE = 0.9

#: Lower score bound of each label, highest first. Adapted from the 80th, 90th and 97th percentile
#: classes of the Severe Fire Danger Index; not validated for fire activity or FRP.
THRESHOLDS = (("extreme", 0.97), ("anomalous", 0.90), ("elevated", 0.80))
LABELS = ("normal", "elevated", "anomalous", "extreme")
RANK = {name: i for i, name in enumerate(LABELS)}
INSUFFICIENT = "insufficient_baseline"

#: Fewest reference values with which the lowest alert label (0.80) can be reached: n / (n + 1) >= 0.80.
MIN_REFERENCE = 4

#: Indicator names, in the order of the value tuples.
INDICATORS = ("activity", "frp")

PRODUCT = ("Harmonised MODIS-VIIRS record: Aqua MODIS from 4 July 2002, the VIIRS reference satellite "
           "(S-NPP, else NOAA-20, else NOAA-21) from 1 February 2012, in MODIS-equivalent units")
GRANULARITY = "calendar_month"
CALIBRATION = "uncalibrated"
SCREENING = {
    "vegetation": ("Presumed vegetation fires only (FIRMS type 0); untyped near-real-time hotspots on the "
                   "static-source mask (volcanoes, gas flares, industry) removed."),
    "all": "Every hotspot type, including volcanoes, gas flares and other static sources.",
}


class MissingFactors(RuntimeError):
    """The parameters hold no FRP factors (`python -m app fit` predates them)."""


def grid_of(cx: int, cy: int) -> tuple[int, int]:
    """0.25° grid indices of a 0.05° cell."""
    return cx // GRID_CELLS, cy // GRID_CELLS


def grid_id(gx: int, gy: int) -> str:
    """Stable id of a grid cell, for example `g404_2` (its indices on the 0.25° grid)."""
    return f"g{gx}_{gy}"


def grid_bounds(gx: int, gy: int) -> tuple[float, float, float, float]:
    """[west, south, east, north] of a grid cell."""
    return gx * GRID_DEG, gy * GRID_DEG, (gx + 1) * GRID_DEG, (gy + 1) * GRID_DEG


def grid_sql(c: str = "c") -> tuple[str, str]:
    """SQL for the grid indices of a 0.05° cell relation `c`."""
    return (f"CAST(floor({c}.cx / {GRID_CELLS}.0) AS INTEGER)",
            f"CAST(floor({c}.cy / {GRID_CELLS}.0) AS INTEGER)")


# --- scoring ---------------------------------------------------------------------------------------


def upper_tail_score(x: float, reference: list[float]) -> float:
    """`A = 1 - (1 + #{X_j >= x}) / (n + 1)`: the share of the n + 1 slots below x. 0 for x = 0."""
    n = len(reference)
    at_least = sum(1 for v in reference if v >= x)
    return 1.0 - (1 + at_least) / (n + 1)


def max_score(n: int) -> float:
    """Highest score attainable with n reference values (x above all of them)."""
    return n / (n + 1)


def label_of(score: float) -> str:
    """Label of a score (assumes the baseline is large enough to label at all)."""
    for name, lower in THRESHOLDS:
        if score >= lower - 1e-9:
            return name
    return "normal"


def reachable_labels(n: int) -> list[str]:
    """Labels a score can reach with n reference values."""
    return ["normal"] + [name for name, lower in reversed(THRESHOLDS) if max_score(n) >= lower - 1e-9]


def quantile(sorted_values: list[float], q: float) -> float | None:
    """Linearly interpolated quantile of sorted values."""
    if not sorted_values:
        return None
    pos = (len(sorted_values) - 1) * q
    lo = math.floor(pos)
    hi = min(lo + 1, len(sorted_values) - 1)
    return sorted_values[lo] + (sorted_values[hi] - sorted_values[lo]) * (pos - lo)


def summary(values: list[float]) -> dict:
    """Descriptive statistics of a reference sample."""
    s = sorted(values)
    n = len(s)
    if not n:
        return {"n": 0, "mean": None, "median": None, "sd": None, "p80": None, "p90": None, "p97": None,
                "max": None, "zero_share": None}
    mean = sum(s) / n
    sd = math.sqrt(sum((v - mean) ** 2 for v in s) / (n - 1)) if n > 1 else None
    return {"n": n, "mean": mean, "median": quantile(s, 0.5), "sd": sd, "p80": quantile(s, 0.8),
            "p90": quantile(s, 0.9), "p97": quantile(s, 0.97), "max": s[-1],
            "zero_share": sum(1 for v in s if v == 0) / n}


def assess(x: float, reference: list[float]) -> dict:
    """Score and label of one indicator.

    `at_ceiling` is true when x exceeds every reference value but the label is capped by the
    sample size: the true class may be higher. With fewer than `MIN_REFERENCE` values the label is
    `insufficient_baseline`."""
    n = len(reference)
    if n < MIN_REFERENCE:
        return {"score": None, "label": INSUFFICIENT, "at_ceiling": False}
    score = upper_tail_score(x, reference)
    ceiling = max_score(n)
    capped = x > 0 and score >= ceiling - 1e-9 and ceiling < THRESHOLDS[0][1]
    return {"score": score, "label": label_of(score), "at_ceiling": capped}


def combine(activity: dict, frp: dict) -> tuple[str, str]:
    """Headline label (the higher of the two) and the indicator that sets it (`both` on a tie)."""
    if activity["label"] == INSUFFICIENT:
        return INSUFFICIENT, "both"
    ra, rf = RANK[activity["label"]], RANK[frp["label"]]
    if ra != rf:
        return (activity["label"], "activity") if ra > rf else (frp["label"], "frp")
    if activity["score"] == frp["score"]:
        return activity["label"], "both"
    return activity["label"], "activity" if activity["score"] > frp["score"] else "frp"


# --- windows and reference years ------------------------------------------------------------------


@dataclass
class Window:
    """The days of one calendar month compared in one year."""

    year: int
    start: dt.date
    end: dt.date
    observed: int
    platforms: dict[str, int] = field(default_factory=dict)

    @property
    def days(self) -> int:
        return (self.end - self.start).days + 1

    @property
    def coverage(self) -> float:
        return self.observed / self.days


@dataclass
class Baseline:
    """The target window, its reference windows and the years left out (with the reason)."""

    target: Window
    provisional: bool
    reference: list[Window]
    excluded: list[dict]

    @property
    def years(self) -> list[int]:
        return [w.year for w in self.reference]

    @property
    def windows(self) -> list[Window]:
        return [self.target, *self.reference]


def window(platform_of: dict[dt.date, str | None], year: int, month: int, last_dom: int) -> Window:
    """Days 1 to `last_dom` (clipped to the month) of a month and how many of them were observed."""
    start = dt.date(year, month, 1)
    end = dt.date(year, month, min(last_dom, calendar.monthrange(year, month)[1]))
    platforms: dict[str, int] = defaultdict(int)
    observed = 0
    d = start
    while d <= end:
        p = platform_of.get(d)
        if p is not None:
            observed += 1
            platforms[p] += 1
        d += dt.timedelta(days=1)
    return Window(year, start, end, observed, dict(platforms))


def baseline(flags: list[tuple], year: int, month: int, reference: str = "other") -> Baseline:
    """Target and reference windows of a month, from the day flags of `queries.day_flags`.

    Raises ValueError when the month lies outside the harmonised record."""
    platform_of = {d: p for d, p, _ in flags}
    start = max(config.AQUA_START, flags[0][0])
    first = dt.date(start.year, start.month, 1)
    last = flags[-1][0]
    if dt.date(year, month, 1) < first or dt.date(year, month, 1) > last:
        raise ValueError(f"{year}-{month:02d} is outside the harmonised record ({first:%Y-%m} to {last:%Y-%m})")
    month_end = dt.date(year, month, calendar.monthrange(year, month)[1])
    provisional = month_end > last
    last_dom = last.day if provisional else month_end.day
    target = window(platform_of, year, month, last_dom)
    ref, excluded = [], []
    for y in range(first.year, last.year + 1):
        if y == year or (reference == "prior" and y > year) or dt.date(y, month, 1) < first:
            continue
        w = window(platform_of, y, month, last_dom)
        if w.end > last:
            continue
        if w.coverage < MIN_COVERAGE:
            excluded.append({"year": y, "reason": "low_coverage", "observed_days": w.observed, "window_days": w.days})
            continue
        ref.append(w)
    return Baseline(target, provisional, ref, excluded)


def year_baselines(flags: list[tuple], year: int, reference: str = "other") -> list[tuple[int, Baseline]]:
    """(month, baseline) for every month of a year inside the record, in calendar order.

    Raises ValueError when no month of the year lies inside the record."""
    out = []
    for month in range(1, 13):
        try:
            out.append((month, baseline(flags, year, month, reference)))
        except ValueError:
            continue
    if not out:
        raise ValueError(f"{year} is outside the harmonised record ({flags[0][0]:%Y} to {flags[-1][0]:%Y})")
    return out


def month_totals(con: duckdb.DuckDBPyConnection, baselines: list[tuple[int, Baseline]], where: str = "TRUE",
                 daynight: str = "all", hotspots: str = "vegetation") -> dict[int, dict[int, tuple[float, float]]]:
    """{month: {year: (activity, frp)}} for the days 1 to D of each baseline's month, in every year,
    in one query. Years a baseline does not use are returned too and left out by `record`."""
    days = " OR ".join(f"(month(c.local_date) = {m} AND day(c.local_date) <= {b.target.end.day})"
                       for m, b in baselines)
    return totals(con, None, f"({days}) AND ({where})", "month(c.local_date)", daynight, hotspots)


def _window_filter(windows: list[Window]) -> str:
    return " OR ".join(f"c.local_date BETWEEN DATE '{w.start}' AND DATE '{w.end}'" for w in windows)


# --- queries ---------------------------------------------------------------------------------------


def totals(con: duckdb.DuckDBPyConnection, windows: list[Window] | None, where: str = "TRUE",
           group: str | None = None, daynight: str = "all", hotspots: str = "vegetation") -> dict:
    """{unit: {year: (activity, frp)}} over the given windows of the harmonised record (every day
    `where` allows when `windows` is None).

    `where` filters observation rows (aliases `c`, `d`, `k`); `group` is an expression over the
    record relation `c` naming the unit (one unit, key None, without it). With a day or night
    filter, both indicators count only that half of the day."""
    gsel = f"{group}" if group else "NULL"
    rows = con.execute(f"""
        SELECT {gsel} AS g, year(c.local_date) AS y, sum({weights.weight_sql(daynight, hotspots)}),
               sum({weights.frp_sql(daynight, hotspots)})
        FROM ({weights.record_sql(f"({_window_filter(windows) if windows else 'TRUE'}) AND ({where})", hotspots)}) c
        GROUP BY ALL
    """).fetchall()
    out: dict = defaultdict(dict)
    for g, y, activity, frp in rows:
        if frp is None:
            raise MissingFactors("The FRP factors are missing. Run `python -m app fit` first.")
        out[tuple(g) if isinstance(g, list) else g][y] = (float(activity), float(frp))
    return out


def area_grids(con: duckdb.DuckDBPyConnection, area_where: str, name: str = "agrid") -> None:
    """Creates temp tables `{name}_cells(cx, cy)`, the 0.05° cells of the area, and `{name}(gx, gy)`,
    the grid cells holding at least one of them.

    `area_where` is a filter over aliases `c` (cells) and `k` (cell lookup), as `queries.area_filter`
    writes it."""
    gx, gy = grid_sql()
    con.execute(f"""
        CREATE OR REPLACE TEMP TABLE {name}_cells AS
        SELECT c.cx, c.cy FROM cells c JOIN cells k ON k.cx = c.cx AND k.cy = c.cy WHERE {area_where}
    """)
    con.execute(f"CREATE OR REPLACE TEMP TABLE {name} AS SELECT DISTINCT {gx} AS gx, {gy} AS gy FROM {name}_cells c")


def grid_totals(con: duckdb.DuckDBPyConnection, b: Baseline, grids_table: str, daynight: str = "all",
                hotspots: str = "vegetation") -> dict:
    """{(gx, gy): {year: (activity, frp)}} for the grid cells in `grids_table(gx, gy)`."""
    gx, gy = grid_sql()
    return totals(con, b.windows, f"({gx}, {gy}) IN (SELECT gx, gy FROM {grids_table})", f"[{gx}, {gy}]",
                  daynight, hotspots)


def target_details(con: duckdb.DuckDBPyConnection, b: Baseline, grids_table: str, cells_table: str,
                   daynight: str = "all", hotspots: str = "vegetation") -> dict:
    """Per grid cell active in the target window: activity inside the selected area, the night share
    of its hotspots (of all hotspots, whatever the filter), highest hotspot FRP, active 0.05° cells
    and the main island group, province and city/regency."""
    gx, gy = grid_sql()
    w, n = weights.weight_sql(daynight, hotspots), weights.hotspots_sql("all", hotspots)
    night, frp_max = weights.hotspots_sql("night", hotspots), f"c.frp_max{weights.HOTSPOTS[hotspots]}"
    where = (f"c.local_date BETWEEN DATE '{b.target.start}' AND DATE '{b.target.end}' "
             f"AND ({gx}, {gy}) IN (SELECT gx, gy FROM {grids_table})")
    rows = con.execute(f"""
        SELECT {gx} AS gx, {gy} AS gy,
               sum({w}) FILTER (WHERE (c.cx, c.cy) IN (SELECT cx, cy FROM {cells_table})) AS in_area,
               sum({night}) / sum({n}) AS night_share, max({frp_max}) AS frp_max,
               count(DISTINCT (c.cx, c.cy)) AS cells,
               arg_max(c.island_group, {w}) AS island_group,
               arg_max(c.province_id, {w}) AS province_id,
               arg_max(c.regency_id, {w}) AS regency_id
        FROM ({weights.record_sql(where, hotspots)}) c
        GROUP BY ALL
    """).fetchall()
    return {(r[0], r[1]): {"in_area": float(r[2] or 0), "night_share": r[3], "frp_max": float(r[4] or 0),
                           "cells": int(r[5]), "island_group": r[6], "province_id": r[7], "regency_id": r[8]}
            for r in rows}


# --- records ---------------------------------------------------------------------------------------


def sparse_disclaimer(n: int, activity: float, unit: str = "hotspots") -> str:
    """Caution shown with an alert in a unit that usually has no fire in the month."""
    return (f"This place usually has no fire in this month (none in at least half of the {n} reference years). "
            f"Only {activity:.2f} {unit} already rank above most of those years, so the label reflects a few "
            "detections in a normally empty place, not a large fire.")


def record(values: dict[int, tuple[float, float]], b: Baseline, years: bool = False) -> dict:
    """The anomaly record of one unit (area or grid cell) from its yearly window totals.

    `disclaimer` is set when an alert comes from a unit whose reference median is zero. With
    `years`, `years` lists the window totals of the target and every reference year, oldest first,
    for charts."""
    zero = (0.0, 0.0)
    activity, frp = values.get(b.target.year, zero)
    ref = [values.get(y, zero) for y in b.years]
    ref_a, ref_f = [v[0] for v in ref], [v[1] for v in ref]
    a, f = assess(activity, ref_a), assess(frp, ref_f)
    label, dominant = combine(a, f)
    sparse = bool(ref_a) and quantile(sorted(ref_a), 0.5) == 0
    out = {
        "activity": round(activity, 3), "frp_mw": round(frp, 1),
        "activity_score": _r(a["score"]), "frp_score": _r(f["score"]),
        "activity_label": a["label"], "frp_label": f["label"],
        "activity_at_ceiling": a["at_ceiling"], "frp_at_ceiling": f["at_ceiling"],
        "label": label, "dominant_indicator": dominant,
        "sparse_history": sparse,
        "disclaimer": sparse_disclaimer(len(ref_a), activity) if sparse and RANK.get(label, 0) > 0 else None,
        "history": {"activity": _rounded(summary(ref_a)), "frp": _rounded(summary(ref_f))},
    }
    if years:
        out["years"] = [{"year": y, "activity": round(values.get(y, zero)[0], 3),
                         "frp_mw": round(values.get(y, zero)[1], 1), "target": y == b.target.year}
                        for y in sorted([b.target.year, *b.years])]
    return out


def _r(v: float | None, digits: int = 4) -> float | None:
    return None if v is None else round(v, digits)


def _rounded(d: dict) -> dict:
    return {k: (v if k == "n" else _r(v, 3)) for k, v in d.items()}


def data_quality(b: Baseline, hotspots: str = "vegetation") -> dict:
    """Observation completeness of the target window, shared by every record of a response."""
    t = b.target
    flags = []
    if b.provisional:
        flags.append("provisional_partial_month")
    if t.coverage < MIN_COVERAGE:
        flags.append("low_coverage")
    if len(b.reference) < MIN_REFERENCE:
        flags.append("insufficient_baseline")
    elif max_score(len(b.reference)) < THRESHOLDS[0][1]:
        flags.append("limited_resolution")
    return {"observed_days": t.observed, "window_days": t.days, "coverage": round(t.coverage, 3),
            "platform_days": t.platforms, "provisional": b.provisional, "flags": flags,
            "screening": SCREENING[hotspots],
            "coverage_note": "Coverage counts days the satellite observed Indonesia; cloud cover over a single place "
                             "is not known and can hide fires."}


# --- evaluation ------------------------------------------------------------------------------------

#: Units `evaluate` can score: (group expression over the record relation, observation filter).
EVAL_UNITS = {
    "province": ("c.province_id", "k.province_id IS NOT NULL"),
    "regency": ("c.regency_id", "k.regency_id IS NOT NULL"),
    "grid": ("[{}, {}]".format(*grid_sql()), "TRUE"),
}


def evaluate(con: duckdb.DuckDBPyConnection, flags: list[tuple], unit: str = "province",
             hotspots: str = "vegetation") -> dict:
    """Leave-one-year-out alert rates over complete months, for one kind of unit.

    Every complete calendar month of every year is scored against the same month of all other
    valid years, for every unit active in that calendar month in any valid year (so a quiet year of
    an active unit counts as a normal outcome). Returns, per indicator, the share of unit-months
    given each label, overall and among months with activity, the share at the sample-size ceiling,
    and the activity rates per calendar month. Under exchangeable years the share at or above a
    threshold t is at most 1 - t, less the discreteness of n / (n + 1) steps."""
    group, where = EVAL_UNITS[unit]
    last = flags[-1][0]
    counts = {i: defaultdict(int) for i in INDICATORS}
    active = {i: defaultdict(int) for i in INDICATORS}
    ceiling = {i: 0 for i in INDICATORS}
    total = 0
    by_month = {}
    for month in range(1, 13):
        month_end = dt.date(last.year, month, calendar.monthrange(last.year, month)[1])
        b = baseline(flags, last.year if month_end <= last else last.year - 1, month)
        windows = b.windows if b.target.coverage >= MIN_COVERAGE else b.reference
        years = [w.year for w in windows]
        units = totals(con, windows, where, group, hotspots=hotspots)
        month_counts: dict[str, int] = defaultdict(int)
        for values in units.values():
            for y in years:
                x = values.get(y, (0.0, 0.0))
                others = [values.get(o, (0.0, 0.0)) for o in years if o != y]
                total += 1
                for i, ix in enumerate(INDICATORS):
                    a = assess(x[i], [o[i] for o in others])
                    counts[ix][a["label"]] += 1
                    if x[i] > 0:
                        active[ix][a["label"]] += 1
                    ceiling[ix] += a["at_ceiling"]
                    if ix == "activity":
                        month_counts[a["label"]] += 1
        n = sum(month_counts.values())
        by_month[month] = {"years": len(years), "unit_months": n,
                           **{k: round(month_counts[k] / n, 4) if n else None for k in LABELS}}

    def shares(c: dict, n: int) -> dict:
        return {k: round(c[k] / n, 4) if n else None for k in (*LABELS, INSUFFICIENT)}

    return {
        "unit": unit, "hotspots": hotspots, "unit_months": total,
        "nominal_at_or_above": {name: round(1 - lower, 2) for name, lower in THRESHOLDS},
        "indicators": {ix: {"all": shares(counts[ix], total),
                            "active": shares(active[ix], sum(active[ix].values())),
                            "at_ceiling": round(ceiling[ix] / total, 4) if total else None}
                       for ix in INDICATORS},
        "activity_by_month": by_month,
    }
