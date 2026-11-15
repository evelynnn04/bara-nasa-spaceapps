"""Fire activity anomalies: how unusual a month's fire activity is in a 0.25° grid cell, compared
with the same calendar month in other years.

The method (see `docs/anomaly.md`):

1. **Product.** One consistent product: qualifying VIIRS 375 m pixels of the day's reference
   satellite (S-NPP, else NOAA-20, else NOAA-21) from the splice (1 February 2012) on. The
   qualifying rule is the cell-day table's: presumed vegetation fires, static thermal sources
   removed. A day the reference satellite did not observe Indonesia is missing, never zero.
2. **Grid.** Fixed 0.25° cells (`gx = floor(lon / 0.25)`, `gy = floor(lat / 0.25)`), each the sum
   of 5 x 5 cells of the 0.05° cell-day table. Per grid cell and local day: the hotspot count (FC,
   qualifying pixels) and summed fire radiative power (FRP, MW).
3. **Baseline.** The month is summed over days 1 to D, where D is the month's length, or the last
   data day for the unfinished current month. Every other year (or, with `reference=prior`, every
   earlier year) contributes the same days of the same calendar month when its satellite observed at
   least `MIN_COVERAGE` of them.
4. **Score.** For observation x and the n reference values X_j of one indicator,
   `p_upper = (1 + #{X_j >= x}) / (n + 1)` and `A = 1 - p_upper`, computed for FC and FRP
   independently.
5. **Label.** `A` below 0.80 is normal, from 0.80 elevated, from 0.90 anomalous, from 0.97 extreme.
   The highest attainable score is n / (n + 1), so with too few reference years some labels cannot
   be reached; the response says which, and a score at that ceiling is a lower bound. Below
   `MIN_REFERENCE` years no label is given at all. A unit whose reference median is zero is flagged
   `sparse_history`, and an alert there carries a `disclaimer`: a few hotspots already rank above
   every reference year.

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
#: classes of the Severe Fire Danger Index; not validated for hotspot counts or FRP.
THRESHOLDS = (("extreme", 0.97), ("anomalous", 0.90), ("elevated", 0.80))
LABELS = ("normal", "elevated", "anomalous", "extreme")
RANK = {name: i for i, name in enumerate(LABELS)}
INSUFFICIENT = "insufficient_baseline"

#: Fewest reference values with which the lowest alert label (0.80) can be reached: n / (n + 1) >= 0.80.
MIN_REFERENCE = 4

PRODUCT = "VIIRS 375 m active fire, reference satellite of the day (S-NPP, else NOAA-20, else NOAA-21)"
GRANULARITY = "calendar_month"
CALIBRATION = "uncalibrated"
SCREENING = ("Presumed vegetation fires only (FIRMS type 0); untyped near-real-time pixels on the static-source "
             "mask (volcanoes, gas flares, industry) removed.")

INDICATORS = ("hotspot", "frp")


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


def grid_daily_sql(where: str = "TRUE") -> str:
    """Daily hotspot count and summed FRP per 0.25° grid cell over the VIIRS reference record.

    Columns: `gx`, `gy`, `local_date`, `platform`, `fc`, `fc_night`, `frp`, `frp_max`, `cells`
    (active 0.05° cells). `where` filters observation rows (aliases `c`, `d`, `k`)."""
    gx, gy = grid_sql()
    n = weights.pixels_sql("all")
    return f"""
        SELECT {gx} AS gx, {gy} AS gy, c.local_date, c.platform,
               sum({n}) AS fc, sum(c.n_night) AS fc_night, sum(c.frp_sum) AS frp, max(c.frp_max) AS frp_max,
               count(*) AS cells
        FROM ({record_sql(where)}) c
        GROUP BY ALL
    """


def record_sql(where: str = "TRUE") -> str:
    """Observation rows of the VIIRS reference record from the splice on."""
    return weights.observations_sql(
        f"c.platform = d.record_platform AND c.sensor = 'viirs' AND c.local_date >= DATE '{config.SPLICE}' "
        f"AND ({where})")


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


def combine(hotspot: dict, frp: dict) -> tuple[str, str]:
    """Headline label (the higher of the two) and the indicator that sets it (`both` on a tie)."""
    if hotspot["label"] == INSUFFICIENT:
        return INSUFFICIENT, "both"
    rh, rf = RANK[hotspot["label"]], RANK[frp["label"]]
    if rh != rf:
        return (hotspot["label"], "hotspot") if rh > rf else (frp["label"], "frp")
    if hotspot["score"] == frp["score"]:
        return hotspot["label"], "both"
    return hotspot["label"], "hotspot" if hotspot["score"] > frp["score"] else "frp"


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

    Raises ValueError when the month lies outside the VIIRS reference record."""
    platform_of = {d: p for d, p, _ in flags if d >= config.SPLICE}
    last = flags[-1][0]
    start = dt.date(year, month, 1)
    if start < config.SPLICE or start > last:
        raise ValueError(f"{year}-{month:02d} is outside the VIIRS record "
                         f"({config.SPLICE:%Y-%m} to {last:%Y-%m})")
    month_end = dt.date(year, month, calendar.monthrange(year, month)[1])
    provisional = month_end > last
    last_dom = last.day if provisional else month_end.day
    target = window(platform_of, year, month, last_dom)
    ref, excluded = [], []
    for y in range(config.SPLICE.year, last.year + 1):
        if y == year or (reference == "prior" and y > year):
            continue
        if dt.date(y, month, 1) < config.SPLICE:
            continue
        w = window(platform_of, y, month, last_dom)
        if w.end > last:
            continue
        if w.coverage < MIN_COVERAGE:
            excluded.append({"year": y, "reason": "low_coverage", "observed_days": w.observed, "window_days": w.days})
            continue
        ref.append(w)
    return Baseline(target, provisional, ref, excluded)


