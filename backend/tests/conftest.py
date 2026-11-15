"""Synthetic derived tables for tests: a few cells, days and cell-days written as Parquet."""

from __future__ import annotations

import datetime as dt
import math
from pathlib import Path

import duckdb
import pytest

from app import store
from app.db import quote
from app.harmonise.regions import GROUPS

#: Reference factors of the vegetation fit, used by the worked example: base factor, island group and
#: month multipliers per half of the day.
REF_BASE = {"day": 5.937, "night": 17.558}
REF_REGION = {
    "day": {"Sumatra": 0.896, "Kalimantan": 0.824, "Java-Bali-NT": 1.534, "Sulawesi-Maluku": 1.106, "Papua": 0.950,
            "Other": 1.0},
    "night": {"Sumatra": 0.880, "Kalimantan": 0.843, "Java-Bali-NT": 1.461, "Sulawesi-Maluku": 1.270, "Papua": 0.983,
              "Other": 1.0},
}
REF_MONTH = {
    "day": dict(enumerate([1.033, 1.145, 1.187, 0.953, 0.912, 0.992, 0.886, 0.954, 1.049, 1.183, 1.140, 1.017], 1)),
    "night": dict(enumerate([1.070, 0.940, 0.944, 1.077, 1.095, 1.068, 1.096, 1.146, 1.044, 1.188, 1.127, 1.046], 1)),
}
#: FRP factor used for every stratum in the reference parameters.
REF_KF = 2.0


def ref_k(half: str, region: str, month: int) -> float:
    """Reference factor of one half of the day, island group and month."""
    return REF_BASE[half] * REF_REGION[half][region] * REF_MONTH[half][month]


def reference_params() -> dict:
    """Parameters holding the reference factors for both type settings, in the shape `params.json`
    has."""
    return {"k_table": [{"hotspots": h, "region": g, "month": m, "k_day": ref_k("day", g, m),
                         "k_night": ref_k("night", g, m), "kf_day": REF_KF, "kf_night": REF_KF}
                        for h in ("vegetation", "all") for g in GROUPS for m in range(1, 13)]}


def write_table(con: duckdb.DuckDBPyConnection, path: Path, columns: dict[str, str], rows: list[tuple]) -> None:
    """Writes rows to Parquet with the given column types."""
    cols = ", ".join(f"{name} {kind}" for name, kind in columns.items())
    con.execute(f"CREATE OR REPLACE TEMP TABLE t ({cols})")
    if rows:
        con.executemany(f"INSERT INTO t VALUES ({', '.join('?' * len(columns))})", rows)
    con.execute(f"COPY t TO {quote(str(path))} (FORMAT parquet)")


#: Columns of the compact cell-day rows tests write: vegetation counts and FRP, then optionally the
#: day and night hotspots of other types.
CELLDAY_COLS = {"sensor": "VARCHAR", "platform": "VARCHAR", "local_date": "DATE", "cx": "INTEGER", "cy": "INTEGER",
                "n_day": "INTEGER", "n_night": "INTEGER", "frp_sum": "DOUBLE", "frp_max": "DOUBLE",
                "other_day": "INTEGER", "other_night": "INTEGER"}
DAY_COLS = {"local_date": "DATE", "terra": "BOOLEAN", "aqua": "BOOLEAN", "snpp": "BOOLEAN", "noaa20": "BOOLEAN",
            "noaa21": "BOOLEAN", "viirs_ref": "VARCHAR", "record_platform": "VARCHAR"}
CELL_COLS = {"cx": "INTEGER", "cy": "INTEGER", "island_group": "VARCHAR", "province_id": "VARCHAR",
             "regency_id": "VARCHAR"}


def write_dataset(root: Path, celldays: list[tuple], days: list[tuple], cells: list[tuple]) -> Path:
    """Writes `celldays`, `days` and `cells` Parquet files under `root`.

    Cell-day rows are compact: `(sensor, platform, day, cx, cy, n_day, n_night, frp_sum, frp_max)`,
    optionally followed by `(other_day, other_night)`, hotspots of other types. The FRP is split into
    day and night in proportion to the hotspots, and the `all` columns add the other hotspots (with
    1 MW each) to the vegetation ones."""
    root.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect()
    path = store.table_path("celldays", root)
    write_table(con, path, CELLDAY_COLS, [tuple(r) + (0, 0) * (len(r) == 9) for r in celldays])
    share = "CASE WHEN n_day + n_night > 0 THEN frp_sum * {} / (n_day + n_night) ELSE 0 END"
    con.execute(f"""
        COPY (SELECT sensor, platform, local_date, cx, cy, n_day, n_night,
                     n_day + other_day AS n_day_all, n_night + other_night AS n_night_all,
                     {share.format("n_day")} AS frp_day, {share.format("n_night")} AS frp_night,
                     {share.format("n_day")} + other_day AS frp_day_all,
                     {share.format("n_night")} + other_night AS frp_night_all, frp_max,
                     greatest(frp_max, CASE WHEN other_day + other_night > 0 THEN 1.0 ELSE 0 END) AS frp_max_all
              FROM t) TO {quote(str(path))} (FORMAT parquet)
    """)
    write_table(con, store.table_path("days", root), DAY_COLS, days)
    write_table(con, store.table_path("cells", root), CELL_COLS, cells)
    return root


def day_row(d: dt.date, aqua: bool = True, snpp: bool = True, noaa20: bool = False) -> tuple:
    ref = "SNPP" if snpp else "NOAA20" if noaa20 else None
    record = ("Aqua" if aqua else None) if d < dt.date(2012, 2, 1) else ref
    return (d, True, aqua, snpp, noaa20, False, ref, record)


#: Cell in Riau (Sumatra) and one in Bali (Java-Bali-NT).
RIAU = (2020, 10, "Sumatra", "idn-riau", "idn-riau-a")
BALI = (2303, -168, "Java-Bali-NT", "idn-bali", "idn-bali-a")


@pytest.fixture
def worked_example(tmp_path: Path) -> Path:
    """One fire in Riau on 10 Sep 2015, in one cell: 2 Aqua hotspots by day and 1 at night, and 7
    S-NPP hotspots by day and 3 at night, plus 4 S-NPP daytime hotspots of another type."""
    d = dt.date(2015, 9, 10)
    celldays = [("modis", "Aqua", d, 2020, 10, 2, 1, 30.0, 20.0),
                ("viirs", "SNPP", d, 2020, 10, 7, 3, 50.0, 8.0, 4, 0)]
    return write_dataset(tmp_path, celldays, [day_row(d)], [RIAU])
