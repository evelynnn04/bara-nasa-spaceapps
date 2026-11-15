"""HTTP API over the harmonised fire record.

Every endpoint takes the same area selection:

- `area`: comma-separated area ids (`idn`, a province or a city/regency), summed without counting
  any cell twice; or
- `poly`: a drawn polygon as `lon,lat;lon,lat;...`, which selects the cells whose centre lies
  inside it.

`daynight` is `all`, `day` or `night`. Values are in MODIS-equivalent active fire cell-days (see
`docs/harmonisation.md`). A day the record's satellite did not observe is `null`, never 0.

Named areas are answered from the region cache; a polygon is aggregated from its cells on demand.
Both paths build their numbers from the same weight expression.
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

from . import config, geo, queries, store
from .db import quote
from .harmonise import fit, weights
from .pipeline.celldays import cell_expr, qualifying_sql
from .pipeline.normalise import MASK_RES

router = APIRouter(prefix="/api")

DayNight = Literal["all", "day", "night"]

#: Above this many active cells the map layer is delivered on a coarser grid.
MAX_MAP_CELLS = 20000
#: Grid cells per side of a coarse block (0.25°), also used for the most active block.
COARSE = 5
MAX_CSV_DAYS = 366
MAX_CSV_ROWS = 200_000
AREA_ID = re.compile(r"^idn(-[a-z0-9]+)*$")

_lock = threading.Lock()
_state: dict = {}


REQUIRED = ("celldays", "days", "cells", "region_daily")


def configure(con: duckdb.DuckDBPyConnection | None, params: dict | None) -> None:
    """Sets the connection and parameters the endpoints use (tests pass synthetic ones)."""
    with _lock:
        _state.clear()
        if con is not None:
            _state.update(con=con, params=params, complete=store.has(con, *REQUIRED))
        _daily.cache_clear()
        _flags.cache_clear()
        _parents.cache_clear()


def _ready() -> dict:
    """The shared connection and parameters, opened on first use.

    Whether the derived tables exist is checked once, when the connection is opened; a missing
    table closes it again so the next request retries."""
    with _lock:
        if not _state:
            try:
                params = weights.load_params()
            except RuntimeError as err:
                raise HTTPException(503, str(err)) from err
            con = store.connect(params)
            _state.update(con=con, params=params, complete=store.has(con, *REQUIRED))
        if not _state["complete"]:
            con = _state.pop("con")
            _state.clear()
            con.close()
            raise HTTPException(503, "The derived tables are missing. Run `python -m app all` first.")
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
def _daily(area: Area, daynight: str) -> dict[dt.date, tuple]:
    """Daily sums for an area: the region cache for named areas, the cell path for a polygon."""
    cur = cursor()
    if area.ring is None:
        return queries.daily_cached(cur, daynight, list(area.ids))
    return queries.daily_general(cur, daynight, area.where(cur))


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
    ev = p.get("evaluation", {})
    return {
        "record": {"start": flags[0][0], "end": flags[-1][0], "splice": config.SPLICE,
                   "unobserved_days": sum(1 for f in flags if f[1] is None)},
        "last_observed": last,
        "unit": fit.UNIT,
        "grid_deg": config.GRID,
        "method": {
            "summary": "Fire activity is counted in grid cells per day. A VIIRS cell counts the square root of "
                       "its pixels divided by an island-group and month factor; a MODIS cell counts once.",
            "alpha": p.get("alpha"), "base_factor": p.get("base_factor"),
            "region_factor": p.get("region_factor"), "month_factor": p.get("month_factor"),
            "fit_window": p.get("fit_window"), "fitted": p.get("fitted"),
        },
        "verdict": p.get("verdict"),
        "evaluation": {
            "leave_one_year_out": ev.get("leave_one_year_out", {}).get("national"),
            "island_groups": ev.get("leave_one_year_out", {}).get("island_groups"),
            "split_even_train_odd_test": ev.get("split_even_train_odd_test"),
            "control_snpp_vs_noaa20": ev.get("control_snpp_vs_noaa20"),
            "story_2015": ev.get("story_2015"),
        },
        "distribution": p.get("distribution"),
    }


@router.get("/series")
def series(area: Area = Depends(area_param), daynight: DayNight = "all") -> dict:
    """The daily harmonised record of an area over the whole record, one value per day from `start`."""
    flags = _flags()
    values = queries.record_series(_daily(area, daynight), flags)
    return {"start": flags[0][0], "end": flags[-1][0], "unit": fit.UNIT, "daynight": daynight,
            "values": [_fmt(v) for v in values]}


@router.get("/cells")
def cells(area: Area = Depends(area_param), span: tuple[dt.date, dt.date] = Depends(period),
          daynight: DayNight = "all") -> dict:
    """Active cells of the harmonised record in a period, for the map.

    Each cell carries its harmonised value, the raw pixels of each sensor and its highest pixel
    fire radiative power. Above `MAX_MAP_CELLS` cells the layer is summed onto 0.25° blocks. `top`
    is the most active 0.25° block and the city/regency holding most of it."""
    cur = cursor()
    w, n = weights.weight_sql(daynight), weights.pixels_sql(daynight)
    where = f"c.local_date BETWEEN DATE '{span[0]}' AND DATE '{span[1]}' AND ({area.where(cur)})"
    rows = cur.execute(f"""
        SELECT c.cx, c.cy,
               sum(CASE WHEN c.platform = c.record_platform THEN {w} ELSE 0 END) AS value,
               sum(CASE WHEN c.side = 'a' THEN {n} ELSE 0 END) AS modis_px,
               sum(CASE WHEN c.side = 'b' THEN {n} ELSE 0 END) AS viirs_px,
               max(CASE WHEN c.platform = c.record_platform AND {n} > 0 THEN c.frp_max END) AS frp_max,
               any_value(c.regency_id) AS regency_id
        FROM ({weights.observations_sql(where)}) c
        GROUP BY c.cx, c.cy HAVING value > 0
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
        out = [(bx, by, b[0], b[1], b[2], b[3]) for (bx, by), b in blocks.items()]
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


