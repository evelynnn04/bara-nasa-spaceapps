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
    """Parameters with every factor 1, so `weight_sql` gives raw sqrt(n) for VIIRS."""
    return {"k_table": [{"region": g, "month": m, "k": 1.0} for g in GROUPS for m in range(1, 13)]}


def connect(params: dict | None = None, root: Path | None = None) -> duckdb.DuckDBPyConnection:
    """In-memory DuckDB with a view per derived table that exists, plus table `factor`.

    With the default `root`, views `detections` (normalised detections) and `static_mask` are added
    when those files exist. Cursors of the connection share the views and the factor table."""
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
    weights.register_factors(con, params or unit_params())
    return con


def has(con: duckdb.DuckDBPyConnection, *names: str) -> bool:
    """Whether every named view or table exists on the connection."""
    found = {r[0] for r in con.execute("SELECT table_name FROM information_schema.tables").fetchall()}
    return set(names) <= found