def _window_filter(windows: list[Window]) -> str:
    return " OR ".join(f"c.local_date BETWEEN DATE '{w.start}' AND DATE '{w.end}'" for w in windows)


# --- queries ---------------------------------------------------------------------------------------


def monthly_grids(con: duckdb.DuckDBPyConnection, b: Baseline, grids_table: str) -> dict:
    """Per grid cell in `grids_table(gx, gy)`: {year: (fc, frp)} over the target and reference windows."""
    windows = [b.target, *b.reference]
    gx, gy = grid_sql()
    where = f"({_window_filter(windows)}) AND ({gx}, {gy}) IN (SELECT gx, gy FROM {grids_table})"
    rows = con.execute(f"""
        SELECT gx, gy, year(local_date) AS y, sum(fc), sum(frp) FROM ({grid_daily_sql(where)})
        GROUP BY ALL
    """).fetchall()
    out: dict[tuple[int, int], dict[int, tuple[float, float]]] = defaultdict(dict)
    for x, y, yr, fc, frp in rows:
        out[(x, y)][yr] = (float(fc), float(frp))
    return out


def target_details(con: duckdb.DuckDBPyConnection, b: Baseline, grids_table: str, cells_table: str) -> dict:
    """Per grid cell active in the target window: hotspots and FRP inside the selected area, night
    hotspots, highest pixel FRP, active 0.05° cells and the main island group, province and
    city/regency."""
    gx, gy = grid_sql()
    where = (f"c.local_date BETWEEN DATE '{b.target.start}' AND DATE '{b.target.end}' "
             f"AND ({gx}, {gy}) IN (SELECT gx, gy FROM {grids_table})")
    n = weights.pixels_sql("all")
    rows = con.execute(f"""
        SELECT {gx} AS gx, {gy} AS gy,
               sum({n}) FILTER (WHERE (c.cx, c.cy) IN (SELECT cx, cy FROM {cells_table})) AS fc_in,
               sum(c.n_night) AS fc_night, max(c.frp_max) AS frp_max,
               count(DISTINCT (c.cx, c.cy)) AS cells,
               arg_max(c.island_group, {n}) AS island_group,
               arg_max(c.province_id, {n}) AS province_id,
               arg_max(c.regency_id, {n}) AS regency_id
        FROM ({record_sql(where)}) c
        GROUP BY ALL
    """).fetchall()
    return {(r[0], r[1]): {"fc_in": float(r[2] or 0), "fc_night": float(r[3] or 0), "frp_max": float(r[4] or 0),
                           "cells": int(r[5]), "island_group": r[6], "province_id": r[7], "regency_id": r[8]}
            for r in rows}


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


def area_totals(con: duckdb.DuckDBPyConnection, b: Baseline, cells_table: str) -> dict[int, tuple[float, float]]:
    """{year: (fc, frp)} for the cells in `cells_table(cx, cy)` over the target and reference windows."""
    n = weights.pixels_sql("all")
    where = f"({_window_filter([b.target, *b.reference])}) AND (c.cx, c.cy) IN (SELECT cx, cy FROM {cells_table})"
    rows = con.execute(f"""
        SELECT year(c.local_date), sum({n}), sum(c.frp_sum) FROM ({record_sql(where)}) c GROUP BY 1
    """).fetchall()
    return {r[0]: (float(r[1]), float(r[2])) for r in rows}


# --- records ---------------------------------------------------------------------------------------


def sparse_disclaimer(n: int, hotspots: int) -> str:
    """Caution shown with an alert in a unit that usually has no fire in the month."""
    return (f"This place usually has no fire in this month (no hotspots in at least half of the {n} reference "
            f"years). Only {hotspots} hotspot{'s' if hotspots != 1 else ''} already rank above most of those years, "
            "so the label reflects a few detections in a normally empty place, not a large fire.")


