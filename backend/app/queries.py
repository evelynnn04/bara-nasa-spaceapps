"""Daily and monthly statistics for an area, used by the region cache and the API.

Every number starts from one daily aggregation (`daily_sql`) of the observation relation through
the shared weight expression:

- `aqua_cd`: Aqua cell-days (MODIS weight);
- `aqua_px`: Aqua pixels;
- `viirs_w`: harmonised VIIRS-reference cell-days;
- `viirs_px`: VIIRS-reference pixels.

The harmonised record of a day is `aqua_cd` before the splice and `viirs_w` from it on, or no
value when the day's record satellite did not observe Indonesia. The agreement check sums the
same columns over paired days only.

There are two ways to get the daily rows for an area:

- the **fast path** sums the precomputed `region_daily` cache over named areas;
- the **general path** aggregates the cells of any area (for example a drawn polygon) on demand.

Tests keep the two equal.
"""

from __future__ import annotations

import datetime as dt
from collections import defaultdict

import duckdb

from . import config, geo
from .db import quote
from .geo import Ring
from .harmonise import metrics, weights

COLUMNS = ("aqua_cd", "aqua_px", "viirs_w", "viirs_px")


def daily_sql(daynight: str, where: str = "TRUE", group: str = "") -> str:
    """Daily sums of the four columns over observation rows matching `where` (aliases `c`, `d`,
    `k` of `observations_sql`), optionally also grouped by `group`, an expression over the
    observation relation `c`, exposed as `region_id`."""
    w = weights.weight_sql(daynight)
    n = weights.pixels_sql(daynight)
    gsel = f"{group} AS region_id, " if group else ""
    gby = f"{group}, " if group else ""
    return f"""
        SELECT {gsel}c.local_date,
               sum(CASE WHEN c.side = 'a' THEN {w} ELSE 0 END) AS aqua_cd,
               sum(CASE WHEN c.side = 'a' THEN {n} ELSE 0 END) AS aqua_px,
               sum(CASE WHEN c.side = 'b' THEN {w} ELSE 0 END) AS viirs_w,
               sum(CASE WHEN c.side = 'b' THEN {n} ELSE 0 END) AS viirs_px
        FROM ({weights.observations_sql(where)}) c
        GROUP BY {gby}c.local_date
    """


def area_parents(con: duckdb.DuckDBPyConnection) -> dict[str, str | None]:
    """Every selectable area id mapped to its parent id (`idn` has none).

    Areas come from the cell lookup table, plus any outline in the boundary file that holds no
    cell centre (a small city still has a valid, empty record)."""
    out: dict[str, str | None] = {"idn": None}
    for province, regency in con.execute(
            "SELECT DISTINCT province_id, regency_id FROM cells WHERE province_id IS NOT NULL").fetchall():
        out[province] = "idn"
        if regency is not None:
            out[regency] = province
    if config.boundaries_path().is_file():
        for b in geo.load_areas():
            out.setdefault(b[0], b[1])
    return out


def normalise_ids(ids: list[str], parents: dict[str, str | None]) -> list[str]:
    """Drops ids covered by a selected ancestor, so every cell is counted once. Every id must be
    a key of `parents` (see `area_parents`)."""
    wanted = set(ids)
    if "idn" in wanted:
        return ["idn"]
    return sorted(i for i in wanted if parents.get(i) not in wanted)


def area_filter(ids: list[str] | None = None, cells_table: str | None = None) -> str:
    """WHERE fragment selecting observation rows of named areas or of a table of cells."""
    if cells_table:
        return f"(c.cx, c.cy) IN (SELECT cx, cy FROM {cells_table})"
    if not ids or "idn" in ids:
        return "TRUE"
    listing = ", ".join(quote(i) for i in ids)
    return f"(k.province_id IN ({listing}) OR k.regency_id IN ({listing}))"


