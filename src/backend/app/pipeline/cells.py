"""Cell lookup: island group, province and city/regency of every active 0.05° cell.

The fit and every query read the island group from this one table, so a cell always gets the
same factor.

- **Island group:** the province whose outline contains the cell centre
  `((cx + 0.5) * 0.05, (cy + 0.5) * 0.05)`, else the nearest province within 0.3°, else `Other`.
- **Area membership** (what the dashboard's area picker sums): the city/regency containing the
  centre, else the nearest within 0.3°, with its province as parent. Every cell belongs to at most
  one city/regency, so summing a selection never counts a cell twice. Cells with no city/regency
  belong to the country only.
"""

from __future__ import annotations

import logging
from pathlib import Path

import duckdb

from .. import config, geo
from ..db import quote
from ..harmonise.regions import NEAREST_MAX_DEG, group_of
from .celldays import celldays_path

log = logging.getLogger("app.cells")


def cells_path() -> Path:
    return config.derived_dir() / "cells.parquet"


class CellLocator:
    """Looks up the island group, province and city/regency of grid cells."""

    def __init__(self, boundaries: list[geo.Boundary] | None = None):
        boundaries = boundaries or geo.load_boundaries()
        self.provinces, self.province_items = geo.rasterise(boundaries, "province")
        self.regencies, self.regency_items = geo.rasterise(boundaries, "regency")

    def locate(self, cx: int, cy: int) -> tuple[str, str | None, str | None]:
        """(island group, province id, city/regency id) of one cell."""
        lon, lat = (cx + 0.5) * config.GRID, (cy + 0.5) * config.GRID
        p = self.provinces.at(lon, lat) or self.provinces.nearest(lon, lat, NEAREST_MAX_DEG)
        group = group_of(self.province_items[p - 1].name) if p else "Other"
        r = self.regencies.at(lon, lat) or self.regencies.nearest(lon, lat, NEAREST_MAX_DEG)
        if not r:
            return group, None, None
        regency = self.regency_items[r - 1]
        return group, regency.parent_id, regency.id


def build(con: duckdb.DuckDBPyConnection, celldays: str, dest: Path, locator: CellLocator | None = None) -> int:
    """Writes the lookup for every cell in the cell-day table; returns the cell count."""
    locator = locator or CellLocator()
    pairs = con.execute(f"SELECT DISTINCT cx, cy FROM read_parquet({quote(celldays)}) ORDER BY 1, 2").fetchall()
    tmp = dest.with_suffix(".csv")
    dest.parent.mkdir(parents=True, exist_ok=True)
    with tmp.open("w") as f:
        f.write("cx,cy,island_group,province_id,regency_id\n")
        for cx, cy in pairs:
            group, prov, reg = locator.locate(cx, cy)
            f.write(f"{cx},{cy},{group},{prov or ''},{reg or ''}\n")
    con.execute(f"""
        COPY (SELECT * FROM read_csv({quote(str(tmp))}, header=true,
              columns={{'cx': 'INTEGER', 'cy': 'INTEGER', 'island_group': 'VARCHAR',
                        'province_id': 'VARCHAR', 'regency_id': 'VARCHAR'}}))
        TO {quote(str(dest))} (FORMAT parquet)
    """)
    tmp.unlink()
    return len(pairs)


def run() -> None:
    """Builds `cells.parquet` from the cell-day table."""
    con = duckdb.connect()
    n = build(con, str(celldays_path()), cells_path())
    summary = con.execute(f"SELECT island_group, count(*) FROM read_parquet({quote(str(cells_path()))}) "
                          "GROUP BY 1 ORDER BY 2 DESC").fetchall()
    log.info("cells: %d (%s)", n, ", ".join(f"{g} {c}" for g, c in summary))
