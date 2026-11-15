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

#: Reference factors used by the worked example.
REF_MU = math.log(6.509)
REF_REGION = {"Sumatra": 0.930, "Kalimantan": 0.842, "Java-Bali-NT": 1.582, "Sulawesi-Maluku": 1.152,
              "Papua": 0.858, "Other": 1.0}
REF_MONTH = {1: 1.033, 2: 1.096, 3: 1.131, 4: 0.965, 5: 0.960, 6: 0.955, 7: 0.905, 8: 0.936, 9: 1.007,
             10: 1.142, 11: 1.112, 12: 1.032}


def reference_params() -> dict:
    """Parameters holding the reference factors, in the shape `params.json` has."""
    return {"k_table": [{"region": g, "month": m, "k": 6.509 * REF_REGION[g] * REF_MONTH[m]}
                        for g in GROUPS for m in range(1, 13)]}


def write_table(con: duckdb.DuckDBPyConnection, path: Path, columns: dict[str, str], rows: list[tuple]) -> None:
    """Writes rows to Parquet with the given column types."""
    cols = ", ".join(f"{name} {kind}" for name, kind in columns.items())
    con.execute(f"CREATE OR REPLACE TEMP TABLE t ({cols})")
    if rows:
        con.executemany(f"INSERT INTO t VALUES ({', '.join('?' * len(columns))})", rows)
    con.execute(f"COPY t TO {quote(str(path))} (FORMAT parquet)")


CELLDAY_COLS = {"sensor": "VARCHAR", "platform": "VARCHAR", "local_date": "DATE", "cx": "INTEGER", "cy": "INTEGER",
                "n_day": "INTEGER", "n_night": "INTEGER", "frp_sum": "DOUBLE", "frp_max": "DOUBLE"}
DAY_COLS = {"local_date": "DATE", "terra": "BOOLEAN", "aqua": "BOOLEAN", "snpp": "BOOLEAN", "noaa20": "BOOLEAN",
            "noaa21": "BOOLEAN", "viirs_ref": "VARCHAR", "record_platform": "VARCHAR"}
CELL_COLS = {"cx": "INTEGER", "cy": "INTEGER", "island_group": "VARCHAR", "province_id": "VARCHAR",
             "regency_id": "VARCHAR"}


def write_dataset(root: Path, celldays: list[tuple], days: list[tuple], cells: list[tuple]) -> Path:
    """Writes `celldays`, `days` and `cells` Parquet files under `root`."""
    root.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect()
    write_table(con, store.table_path("celldays", root), CELLDAY_COLS, celldays)
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
    """One fire in Riau on 10 Sep 2015: 1 Aqua pixel and 7 S-NPP pixels in one cell."""
    d = dt.date(2015, 9, 10)
    celldays = [("modis", "Aqua", d, 2020, 10, 1, 0, 20.0, 20.0),
                ("viirs", "SNPP", d, 2020, 10, 5, 2, 30.0, 8.0)]
    return write_dataset(tmp_path, celldays, [day_row(d)], [RIAU])