def polygon_cells(con: duckdb.DuckDBPyConnection, ring: Ring, name: str) -> int:
    """Creates temp table `name(cx, cy)` of the cells whose centre lies inside the polygon
    (even-odd ray casting over the polygon's edges, run in DuckDB). Returns the cell count."""
    edges = ", ".join(f"({x1!r}, {y1!r}, {x2!r}, {y2!r})"
                      for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]) if y1 != y2)
    if not edges:
        con.execute(f"CREATE OR REPLACE TEMP TABLE {name} (cx INTEGER, cy INTEGER)")
        return 0
    xs, ys = [p[0] for p in ring], [p[1] for p in ring]
    g = config.GRID
    con.execute(f"""
        CREATE OR REPLACE TEMP TABLE {name} AS
        WITH e(x1, y1, x2, y2) AS (VALUES {edges}),
        p AS (
            SELECT cx, cy, (cx + 0.5) * {g} AS x, (cy + 0.5) * {g} AS y FROM cells
            WHERE (cx + 0.5) * {g} BETWEEN {min(xs)} AND {max(xs)} AND (cy + 0.5) * {g} BETWEEN {min(ys)} AND {max(ys)}
        )
        SELECT cx, cy FROM p JOIN e ON (e.y1 > p.y) <> (e.y2 > p.y)
            AND p.x < (e.x2 - e.x1) * (p.y - e.y1) / (e.y2 - e.y1) + e.x1
        GROUP BY cx, cy HAVING count(*) % 2 = 1
    """)
    return con.execute(f"SELECT count(*) FROM {name}").fetchone()[0]


def daily_general(con: duckdb.DuckDBPyConnection, daynight: str, where: str) -> dict[dt.date, tuple]:
    """General path: daily sums for any area, straight from the cell-days."""
    rows = con.execute(f"SELECT local_date, {', '.join(COLUMNS)} FROM ({daily_sql(daynight, where)})").fetchall()
    return {r[0]: tuple(r[1:]) for r in rows}


def daily_cached(con: duckdb.DuckDBPyConnection, daynight: str, ids: list[str]) -> dict[dt.date, tuple]:
    """Fast path: daily sums for named areas from the region cache."""
    ids = ids or ["idn"]
    listing = ", ".join(quote(i) for i in ids)
    rows = con.execute(f"""
        SELECT local_date, {', '.join(f'sum({c})' for c in COLUMNS)} FROM region_daily
        WHERE daynight = {quote(daynight)} AND region_id IN ({listing}) GROUP BY local_date
    """).fetchall()
    return {r[0]: tuple(r[1:]) for r in rows}


def day_flags(con: duckdb.DuckDBPyConnection) -> list[tuple[dt.date, str | None, bool]]:
    """(day, record platform, paired) for every day from Aqua's start to the last data day."""
    return con.execute(f"""
        SELECT local_date, record_platform, aqua AND viirs_ref IS NOT NULL FROM days
        WHERE local_date >= DATE '{config.AQUA_START}' ORDER BY local_date
    """).fetchall()


def record_series(daily: dict[dt.date, tuple], flags: list[tuple]) -> list[float | None]:
    """Harmonised value per day in `flags` order: `None` when the record satellite did not observe."""
    out: list[float | None] = []
    for d, platform, _ in flags:
        if platform is None:
            out.append(None)
            continue
        v = daily.get(d)
        out.append(0.0 if v is None else v[0] if d < config.SPLICE else v[2])
    return out


def monthly_paired(daily: dict[dt.date, tuple], flags: list[tuple], start: dt.date, end: dt.date) -> dict:
    """Monthly sums over paired days: {(year, month): [aqua_cd, aqua_px, viirs_w, viirs_px]}."""
    out: dict[tuple[int, int], list[float]] = defaultdict(lambda: [0.0, 0.0, 0.0, 0.0])
    for d, _, paired in flags:
        if not paired or d < start or d > end:
            continue
        acc = out[(d.year, d.month)]
        v = daily.get(d)
        if v:
            for i in range(4):
                acc[i] += v[i]
    return dict(out)


def agreement(monthly: dict, harmonised: bool = True) -> dict:
    """Metrics and verdict for one area: MODIS cell-days against harmonised VIIRS, or raw pixels."""
    pairs = [(y, m, v[0], v[2]) if harmonised else (y, m, v[1], v[3]) for (y, m), v in sorted(monthly.items())]
    m = metrics.agreement(pairs)
    return {**metrics.rounded(m), "verdict": metrics.verdict(m)}
