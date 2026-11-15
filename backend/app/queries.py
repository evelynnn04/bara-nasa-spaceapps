"""Daily and monthly statistics for an area, used by the region cache and the API.

Every number starts from one daily aggregation (`daily_sql`) of the observation relation through
the shared weight expression, for one day/night filter and hotspot type setting:

- `aqua`: Aqua hotspots (an Aqua hotspot counts 1, so this is also its harmonised value);
- `viirs_w`: harmonised VIIRS-reference hotspots;
- `viirs_px`: raw VIIRS-reference hotspots.

The harmonised record of a day is `aqua` before the splice and `viirs_w` from it on, or no value
when the day's record satellite did not observe Indonesia. The agreement check sums the same
columns over paired days only.

There are two ways to get the daily rows for an area:

- the **fast path** sums the precomputed `region_daily` cache over named areas;
- the **general path** aggregates the cells of any area on demand;
- a **drawn polygon** takes the regencies wholly inside it from the cache and aggregates only the
  remaining cells.

Tests keep all three equal.
"""

from __future__ import annotations

import datetime as dt
from collections import defaultdict

import duckdb

from . import config, geo
from .db import quote
from .geo import Ring
from .harmonise import metrics, weights

COLUMNS = ("aqua", "viirs_w", "viirs_px")


def daily_sql(daynight: str, where: str = "TRUE", group: str = "", hotspots: str = "vegetation") -> str:
    """Daily sums of `COLUMNS` over observation rows matching `where` (aliases `c`, `d`, `k` of
    `observations_sql`), optionally also grouped by `group`, an expression over the observation
    relation `c`, exposed as `region_id`."""
    w = weights.weight_sql(daynight, hotspots)
    n = weights.hotspots_sql(daynight, hotspots)
    gsel = f"{group} AS region_id, " if group else ""
    gby = f"{group}, " if group else ""
    return f"""
        SELECT {gsel}c.local_date,
               sum(CASE WHEN c.side = 'a' THEN {n} ELSE 0 END) AS aqua,
               sum(CASE WHEN c.side = 'b' THEN {w} ELSE 0 END) AS viirs_w,
               sum(CASE WHEN c.side = 'b' THEN {n} ELSE 0 END) AS viirs_px
        FROM ({weights.observations_sql(where, hotspots)}) c
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


def daily_general(con: duckdb.DuckDBPyConnection, daynight: str, where: str,
                  hotspots: str = "vegetation") -> dict[dt.date, tuple]:
    """General path: daily sums for any area, straight from the cell-days."""
    sql = daily_sql(daynight, where, hotspots=hotspots)
    rows = con.execute(f"SELECT local_date, {', '.join(COLUMNS)} FROM ({sql})").fetchall()
    return {r[0]: tuple(r[1:]) for r in rows}


def daily_cached(con: duckdb.DuckDBPyConnection, daynight: str, ids: list[str],
                 hotspots: str = "vegetation") -> dict[dt.date, tuple]:
    """Fast path: daily sums for named areas from the region cache."""
    ids = ids or ["idn"]
    listing = ", ".join(quote(i) for i in ids)
    rows = con.execute(f"""
        SELECT local_date, {', '.join(f'sum({c})' for c in COLUMNS)} FROM region_daily
        WHERE hotspots = {quote(hotspots)} AND daynight = {quote(daynight)} AND region_id IN ({listing})
        GROUP BY local_date
    """).fetchall()
    return {r[0]: tuple(r[1:]) for r in rows}


#: A drawn area takes regencies from the cache only when it selects at least this many cells and
#: whole regencies hold at least this share of them. Below that, aggregating the cells directly is
#: as fast as checking which regencies are whole (measured on the full record).
REUSE_MIN_CELLS = 3000
REUSE_MIN_SHARE = 0.5


def contained_regencies(con: duckdb.DuckDBPyConnection, cells_table: str) -> tuple[list[str], int]:
    """Regencies whose every cell is in `cells_table` (their cached rows then equal their part of
    the selection exactly), and how many of the selected cells they hold."""
    rows = con.execute(f"""
        SELECT s.regency_id, s.n FROM (
            SELECT k.regency_id, count(*) AS n FROM {cells_table} t JOIN cells k USING (cx, cy)
            WHERE k.regency_id IS NOT NULL GROUP BY 1
        ) s JOIN regency_size z USING (regency_id)
        WHERE s.n = z.n ORDER BY 1
    """).fetchall()
    return [r[0] for r in rows], sum(r[1] for r in rows)


def daily_polygon(con: duckdb.DuckDBPyConnection, daynight: str, cells_table: str, n_cells: int,
                  hotspots: str = "vegetation") -> dict[dt.date, tuple]:
    """Daily sums for a drawn area given as a table of `n_cells` cells.

    For a large area, regencies lying wholly inside it are summed from the region cache and only
    the remaining cells are aggregated on demand. Both parts sum the same weights over disjoint
    sets of cells, so the result equals `daily_general` over the whole area."""
    inside = f"(c.cx, c.cy) IN (SELECT cx, cy FROM {cells_table})"
    if n_cells < REUSE_MIN_CELLS:
        return daily_general(con, daynight, inside, hotspots)
    full, covered = contained_regencies(con, cells_table)
    if not full or covered < REUSE_MIN_SHARE * n_cells:
        return daily_general(con, daynight, inside, hotspots)
    listing = ", ".join(quote(i) for i in full)
    out = daily_cached(con, daynight, full, hotspots)
    rest = daily_general(con, daynight, f"{inside} AND (k.regency_id IS NULL OR k.regency_id NOT IN ({listing}))",
                         hotspots)
    for d, v in rest.items():
        out[d] = tuple(a + b for a, b in zip(out[d], v)) if d in out else v
    return out


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
        out.append(0.0 if v is None else v[0] if d < config.SPLICE else v[1])
    return out


def monthly_paired(daily: dict[dt.date, tuple], flags: list[tuple], start: dt.date, end: dt.date) -> dict:
    """Monthly sums over paired days: {(year, month): [aqua, viirs_w, viirs_px]}."""
    out: dict[tuple[int, int], list[float]] = defaultdict(lambda: [0.0] * len(COLUMNS))
    for d, _, paired in flags:
        if not paired or d < start or d > end:
            continue
        acc = out[(d.year, d.month)]
        v = daily.get(d)
        if v:
            for i in range(len(COLUMNS)):
                acc[i] += v[i]
    return dict(out)


def agreement(monthly: dict, harmonised: bool = True) -> dict:
    """Metrics and verdict for one area: Aqua hotspots against harmonised VIIRS, or against raw VIIRS
    hotspots."""
    pairs = [(y, m, v[0], v[1] if harmonised else v[2]) for (y, m), v in sorted(monthly.items())]
    m = metrics.agreement(pairs)
    return {**metrics.rounded(m), "verdict": metrics.verdict(m)}