@router.get("/agreement")
def agreement(area: Area = Depends(area_param), daynight: DayNight = "all") -> dict:
    """MODIS against VIIRS for an area, month by month, on paired days only.

    Paired days are days both Aqua and the VIIRS reference satellite observed Indonesia. `months`
    runs from the splice to the last data day. The metrics and verdicts cover the fit window, once
    for the harmonised values and once for raw pixel counts."""
    flags = _flags()
    start, end = config.SPLICE, flags[-1][0]
    monthly = queries.monthly_paired(_daily(area, daynight), flags, start, end)
    paired_days: dict[tuple[int, int], int] = defaultdict(int)
    for d, _, paired in flags:
        if paired and start <= d <= end:
            paired_days[(d.year, d.month)] += 1
    window = {k: v for k, v in monthly.items() if config.FIT_START <= dt.date(k[0], k[1], 1) <= config.FIT_END}
    return {
        "unit": fit.UNIT, "daynight": daynight,
        "window": [config.FIT_START, config.FIT_END],
        "months": [{"year": y, "month": m, "paired_days": paired_days[(y, m)],
                    "modis": _fmt(v[0]), "viirs": _fmt(v[2]), "modis_px": int(v[1]), "viirs_px": int(v[3])}
                   for (y, m), v in sorted(monthly.items())],
        "harmonised": queries.agreement(window, harmonised=True),
        "raw": queries.agreement(window, harmonised=False),
    }


EVENT_COLUMNS = ("event", "start", "end", "duration_days", "peak_day", "cells", "cell_days", "harmonised",
                 "pixels", "frp_max", "lon", "lat", "west", "south", "east", "north", "regency_id", "province_id")