def record(values: dict[int, tuple[float, float]], b: Baseline, years: bool = False) -> dict:
    """The anomaly record of one unit (grid cell or area) from its yearly window totals.

    `disclaimer` is set when an alert comes from a unit whose reference median is zero. With
    `years`, `years` lists the window totals of the target and every reference year, oldest first,
    for charts."""
    fc, frp = values.get(b.target.year, (0.0, 0.0))
    ref_fc = [values.get(y, (0.0, 0.0))[0] for y in b.years]
    ref_frp = [values.get(y, (0.0, 0.0))[1] for y in b.years]
    h, f = assess(fc, ref_fc), assess(frp, ref_frp)
    label, dominant = combine(h, f)
    sparse = bool(ref_fc) and quantile(sorted(ref_fc), 0.5) == 0
    out = {
        "hotspot_count": int(round(fc)), "summed_frp_mw": round(frp, 1),
        "hotspot_score": _r(h["score"]), "frp_score": _r(f["score"]),
        "hotspot_label": h["label"], "frp_label": f["label"],
        "hotspot_at_ceiling": h["at_ceiling"], "frp_at_ceiling": f["at_ceiling"],
        "label": label, "dominant_indicator": dominant,
        "sparse_history": sparse,
        "disclaimer": sparse_disclaimer(len(ref_fc), int(round(fc))) if sparse and RANK.get(label, 0) > 0 else None,
        "history": {"hotspot": _rounded(summary(ref_fc)), "frp": _rounded(summary(ref_frp))},
    }
    if years:
        out["years"] = [{"year": y, "hotspot_count": int(round(values.get(y, (0.0, 0.0))[0])),
                         "summed_frp_mw": round(values.get(y, (0.0, 0.0))[1], 1), "target": y == b.target.year}
                        for y in sorted([b.target.year, *b.years])]
    return out


def _r(v: float | None, digits: int = 4) -> float | None:
    return None if v is None else round(v, digits)


def _rounded(d: dict) -> dict:
    return {k: (v if k == "n" else _r(v, 3)) for k, v in d.items()}


def data_quality(b: Baseline) -> dict:
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
            "screening": SCREENING,
            "coverage_note": "Coverage counts days the satellite observed Indonesia; cloud cover over a single grid "
                             "cell is not known and can hide fires."}


# --- evaluation ------------------------------------------------------------------------------------


def evaluate(con: duckdb.DuckDBPyConnection, flags: list[tuple]) -> dict:
    """Leave-one-year-out alert rates over complete months.

    Every complete calendar month of every year is scored against the same month of all other
    valid years, for every grid cell active in that calendar month in any valid year (so a quiet
    year of an active cell counts as a normal outcome). Returns, per indicator, the share of
    grid-months given each label overall and among months with activity, and the share whose score
    sat at the sample-size ceiling. Under exchangeable years the share at or above a threshold t is
    at most 1 - t."""
    last = flags[-1][0]
    counts = {i: defaultdict(int) for i in INDICATORS}
    active = {i: defaultdict(int) for i in INDICATORS}
    ceiling = {i: 0 for i in INDICATORS}
    totals = {"grid_months": 0, "active_grid_months": 0}
    by_month = {}
    for month in range(1, 13):
        last_complete = last.year if dt.date(last.year, month, calendar.monthrange(last.year, month)[1]) <= last \
            else last.year - 1
        b = baseline(flags, last_complete, month)
        windows = [b.target, *b.reference] if b.target.coverage >= MIN_COVERAGE else b.reference
        years = [w.year for w in windows]
        con.execute(f"CREATE OR REPLACE TEMP TABLE evalg AS SELECT DISTINCT {grid_sql()[0]} AS gx, "
                    f"{grid_sql()[1]} AS gy FROM cells c")
        full = Baseline(b.target, False, windows, [])
        grids = monthly_grids(con, full, "evalg")
        month_counts = defaultdict(int)
        for values in grids.values():
            for y in years:
                others = [values.get(o, (0.0, 0.0)) for o in years if o != y]
                x = values.get(y, (0.0, 0.0))
                totals["grid_months"] += 1
                if x[0] > 0:
                    totals["active_grid_months"] += 1
                for i, ix in enumerate(INDICATORS):
                    a = assess(x[i], [o[i] for o in others])
                    counts[ix][a["label"]] += 1
                    if x[i] > 0:
                        active[ix][a["label"]] += 1
                    ceiling[ix] += a["at_ceiling"]
                    if ix == "hotspot":
                        month_counts[a["label"]] += 1
        n = sum(month_counts.values())
        by_month[month] = {"years": len(years), "grid_months": n,
                           **{k: round(month_counts[k] / n, 4) if n else None for k in LABELS}}

    def shares(c: dict, n: int) -> dict:
        return {k: round(c[k] / n, 4) if n else None for k in (*LABELS, INSUFFICIENT)}

    return {
        **totals,
        "nominal_at_or_above": {name: round(1 - lower, 2) for name, lower in THRESHOLDS},
        "indicators": {ix: {"all": shares(counts[ix], totals["grid_months"]),
                            "active": shares(active[ix], sum(active[ix].values())),
                            "at_ceiling": round(ceiling[ix] / totals["grid_months"], 4) if totals["grid_months"] else None}
                       for ix in INDICATORS},
        "hotspot_by_month": by_month,
    }
