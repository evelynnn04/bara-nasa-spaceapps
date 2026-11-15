"""Region cache: daily statistics for the country, every province and every city/regency.

`region_daily.parquet` holds, for each hotspot type setting, day/night filter and area, the daily
sums described in `app.queries` (only days with hotspots are stored). The API sums these rows for
any selection of named areas; a drawn polygon reuses them for the regencies wholly inside it.
"""

from __future__ import annotations

import logging
from pathlib import Path

from .. import config, store
from ..db import quote
from ..harmonise import weights
from ..queries import COLUMNS, daily_sql

log = logging.getLogger("app.aggregate")

#: Area level -> lookup column (None: every cell belongs to the country).
LEVELS = {"country": None, "province": "province_id", "regency": "regency_id"}


def region_daily_path() -> Path:
    return config.derived_dir() / "region_daily.parquet"


def build(con, dest: Path) -> int:
    """Writes the cache using connection `con` (with factors registered); returns its row count."""
    parts = []
    for hotspots in weights.HOTSPOTS:
        for daynight in weights.DAYNIGHT:
            for level, col in LEVELS.items():
                where = f"k.{col} IS NOT NULL" if col else "TRUE"
                expr = f"c.{col}" if col else "'idn'"
                parts.append(f"SELECT '{hotspots}' AS hotspots, '{daynight}' AS daynight, '{level}' AS level, "
                             f"region_id, local_date, {', '.join(COLUMNS)} "
                             f"FROM ({daily_sql(daynight, where, expr, hotspots)})")
    dest.parent.mkdir(parents=True, exist_ok=True)
    con.execute(f"""
        COPY ({' UNION ALL '.join(parts)} ORDER BY hotspots, daynight, region_id, local_date)
        TO {quote(str(dest))} (FORMAT parquet, COMPRESSION zstd)
    """)
    return con.execute(f"SELECT count(*) FROM read_parquet({quote(str(dest))})").fetchone()[0]


def run() -> None:
    """Rebuilds the region cache with the fitted factors."""
    con = store.connect(weights.load_params())
    log.info("region cache: %d rows", build(con, region_daily_path()))