@router.get("/events")
def events(area: Area = Depends(area_param), span: tuple[dt.date, dt.date] = Depends(period),
           limit: int = Query(5, ge=1, le=50)) -> dict:
    """The largest fire events active in a period, by harmonised cell-days.

    An event groups active cell-days whose cells touch and whose days are at most one day apart.
    Its descriptors cover the whole event, also the part outside the requested period. A named area
    selects events that lie mostly inside it; a polygon selects events whose centre it contains."""
    cur = cursor()
    if not store.has(cur, "events"):
        raise HTTPException(503, "Fire events are missing. Run `python -m app cache` first.")
    where = [f"start <= DATE '{span[1]}'", f"\"end\" >= DATE '{span[0]}'"]
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
    return {"unit": fit.UNIT, "events": out}


CSV_COLUMNS = ("acq_utc", "local_date", "lon", "lat", "sensor", "platform", "daynight", "frp", "confidence",
               "type", "version", "source", "counted", "cell_x", "cell_y", "province_id", "regency_id")


@router.get("/detections.csv")
def detections_csv(area: Area = Depends(area_param), span: tuple[dt.date, dt.date] = Depends(period),
                   daynight: DayNight = "all") -> StreamingResponse:
    """Raw detections of every satellite in an area and period, with provenance, as CSV.

    `source` is where the row came from (archive, standard product or near-real-time), and
    `counted` says whether the pixel qualifies for the harmonised record (a presumed vegetation
    fire, or an untyped near-real-time pixel off the static-source mask). At most `MAX_CSV_DAYS`
    days per request. Only the first `MAX_CSV_ROWS` rows are sent; header `X-Total-Rows` gives the
    number that matched."""
    cur = cursor()
    if not store.has(cur, "detections", "static_mask"):
        raise HTTPException(503, "Normalised detections are missing. Run `python -m app normalise` first.")
    if (span[1] - span[0]).days + 1 > MAX_CSV_DAYS:
        raise HTTPException(400, f"the period may cover at most {MAX_CSV_DAYS} days")
    cx, cy = cell_expr()
    half = {"all": "TRUE", "day": "c.daynight = 'D'", "night": "c.daynight = 'N'"}[daynight]
    source = f"""
        FROM (SELECT d.*, {cx} AS cx, {cy} AS cy FROM detections d
              WHERE d.local_date BETWEEN DATE '{span[0]}' AND DATE '{span[1]}') c
        LEFT JOIN cells k ON k.cx = c.cx AND k.cy = c.cy
        LEFT JOIN static_mask m ON m.mx = CAST(floor(c.lon / {MASK_RES}) AS INTEGER)
                               AND m.my = CAST(floor(c.lat / {MASK_RES}) AS INTEGER)
        WHERE {half} AND ({area.where(cur)})
    """
    res = cur.execute(f"""
        SELECT strftime(c.acq_utc, '%Y-%m-%dT%H:%MZ'), c.local_date, c.lon, c.lat, c.sensor, c.platform,
               c.daynight, round(CAST(c.frp AS DOUBLE), 2), c.confidence, c.type, c.version, c.source,
               CAST(coalesce({qualifying_sql('c')}, FALSE) AS VARCHAR), c.cx, c.cy, k.province_id, k.regency_id,
               count(*) OVER () AS total
        {source}
        ORDER BY c.acq_utc, c.platform, c.lon, c.lat
        LIMIT {MAX_CSV_ROWS}
    """)
    first = res.fetchmany(5000)
    total = first[0][-1] if first else 0

    def lines() -> Iterator[str]:
        buf = io.StringIO()
        out = csv.writer(buf)
        out.writerow(CSV_COLUMNS)
        chunk = first
        while True:
            yield buf.getvalue()
            buf.seek(0)
            buf.truncate()
            if not chunk:
                return
            out.writerows(row[:-1] for row in chunk)
            chunk = res.fetchmany(5000)

    name = f"detections_{span[0]}_{span[1]}.csv"
    return StreamingResponse(lines(), media_type="text/csv; charset=utf-8",
                             headers={"Content-Disposition": f'attachment; filename="{name}"',
                                      "X-Total-Rows": str(total), "X-Row-Limit": str(MAX_CSV_ROWS),
                                      "Access-Control-Expose-Headers": "X-Total-Rows, X-Row-Limit"})
