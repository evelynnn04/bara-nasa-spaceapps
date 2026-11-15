"""HTTP API over the harmonised fire record.

Every endpoint takes the same area selection:

- `area`: comma-separated area ids (`idn`, a province or a city/regency), summed without counting
  any cell twice; or
- `poly`: a drawn polygon as `lon,lat;lon,lat;...`, which selects the cells whose centre lies
  inside it.

`daynight` is `all`, `day` or `night`, and `hotspots` is `vegetation` (presumed vegetation fires,
the default) or `all` (every hotspot type), each with its own fitted factors. Values are in
hotspots, Aqua MODIS-equivalent (see `docs/harmonisation.md`). A day the record's satellite did not
observe is `null`, never 0.

Named areas are answered from the region cache. A polygon reuses the cache for regencies lying
wholly inside it and aggregates its remaining cells on demand. All paths build their numbers from
the same weight expression.
"""

from __future__ import annotations

import csv
import datetime as dt
import io
import re
import threading
from collections import defaultdict
from dataclasses import dataclass
from functools import lru_cache
from typing import Iterator, Literal

import duckdb
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse

from . import anomaly, attribution, config, critical, geo, outlook, queries, store
from .db import quote
from .harmonise import fit, weights
from .pipeline.celldays import cell_expr, qualifying_sql
from .pipeline.normalise import MASK_RES

router = APIRouter(prefix="/api")

DayNight = Literal["all", "day", "night"]
Hotspots = Literal["vegetation", "all"]

#: Grid cells per side of the block (0.25°) used to find the most active spot.
COARSE = 5
#: Safety bound on the map layer: above this many active cells it is summed onto 0.25° blocks.
#: The whole record touches under 50,000 cells, so in practice cells always arrive at 0.05°.
MAX_MAP_CELLS = 100_000
AREA_ID = re.compile(r"^idn(-[a-z0-9]+)*$")

_lock = threading.Lock()
_state: dict = {}


REQUIRED = ("celldays", "days", "cells", "region_daily")
#: Columns that tables built before the hotspot unit lack.
REQUIRED_COLUMNS = {"celldays": ("n_day_all", "frp_day_all"), "region_daily": ("hotspots", "aqua")}


def _problem(con: duckdb.DuckDBPyConnection) -> str | None:
    """Why the derived tables cannot be served, or None."""
    if not store.has(con, *REQUIRED):
        return "The derived tables are missing. Run `python -m app all` first."
    if not all(store.has_columns(con, t, *cols) for t, cols in REQUIRED_COLUMNS.items()):
        return ("The derived tables predate the hotspot unit. Run `python -m app build` and "
                "`python -m app cache` again.")
    return None


def configure(con: duckdb.DuckDBPyConnection | None, params: dict | None) -> None:
    """Sets the connection and parameters the endpoints use (tests pass synthetic ones)."""
    with _lock:
        _state.clear()
        if con is not None:
            _state.update(con=con, params=params, problem=_problem(con))
        _daily.cache_clear()
        _flags.cache_clear()
        _parents.cache_clear()
        _step_scale.cache_clear()
        _outlook_meta.cache_clear()


def _ready() -> dict:
    """The shared connection and parameters, opened on first use.

    Whether the derived tables exist with the expected columns is checked once, when the
    connection is opened; a problem closes it again so the next request retries."""
    with _lock:
        if not _state:
            try:
                params = weights.load_params()
            except RuntimeError as err:
                raise HTTPException(503, str(err)) from err
            con = store.connect(params)
            _state.update(con=con, params=params, problem=_problem(con))
        if _state["problem"]:
            problem = _state["problem"]
            con = _state.pop("con")
            _state.clear()
            con.close()
            raise HTTPException(503, problem)
        return _state


def cursor() -> duckdb.DuckDBPyConnection:
    """A cursor of the shared connection, safe to use from one request thread."""
    return _ready()["con"].cursor()


@dataclass(frozen=True)
class Area:
    """A selection of named areas (`ids`) or a drawn polygon (`ring`)."""

    ids: tuple[str, ...] = ("idn",)
    ring: tuple[tuple[float, float], ...] | None = None

    def where(self, cur: duckdb.DuckDBPyConnection) -> str:
        """WHERE fragment over the observation relation; a polygon first becomes temp table `sel`."""
        if self.ring is not None:
            queries.polygon_cells(cur, list(self.ring), "sel")
            return queries.area_filter(cells_table="sel")
        return queries.area_filter(list(self.ids))


