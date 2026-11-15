"""DuckDB connection over the derived Parquet tables, shared by the fit, the cache and the API."""

from __future__ import annotations

from pathlib import Path

import duckdb

from . import config
from .db import quote
from .harmonise import weights
from .harmonise.regions import GROUPS
from .pipeline.normalise import detections_dir, detections_glob, static_mask_path

TABLES = ("celldays", "days", "cells", "region_daily", "events")


def table_path(name: str, root: Path | None = None) -> Path:
    return (root or config.derived_dir()) / f"{name}.parquet"


def unit_params() -> dict:
    """Parameters with every factor 1, so `weight_sql` and `frp_sql` give raw VIIRS values."""
    return {"k_table": [{"hotspots": h, "region": g, "month": m, "k_day": 1.0, "k_night": 1.0,
                         "kf_day": 1.0, "kf_night": 1.0}
                        for h in weights.HOTSPOTS for g in GROUPS for m in range(1, 13)]}


def connect(params: dict | None = None, root: Path | None = None) -> duckdb.DuckDBPyConnection:
    """In-memory DuckDB with a view per derived table that exists, plus table `factor`.

    With the default `root`, views `detections` (normalised detections) and `static_mask` are added
    when those files exist, and table `regency_size` (cells per regency) when `cells` does.
    Cursors of the connection share the views and tables."""
    con = duckdb.connect()
    for name in TABLES:
        path = table_path(name, root)
        if path.is_file():
            con.execute(f"CREATE VIEW {name} AS SELECT * FROM read_parquet({quote(str(path))})")
    if root is None:
        if any(detections_dir().glob("*.parquet")):
            con.execute(f"CREATE VIEW detections AS SELECT * FROM read_parquet({quote(detections_glob())})")
        if static_mask_path().is_file():
            con.execute(f"CREATE VIEW static_mask AS SELECT * FROM read_parquet({quote(str(static_mask_path()))})")
    if has(con, "cells"):
        con.execute("CREATE TABLE regency_size AS SELECT regency_id, count(*) AS n FROM cells "
                    "WHERE regency_id IS NOT NULL GROUP BY 1")
    weights.register_factors(con, params or unit_params())
    return con


def has(con: duckdb.DuckDBPyConnection, *names: str) -> bool:
    """Whether every named view or table exists on the connection."""
    found = {r[0] for r in con.execute("SELECT table_name FROM information_schema.tables").fetchall()}
    return set(names) <= found


def has_columns(con: duckdb.DuckDBPyConnection, table: str, *columns: str) -> bool:
    """Whether the named view or table has every given column."""
    found = {r[0] for r in con.execute("SELECT column_name FROM information_schema.columns WHERE table_name = ?",
                                       [table]).fetchall()}
    return set(columns) <= found
