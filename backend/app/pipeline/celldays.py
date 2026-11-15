"""Cell-day table and day-status table.

`celldays.parquet`: one row per (sensor, platform, local day, 0.05° cell) holding the number of
qualifying pixels by day and by night, and their fire radiative power. A pixel qualifies when it is
a presumed vegetation fire (`type = 0`), or has no type yet (near-real-time) and does not fall on
the static-source mask. All confidence classes count; exact duplicates were removed earlier.

`days.parquet`: one row per local day saying which satellites observed Indonesia.

- VIIRS: a day without a single detection of any type is an outage.
- MODIS: genuinely quiet days exist, so only runs of `MODIS_GAP_RUN` or more empty days count
  as gaps.

It also names the VIIRS reference satellite of the day (S-NPP, else NOAA-20, else NOAA-21) and
the platform that supplies the harmonised record (Aqua before the splice, the VIIRS reference from
it on).
"""

from __future__ import annotations

import datetime as dt
import logging
from pathlib import Path

import duckdb

from .. import config
from ..db import quote
from .normalise import MASK_RES, detections_glob, static_mask_path

log = logging.getLogger("app.celldays")

MODIS_GAP_RUN = 3

PLATFORM_START = {
    "Terra": dt.date(2000, 11, 1),
    "Aqua": config.AQUA_START,
    "SNPP": config.STREAMS["viirs-snpp"].first_date,
    "NOAA20": config.STREAMS["viirs-noaa20"].first_date,
    "NOAA21": config.STREAMS["viirs-noaa21"].first_date,
}
PLATFORMS = tuple(PLATFORM_START)


def celldays_path() -> Path:
    return config.derived_dir() / "celldays.parquet"


def days_path() -> Path:
    return config.derived_dir() / "days.parquet"


def cell_expr(grid: float = config.GRID) -> tuple[str, str]:
    """SQL for the cell indices of a detection: floor(lon / grid), floor(lat / grid)."""
    g = f"CAST({grid!r} AS DOUBLE)"
    return f"CAST(floor(lon / {g}) AS INTEGER)", f"CAST(floor(lat / {g}) AS INTEGER)"


def qualifying_sql(alias: str = "d") -> str:
    """Condition for a qualifying pixel, given a LEFT JOIN of the static mask as `m`."""
    return f"({alias}.type = 0 OR ({alias}.type IS NULL AND m.mx IS NULL))"


def build_celldays(con: duckdb.DuckDBPyConnection, detections: str, mask: str, dest: Path) -> int:
    """Aggregates qualifying detections into cell-days; returns the row count."""
    cx, cy = cell_expr()
    dest.parent.mkdir(parents=True, exist_ok=True)
    con.execute(f"""
        COPY (
            SELECT d.sensor, d.platform, d.local_date, {cx} AS cx, {cy} AS cy,
                   CAST(count(*) FILTER (WHERE d.daynight = 'D') AS INTEGER) AS n_day,
                   CAST(count(*) FILTER (WHERE d.daynight = 'N') AS INTEGER) AS n_night,
                   sum(CASE WHEN d.frp > 0 THEN CAST(d.frp AS DOUBLE) ELSE 0 END) AS frp_sum,
                   max(CASE WHEN d.frp > 0 THEN CAST(d.frp AS DOUBLE) ELSE 0 END) AS frp_max
            FROM read_parquet({quote(detections)}) d
            LEFT JOIN read_parquet({quote(mask)}) m
              ON m.mx = CAST(floor(d.lon / {MASK_RES}) AS INTEGER) AND m.my = CAST(floor(d.lat / {MASK_RES}) AS INTEGER)
            WHERE {qualifying_sql()}
            GROUP BY ALL
            ORDER BY local_date, platform, cx, cy
        ) TO {quote(str(dest))} (FORMAT parquet, COMPRESSION zstd)
    """)
    return con.execute(f"SELECT count(*) FROM read_parquet({quote(str(dest))})").fetchone()[0]


def day_status(observed: dict[str, set[dt.date]], first: dt.date, last: dt.date) -> list[dict]:
    """Per-day observation flags, VIIRS reference and record platform, from the days each platform
    had any detection."""
    days = [first + dt.timedelta(days=i) for i in range((last - first).days + 1)]
    flags: dict[str, dict[dt.date, bool]] = {}
    for p in PLATFORMS:
        seen = observed.get(p, set())
        ok = {d: d >= PLATFORM_START[p] and d in seen for d in days}
        if p in ("Terra", "Aqua"):
            run: list[dt.date] = []
            for d in days + [None]:
                if d is not None and d >= PLATFORM_START[p] and not ok[d]:
                    run.append(d)
                    continue
                if 0 < len(run) < MODIS_GAP_RUN:
                    for q in run:
                        ok[q] = True
                run = []
        flags[p] = ok
    out = []
    for d in days:
        ref = next((p for p in config.VIIRS_REFERENCE_ORDER if flags[p][d]), None)
        if d < config.AQUA_START:
            record = None
        elif d < config.SPLICE:
            record = "Aqua" if flags["Aqua"][d] else None
        else:
            record = ref
        out.append({"local_date": d, **{p.lower(): flags[p][d] for p in PLATFORMS},
                    "viirs_ref": ref, "record_platform": record})
    return out


def build_days(con: duckdb.DuckDBPyConnection, detections: str, dest: Path) -> int:
    """Writes `days.parquet`; returns the number of days.

    The table ends on the latest UTC acquisition date. The local day after it has started in the
    east of the country but is only partly covered, so it is left out until the next download."""
    rows = con.execute(f"SELECT DISTINCT platform, local_date FROM read_parquet({quote(detections)})").fetchall()
    observed: dict[str, set[dt.date]] = {}
    for p, d in rows:
        observed.setdefault(p, set()).add(d)
    first = min(PLATFORM_START.values())
    last = con.execute(f"SELECT max(acq_date) FROM read_parquet({quote(detections)})").fetchone()[0]
    status = day_status(observed, first, last)
    cols = list(status[0])
    tmp = dest.with_suffix(".csv")
    dest.parent.mkdir(parents=True, exist_ok=True)
    with tmp.open("w") as f:
        f.write(",".join(cols) + "\n")
        for r in status:
            f.write(",".join("" if r[c] is None else str(r[c]).lower() if isinstance(r[c], bool) else str(r[c])
                             for c in cols) + "\n")
    kinds = {"local_date": "DATE", "viirs_ref": "VARCHAR", "record_platform": "VARCHAR"}
    types = ", ".join(f"'{c}': '{kinds.get(c, 'BOOLEAN')}'" for c in cols)
    con.execute(f"""
        COPY (SELECT * FROM read_csv({quote(str(tmp))}, header=true, columns={{{types}}}))
        TO {quote(str(dest))} (FORMAT parquet)
    """)
    tmp.unlink()
    return len(status)


def run() -> None:
    """Builds the cell-day and day-status tables from the normalised detections."""
    con = duckdb.connect()
    n = build_celldays(con, detections_glob(), str(static_mask_path()), celldays_path())
    log.info("cell-days: %d rows", n)
    log.info("days: %d", build_days(con, detections_glob(), days_path()))