def area_param(
    area: str | None = Query(None, description="Comma-separated area ids, for example `idn-riau,idn-jambi`."),
    poly: str | None = Query(None, description="Polygon corners as `lon,lat;lon,lat;...`."),
) -> Area:
    """Parses and validates the area selection of a request."""
    if poly:
        try:
            ring = geo.parse_polygon(poly)
        except ValueError as err:
            raise HTTPException(400, f"poly: {err}") from err
        return Area(ring=tuple((round(x, 4), round(y, 4)) for x, y in ring))
    ids = [i for i in (area or "idn").split(",") if i]
    if not ids or len(ids) > 600 or not all(AREA_ID.match(i) for i in ids):
        raise HTTPException(400, "area: expected comma-separated area ids such as `idn-riau`")
    parents = _parents()
    unknown = [i for i in ids if i not in parents]
    if unknown:
        raise HTTPException(400, f"area: unknown area id {unknown[0]!r}")
    return Area(ids=tuple(queries.normalise_ids(ids, parents)))


def period(
    start: dt.date = Query(..., alias="from", description="First local day, YYYY-MM-DD."),
    end: dt.date = Query(..., alias="to", description="Last local day, YYYY-MM-DD."),
) -> tuple[dt.date, dt.date]:
    """The requested date range, inclusive."""
    if start > end:
        raise HTTPException(400, "`from` must not be after `to`")
    return start, end


@lru_cache(maxsize=1)
def _parents() -> dict[str, str | None]:
    return queries.area_parents(cursor())


@lru_cache(maxsize=1)
def _flags() -> list[tuple]:
    return queries.day_flags(cursor())


@lru_cache(maxsize=256)
def _daily(area: Area, daynight: str, hotspots: str = "vegetation") -> dict[dt.date, tuple]:
    """Daily sums for an area: the region cache for named areas; for a polygon, the cache for the
    regencies wholly inside it plus the remaining cells."""
    cur = cursor()
    if area.ring is None:
        return queries.daily_cached(cur, daynight, list(area.ids), hotspots)
    n = queries.polygon_cells(cur, list(area.ring), "sel")
    return queries.daily_polygon(cur, daynight, "sel", n, hotspots)


def _fmt(v: float | None, digits: int = 4) -> float | None:
    return None if v is None else round(v, digits)


@router.get("/meta")
def meta() -> dict:
    """Record span, unit, the fitted factors and the national evaluation."""
    p = _ready()["params"]
    flags = _flags()
    last = {name: d for name, d in cursor().execute("""
        SELECT 'aqua', max(local_date) FILTER (WHERE aqua) FROM days UNION ALL
        SELECT 'snpp', max(local_date) FILTER (WHERE snpp) FROM days UNION ALL
        SELECT 'noaa20', max(local_date) FILTER (WHERE noaa20) FROM days UNION ALL
        SELECT 'noaa21', max(local_date) FILTER (WHERE noaa21) FROM days
    """).fetchall()}
    settings = {}
    for name, s in p.get("settings", {}).items():
        ev = s.get("evaluation", {})
        loyo = ev.get("leave_one_year_out", {})
        settings[name] = {
            "factors": s.get("factors"),
            "verdict": s.get("verdict"),
            "evaluation": {
                "leave_one_year_out": loyo.get("national"),
                "day_only": loyo.get("national_day"),
                "night_only": loyo.get("national_night"),
                "island_groups": loyo.get("island_groups"),
                "split_even_train_odd_test": ev.get("split_even_train_odd_test"),
                "control_snpp_vs_noaa20": ev.get("control_snpp_vs_noaa20"),
                "peak_misses": ev.get("peak_misses"),
                "story_2015": ev.get("story_2015"),
            },
        }
    return {
        "record": {"start": flags[0][0], "end": flags[-1][0], "splice": config.SPLICE,
                   "unobserved_days": sum(1 for f in flags if f[1] is None)},
        "last_observed": last,
        "unit": fit.UNIT,
        "grid_deg": config.GRID,
        "method": {
            "summary": "Fire activity is counted in hotspots. An Aqua MODIS hotspot counts 1; a VIIRS hotspot counts "
                       "1 divided by a factor for its island group, calendar month and half of the day.",
            "fit_window": p.get("fit_window"), "fitted": p.get("fitted"), "n0": p.get("n0"),
        },
        "default_hotspots": p.get("default_hotspots", "vegetation"),
        "verdict": p.get("verdict"),
        "settings": settings,
    }


@router.get("/series")
def series(area: Area = Depends(area_param), daynight: DayNight = "all", hotspots: Hotspots = "vegetation") -> dict:
    """The daily harmonised record of an area over the whole record, one value per day from `start`."""
    flags = _flags()
    values = queries.record_series(_daily(area, daynight, hotspots), flags)
    return {"start": flags[0][0], "end": flags[-1][0], "unit": fit.UNIT, "daynight": daynight,
            "hotspots": hotspots, "values": [_fmt(v) for v in values]}


@router.get("/critical")
def critical_periods(area: Area = Depends(area_param), daynight: DayNight = "all",
                     hotspots: Hotspots = "vegetation") -> dict:
    """Calendar months and ISO weeks that historically hold elevated fire activity in an area.

    Each period of each complete year is compared with its own year: its intensity is its mean
    daily value over the year's mean daily value. A period is `critical` when its mean intensity
    over the active years is at least `method.ratio_min` and it was above its year's average in at
    least `method.recurrence_min` of them; a week is measured over a centred window of
    `method.week_window` weeks. `activity.confidence` rates how far the result can be trusted from
    the area's mean annual activity (see `docs/critical-periods.md`). `values` and `expected`
    follow `years`: the period's value in that year, and what it would hold at its year's average
    rate; both are `null` when the period does not occur that year (ISO week 53)."""
    flags = _flags()
    values = queries.record_series(_daily(area, daynight, hotspots), flags)
    return {"unit": fit.UNIT, "daynight": daynight, "hotspots": hotspots,
            **critical.critical_periods([f[0] for f in flags], values)}


@router.get("/cells")
def cells(area: Area = Depends(area_param), span: tuple[dt.date, dt.date] = Depends(period),
          daynight: DayNight = "all", hotspots: Hotspots = "vegetation") -> dict:
    """Active cells of the harmonised record in a period, for the map.

    Each 0.05° cell carries its harmonised value, the raw hotspots of each sensor and its highest
    hotspot fire radiative power. Cells are sent at full resolution, so the map looks the same for
    every filter; only above `MAX_MAP_CELLS` (never reached by the current record) is the layer
    summed onto 0.25° blocks, with `res_deg` saying which. `top` is the most active 0.25° block and
    the city/regency holding most of it."""
    cur = cursor()
    w, n = weights.weight_sql(daynight, hotspots), weights.hotspots_sql(daynight, hotspots)
    frp_max = f"c.frp_max{weights.HOTSPOTS[hotspots]}"
    where = f"c.local_date BETWEEN DATE '{span[0]}' AND DATE '{span[1]}' AND ({area.where(cur)})"
    rows = cur.execute(f"""
        SELECT c.cx, c.cy,
               sum(CASE WHEN c.platform = c.record_platform THEN {w} ELSE 0 END) AS value,
               sum(CASE WHEN c.side = 'a' THEN {n} ELSE 0 END) AS modis_px,
               sum(CASE WHEN c.side = 'b' THEN {n} ELSE 0 END) AS viirs_px,
               max(CASE WHEN c.platform = c.record_platform AND {n} > 0 THEN {frp_max} END) AS frp_max,
               any_value(c.regency_id) AS regency_id
        FROM ({weights.observations_sql(where, hotspots)}) c
        GROUP BY c.cx, c.cy HAVING value > 0
        ORDER BY c.cx, c.cy
    """).fetchall()

    blocks: dict[tuple[int, int], list] = defaultdict(lambda: [0.0, 0, 0, 0.0, defaultdict(float)])
    for cx, cy, value, mpx, vpx, frp, regency in rows:
        b = blocks[(cx // COARSE, cy // COARSE)]
        b[0] += value
        b[1] += mpx
        b[2] += vpx
        b[3] = max(b[3], frp or 0.0)
        b[4][regency] += value

    top = None
    if blocks:
        (bx, by), b = max(blocks.items(), key=lambda kv: kv[1][0])
        size = config.GRID * COARSE
        top = {"lon": round((bx + 0.5) * size, 4), "lat": round((by + 0.5) * size, 4), "size_deg": size,
               "value": _fmt(b[0]), "region_id": max(b[4].items(), key=lambda kv: kv[1])[0]}

    if len(rows) > MAX_MAP_CELLS:
        res = config.GRID * COARSE
        out = [(bx, by, b[0], b[1], b[2], b[3]) for (bx, by), b in sorted(blocks.items())]
    else:
        res = config.GRID
        out = [r[:6] for r in rows]
    return {
        "res_deg": res, "count": len(out), "active_cells": len(rows),
        "total": _fmt(sum(r[2] for r in rows)),
        "cells": {
            "lon": [round((r[0] + 0.5) * res, 4) for r in out],
            "lat": [round((r[1] + 0.5) * res, 4) for r in out],
            "value": [round(r[2], 3) for r in out],
            "modis_px": [int(r[3]) for r in out],
            "viirs_px": [int(r[4]) for r in out],
            "frp_max": [round(r[5] or 0.0, 1) for r in out],
        },
        "top": top,
    }


#: Quantiles of the map's colour classes, matching `quantileBreaks` in the frontend's ramps.ts.
SCALE_QUANTILES = (0.35, 0.55, 0.7, 0.8, 0.88, 0.94, 0.98, 0.995)
_STEP_SQL = {"day": "c.local_date", "month": "date_trunc('month', c.local_date)",
             "year": "date_trunc('year', c.local_date)"}


@lru_cache(maxsize=128)
def _step_scale(area: Area, interval: str, daynight: str, hotspots: str) -> list[float]:
    cur = cursor()
    w = weights.weight_sql(daynight, hotspots)
    row = cur.execute(f"""
        SELECT quantile_disc(value, {list(SCALE_QUANTILES)}) FROM (
            SELECT sum(CASE WHEN c.platform = c.record_platform THEN {w} ELSE 0 END) AS value
            FROM ({weights.observations_sql(area.where(cur), hotspots)}) c
            GROUP BY c.cx, c.cy, {_STEP_SQL[interval]} HAVING value > 0
        )
    """).fetchone()
    return [round(v, 4) for v in row[0]] if row and row[0] else []


@router.get("/cells/scale")
def cells_scale(area: Area = Depends(area_param), interval: Literal["day", "month", "year"] = "month",
                daynight: DayNight = "all", hotspots: Hotspots = "vegetation") -> dict:
    """Value quantiles of one map cell over one timeline step, pooled over every step of the
    record, so each step of an interval is coloured on the same scale whatever dates are
    selected. `values` follow `quantiles`; empty when the area has no active cell."""
    return {"interval": interval, "quantiles": list(SCALE_QUANTILES),
            "values": _step_scale(area, interval, daynight, hotspots)}


@router.get("/agreement")
def agreement(area: Area = Depends(area_param), daynight: DayNight = "all",
              hotspots: Hotspots = "vegetation") -> dict:
    """MODIS against VIIRS for an area, month by month, on paired days only.

    Paired days are days both Aqua and the VIIRS reference satellite observed Indonesia. `months`
    runs from the splice to the last data day. The metrics and verdicts cover the fit window, once
    for the harmonised values and once for raw VIIRS hotspots. `modis` and `modis_px` are both the
    Aqua hotspot count; `viirs_px` is the raw VIIRS-reference hotspot count."""
    flags = _flags()
    start, end = config.SPLICE, flags[-1][0]
    monthly = queries.monthly_paired(_daily(area, daynight, hotspots), flags, start, end)
    paired_days: dict[tuple[int, int], int] = defaultdict(int)
    for d, _, paired in flags:
        if paired and start <= d <= end:
            paired_days[(d.year, d.month)] += 1
    window = {k: v for k, v in monthly.items() if config.FIT_START <= dt.date(k[0], k[1], 1) <= config.FIT_END}
    return {
        "unit": fit.UNIT, "daynight": daynight, "hotspots": hotspots,
        "window": [config.FIT_START, config.FIT_END],
        "months": [{"year": y, "month": m, "paired_days": paired_days[(y, m)],
                    "modis": _fmt(v[0]), "viirs": _fmt(v[1]), "modis_px": int(v[0]), "viirs_px": int(v[2])}
                   for (y, m), v in sorted(monthly.items())],
        "harmonised": queries.agreement(window, harmonised=True),
        "raw": queries.agreement(window, harmonised=False),
    }


def _baseline_info(b: anomaly.Baseline) -> dict:
    """Reference years and score resolution of one month's baseline."""
    n = len(b.reference)
    return {"granularity": anomaly.GRANULARITY, "years": b.years, "sample_size": n,
            "excluded_years": b.excluded, "min_coverage": anomaly.MIN_COVERAGE,
            "max_score": round(anomaly.max_score(n), 4) if n else None,
            "reachable_labels": anomaly.reachable_labels(n) if n >= anomaly.MIN_REFERENCE else [],
            "calibration_status": anomaly.CALIBRATION}


def _common(b: anomaly.Baseline) -> dict:
    """Fields every anomaly record of one month carries."""
    return {"period_start": b.target.start, "period_end": b.target.end, "product": anomaly.PRODUCT,
            "historical_sample_size": len(b.reference), "baseline_granularity": anomaly.GRANULARITY,
            "score_calibration_status": anomaly.CALIBRATION}


@router.get("/anomalies")
def anomalies(area: Area = Depends(area_param),
              period: Literal["month", "year"] = Query(
                  "month", description="Score one month, or every month of a year (the Year view)."),
              year: int | None = Query(None, ge=1, le=9999, description="Year; default the last data month's."),
              month: int | None = Query(None, ge=1, le=12, description="Month 1-12; default the last data month."),
              reference: Literal["other", "prior"] = Query(
                  "other", description="Reference years: every other year, or only earlier years."),
              grids: bool = Query(False, description="Also score every active 0.25° grid cell of the area."),
              daynight: DayNight = "all", hotspots: Hotspots = "vegetation") -> dict:
    """How unusual a month's fire activity is in an area, against the same month in other years.

    Both indicators come from the harmonised record (2002 on) in MODIS-equivalent units: `activity`
    in hotspots and `frp_mw`, summed fire radiative power. Each is scored independently with
    the empirical upper-tail rank `A = 1 - (1 + #{X_j >= x}) / (n + 1)` against the reference years.
    Labels: normal below 0.80, elevated from 0.80, anomalous from 0.90, extreme from 0.97. The
    thresholds are provisional and uncalibrated; with n reference years the highest score is
    n / (n + 1), listed in `baseline.max_score`.

    `area` is the record of the whole selection, summed over its own 0.05° cells, with `years` for
    charts. With `grids=true`, `grids` lists the 0.25° grid cells touching the area with activity in
    the month; their values cover the whole grid cell, and `in_area_share` is the share of its
    activity inside the area. An unfinished month is compared over the same days of the other years
    and is marked provisional. With `daynight=day` or `night`, both indicators count only that half
    of the day, for the target and the reference years alike.

    With `period=year` (no `month`, no `grids`), `months` lists every month of the year inside the
    record, each scored against the same month in the reference years exactly as `period=month`
    would, and `summary` counts the months per label. No label is given to the year as a whole. See
    `docs/anomaly.md`."""
    flags = _flags()
    last = flags[-1][0]
    year = year or last.year
    if period == "year":
        if month is not None or grids:
            raise HTTPException(400, "period=year takes neither `month` nor `grids`")
        return _year_view(area, year, reference, daynight, hotspots)
    month = month or last.month
    try:
        b = anomaly.baseline(flags, year, month, reference)
    except ValueError as err:
        raise HTTPException(400, str(err)) from err
    cur = cursor()
    where = area.where(cur)
    common = _common(b)
    try:
        whole = anomaly.record(anomaly.totals(cur, b.windows, where, daynight=daynight, hotspots=hotspots)
                               .get(None, {}), b, years=True)
        cells = _anomaly_grids(cur, b, where, common, daynight, hotspots) if grids else None
    except anomaly.MissingFactors as err:
        raise HTTPException(503, str(err)) from err
    out = {
        "period": {"year": year, "month": month, "start": b.target.start, "end": b.target.end,
                   "provisional": b.provisional},
        "unit": fit.UNIT, "product": anomaly.PRODUCT, "reference": reference, "daynight": daynight,
        "hotspots": hotspots,
        "baseline": _baseline_info(b),
        "thresholds": {name: lower for name, lower in anomaly.THRESHOLDS},
        "data_quality": anomaly.data_quality(b, hotspots),
        "area": {**common, **whole},
    }
    if cells is not None:
        labels = {k: 0 for k in (*anomaly.LABELS, anomaly.INSUFFICIENT)}
        for r in cells:
            labels[r["label"]] += 1
        out.update(grid_deg=anomaly.GRID_DEG, counts=labels, grids=cells)
    return out


def _year_view(area: Area, year: int, reference: str, daynight: str, hotspots: str) -> dict:
    """Every month of a year inside the record, each scored against the same month in other years."""
    flags = _flags()
    try:
        baselines = anomaly.year_baselines(flags, year, reference)
    except ValueError as err:
        raise HTTPException(400, str(err)) from err
    cur = cursor()
    try:
        values = anomaly.month_totals(cur, baselines, area.where(cur), daynight, hotspots)
    except anomaly.MissingFactors as err:
        raise HTTPException(503, str(err)) from err
    months = []
    for m, b in baselines:
        months.append({"month": m, "provisional": b.provisional, "baseline": _baseline_info(b),
                       "data_quality": anomaly.data_quality(b, hotspots), **_common(b),
                       **anomaly.record(values.get(m, {}), b, years=True)})
    counts = {k: 0 for k in (*anomaly.LABELS, anomaly.INSUFFICIENT)}
    for r in months:
        counts[r["label"]] += 1
    return {
        "period": {"period": "year", "year": year, "start": months[0]["period_start"],
                   "end": months[-1]["period_end"], "provisional": any(r["provisional"] for r in months)},
        "unit": fit.UNIT, "product": anomaly.PRODUCT, "reference": reference, "daynight": daynight,
        "hotspots": hotspots,
        "thresholds": {name: lower for name, lower in anomaly.THRESHOLDS},
        "months": months,
        "summary": {"months_scored": len(months), "counts": counts,
                    "alert_months": [r["month"] for r in months if anomaly.RANK.get(r["label"], 0) > 0]},
    }


def _anomaly_grids(cur: duckdb.DuckDBPyConnection, b: anomaly.Baseline, where: str, common: dict,
                   daynight: str, hotspots: str) -> list[dict]:
    """Records of the 0.25° grid cells touching the area with activity in the target window,
    highest label first."""
    anomaly.area_grids(cur, where, "agrid")
    details = anomaly.target_details(cur, b, "agrid", "agrid_cells", daynight, hotspots)
    out = []
    for (gx, gy), values in anomaly.grid_totals(cur, b, "agrid", daynight, hotspots).items():
        if values.get(b.target.year, (0.0, 0.0))[0] <= 0:
            continue
        d = details[(gx, gy)]
        rec = anomaly.record(values, b)
        west, south, east, north = anomaly.grid_bounds(gx, gy)
        out.append({
            "grid_id": anomaly.grid_id(gx, gy), "lon": west + anomaly.GRID_DEG / 2, "lat": south + anomaly.GRID_DEG / 2,
            "bbox": [west, south, east, north], **common, **rec,
            "in_area_share": round(min(1.0, d["in_area"] / values[b.target.year][0]), 3),
            "environmental_context": {
                "island_group": d["island_group"], "province_id": d["province_id"], "regency_id": d["regency_id"],
                "active_cells_005": d["cells"],
                "night_share": None if d["night_share"] is None else round(float(d["night_share"]), 3),
                "frp_max_mw": round(d["frp_max"], 1),
                "forest_cover": None, "wind": None, "unavailable": ["forest_cover", "wind"],
            },
        })
    out.sort(key=lambda r: (-anomaly.RANK.get(r["label"], -1),
                            -max(r["activity_score"] or 0, r["frp_score"] or 0), -r["activity"]))
    return out


EVENT_COLUMNS = ("event", "start", "end", "duration_days", "peak_day", "cells", "cell_days", "harmonised",
                 "pixels", "frp_max", "lon", "lat", "west", "south", "east", "north", "regency_id", "province_id")


Cause = Literal["land_clearing", "agricultural_burning", "wildfire", "unknown"]


@router.get("/events")
def events(area: Area = Depends(area_param), span: tuple[dt.date, dt.date] = Depends(period),
           limit: int = Query(5, ge=1, le=50), hotspots: Hotspots = "vegetation",
           cause: Cause | None = None) -> dict:
    """The largest fire events active in a period, by harmonised hotspots.

    An event groups active cell-days whose cells touch and whose days are at most one day apart.
    Its descriptors cover the whole event, also the part outside the requested period. A named area
    selects events that lie mostly inside it; a polygon selects events whose centre it contains.

    When the attribution is built, every event carries `attribution` (likely cause, confidence,
    indicators and cited evidence; see `/api/attribution` and docs/attribution.md), else null.
    `cause` keeps only events attributed to that cause."""
    cur = cursor()
    if not store.has(cur, "events"):
        raise HTTPException(503, "Fire events are missing. Run `python -m app cache` first.")
    attributed = store.has(cur, "event_attribution")
    if cause and not attributed:
        raise HTTPException(503, "Fire cause attribution is missing. Run `python -m app attribute` first.")
    where = [f"hotspots = {quote(hotspots)}", f"start <= DATE '{span[1]}'", f"\"end\" >= DATE '{span[0]}'"]
    if cause:
        where.append(f"event IN (SELECT event FROM event_attribution WHERE hotspots = {quote(hotspots)} "
                     f"AND category = {quote(cause)})")
    if area.ring is not None:
        xs, ys = [p[0] for p in area.ring], [p[1] for p in area.ring]
        where.append(f"lon BETWEEN {min(xs)} AND {max(xs)} AND lat BETWEEN {min(ys)} AND {max(ys)}")
    elif "idn" not in area.ids:
        listing = ", ".join(quote(i) for i in area.ids)
        where.append(f"(province_id IN ({listing}) OR regency_id IN ({listing}))")
    cols = ", ".join(f'"{c}"' for c in EVENT_COLUMNS)
    rows = cur.execute(f"SELECT {cols} FROM events WHERE {' AND '.join(where)} ORDER BY harmonised DESC "
                       f"LIMIT {limit if area.ring is None else 2000}").fetchall()
    if area.ring is not None:
        ilon, ilat = EVENT_COLUMNS.index("lon"), EVENT_COLUMNS.index("lat")
        rows = [r for r in rows if geo.point_in_rings(r[ilon], r[ilat], [list(area.ring)])][:limit]
    out = []
    for r in rows:
        e = dict(zip(EVENT_COLUMNS, r))
        for k in ("harmonised", "lon", "lat", "frp_max"):
            e[k] = _fmt(float(e[k]), 3)
        e["bbox"] = [float(e.pop(k)) for k in ("west", "south", "east", "north")]
        e["pixels"] = int(e["pixels"])
        out.append(e)
    found = _attributions(cur, hotspots, [e["event"] for e in out]) if attributed else {}
    for e in out:
        e["attribution"] = found.get(e["event"])
    return {"unit": fit.UNIT, "hotspots": hotspots, "events": out,
            "attribution_disclaimer": attribution.DISCLAIMER if attributed else None}


def _attributions(cur: duckdb.DuckDBPyConnection, hotspots: str, ids: list[int]) -> dict[int, dict]:
    """Attribution of the given events of one type setting, by event id."""
    if not ids:
        return {}
    rows = cur.execute(f"SELECT * FROM event_attribution WHERE hotspots = {quote(hotspots)} "
                       f"AND event IN ({', '.join(str(int(i)) for i in ids)})")
    names = [d[0] for d in rows.description]
    return {r[names.index("event")]: attribution.describe(dict(zip(names, r))) for r in rows.fetchall()}


@router.get("/attribution")
def attribution_method() -> dict:
    """How fire events are attributed to a likely cause: categories, indicators with their points,
    thresholds and sources, confidence levels and the disclaimer. `available` says whether the
    attribution is built and which context layers it used."""
    cur = cursor()
    out = attribution.method()
    out["available"] = store.has(cur, "event_attribution")
    if out["available"]:
        cols = {"forest2000": "hansen2013", "forest_loss": "hansen2013", "landcover_year": "mcd12q1",
                "peat": "gumbricht2017", "rain3": "imerg", "oni": "oni", "dmi": "saji1999"}
        counts = cur.execute("SELECT " + ", ".join(f"count({c})" for c in cols) + " FROM event_attribution").fetchone()
        out["layers"] = {c: n > 0 for c, n in zip(cols, counts)}
    return out


OutlookStep = Literal["day", "month", "year"]
OUTLOOK_LEADS = {"day": outlook.DAY_LEADS, "month": outlook.MONTH_LEADS, "year": outlook.YEAR_LEADS}
OUTLOOK_UNIT = "chance that a 0.05 degree cell holds at least one vegetation-fire hotspot"


@lru_cache(maxsize=1)
def _outlook_meta() -> dict:
    meta = outlook.load_meta()
    if meta is None or not store.has(cursor(), "outlook"):
        raise HTTPException(503, "The fire outlook is missing. Run `python -m app cache` first.")
    return meta


@router.get("/outlook")
def fire_outlook(step: OutlookStep = "day") -> dict:
    """The forecast timeline of one step size: when it was issued and, per lead, the day, month or
    year it falls on and its label (`forecast`, `weak forecast`, `seasonal` or `baseline`, from the
    held-out evaluation in `docs/fire-outlook.md`). Fetch the map of a lead from `/api/outlook/cells`."""
    meta = _outlook_meta()
    issued = meta["issued"]
    return {
        "step": step, "unit": OUTLOOK_UNIT, "issued": issued[step], "estimated_on": meta["years"],
        "leads": [{"lead": k, "target": outlook.target(step, issued, k), "label": meta["labels"][step][str(k)]}
                  for k in range(1, OUTLOOK_LEADS[step] + 1)],
    }


@router.get("/outlook/cells")
def fire_outlook_cells(area: Area = Depends(area_param), step: OutlookStep = "day",
                       lead: int = Query(1, ge=1, le=outlook.DAY_LEADS, description="Steps after the issue date."),
                       min_chance: float = Query(0.01, ge=0, le=1,
                                                 description="Leave out cells with a smaller chance.")) -> dict:
    """The fire outlook of one lead for every 0.05° cell of an area: the chance that the cell holds
    fire on that day, in that month or in that year. `expected_cells` is the sum of the chances over
    the area (cells with fire expected), counting cells below `min_chance` too."""
    meta = _outlook_meta()
    if lead > OUTLOOK_LEADS[step]:
        raise HTTPException(400, f"lead: at most {OUTLOOK_LEADS[step]} for step {step}")
    cur = cursor()
    rows = cur.execute(f"""
        SELECT c.cx, c.cy, c.chance FROM outlook c JOIN cells k ON k.cx = c.cx AND k.cy = c.cy
        WHERE c.step = {quote(step)} AND c.lead = {int(lead)} AND ({area.where(cur)})
    """).fetchall()
    shown = [r for r in rows if r[2] >= min_chance]
    g = config.GRID
    return {
        "step": step, "lead": lead, "target": outlook.target(step, meta["issued"], lead),
        "label": meta["labels"][step][str(lead)], "issued": meta["issued"][step], "unit": OUTLOOK_UNIT,
        "grid_deg": g, "expected_cells": round(sum(r[2] for r in rows), 2), "count": len(shown),
        "cells": {"lon": [round((r[0] + 0.5) * g, 4) for r in shown], "lat": [round((r[1] + 0.5) * g, 4) for r in shown],
                  "chance": [round(r[2], 4) for r in shown]},
    }


@router.get("/outlook/expected")
def fire_outlook_expected(area: Area = Depends(area_param), step: OutlookStep = "day") -> dict:
    """Cells with fire expected over an area at every lead of one step size: the sum of the
    chances over its cells, as `expected_cells` of `/api/outlook/cells`, lead 1 first."""
    meta = _outlook_meta()
    cur = cursor()
    sums = dict(cur.execute(f"""
        SELECT c.lead, sum(c.chance) FROM outlook c JOIN cells k ON k.cx = c.cx AND k.cy = c.cy
        WHERE c.step = {quote(step)} AND ({area.where(cur)}) GROUP BY c.lead
    """).fetchall())
    return {"step": step, "issued": meta["issued"][step], "unit": "cells with fire expected",
            "expected_cells": [round(sums.get(k, 0.0), 2) for k in range(1, OUTLOOK_LEADS[step] + 1)]}


CSV_COLUMNS = ("acq_utc", "local_date", "lon", "lat", "sensor", "platform", "daynight", "frp", "confidence",
               "type", "version", "source", "counted", "cell_x", "cell_y", "province_id", "regency_id")


@router.get("/detections.csv")
def detections_csv(area: Area = Depends(area_param), span: tuple[dt.date, dt.date] = Depends(period),
                   daynight: DayNight = "all", hotspots: Hotspots = "vegetation") -> StreamingResponse:
    """Raw detections of every satellite in an area and period, with provenance, as CSV.

    `source` is where the row came from (archive, standard product or near-real-time), and
    `counted` says whether the hotspot passes the selected hotspot type setting: with `vegetation`,
    a presumed vegetation fire (type 0, or an untyped near-real-time hotspot off the static-source
    mask); with `all`, every hotspot. Whether it enters the harmonised record also depends on its
    satellite being the record satellite of the day. Any period is accepted, and every matching
    row is sent. Rows are read and sorted one calendar month at a time and streamed as they are
    written, so memory stays at about one month of detections however long the period is."""
    cur = cursor()
    if not store.has(cur, "detections", "static_mask"):
        raise HTTPException(503, "Normalised detections are missing. Run `python -m app normalise` first.")
    cx, cy = cell_expr()
    half = {"all": "TRUE", "day": "c.daynight = 'D'", "night": "c.daynight = 'N'"}[daynight]
    counted = f"coalesce({qualifying_sql('c')}, FALSE)" if hotspots == "vegetation" else "TRUE"
    where = area.where(cur)

    def month_sql(a: dt.date, b: dt.date) -> str:
        return f"""
            SELECT strftime(c.acq_utc, '%Y-%m-%dT%H:%MZ'), c.local_date, c.lon, c.lat, c.sensor, c.platform,
                   c.daynight, round(CAST(c.frp AS DOUBLE), 2), c.confidence, c.type, c.version, c.source,
                   CAST({counted} AS VARCHAR), c.cx, c.cy, k.province_id, k.regency_id
            FROM (SELECT d.*, {cx} AS cx, {cy} AS cy FROM detections d
                  WHERE d.local_date BETWEEN DATE '{a}' AND DATE '{b}') c
            LEFT JOIN cells k ON k.cx = c.cx AND k.cy = c.cy
            LEFT JOIN static_mask m ON m.mx = CAST(floor(c.lon / {MASK_RES}) AS INTEGER)
                                   AND m.my = CAST(floor(c.lat / {MASK_RES}) AS INTEGER)
            WHERE {half} AND ({where})
            ORDER BY c.acq_utc, c.platform, c.lon, c.lat
        """

    def months() -> Iterator[tuple[dt.date, dt.date]]:
        a = span[0]
        while a <= span[1]:
            nxt = (a.replace(day=1) + dt.timedelta(days=32)).replace(day=1)
            yield a, min(span[1], nxt - dt.timedelta(days=1))
            a = nxt

    def lines() -> Iterator[str]:
        buf = io.StringIO()
        out = csv.writer(buf)
        out.writerow(CSV_COLUMNS)
        yield buf.getvalue()
        for a, b in months():
            res = cur.execute(month_sql(a, b))
            while chunk := res.fetchmany(5000):
                buf.seek(0)
                buf.truncate()
                out.writerows(chunk)
                yield buf.getvalue()

    name = f"detections_{span[0]}_{span[1]}.csv"
    return StreamingResponse(lines(), media_type="text/csv; charset=utf-8",
                             headers={"Content-Disposition": f'attachment; filename="{name}"'})
