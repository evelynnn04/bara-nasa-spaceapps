"""Environmental context for fire cause attribution, reduced to the 0.05° grid of the fire record.

Each source is downloaded as published into `data/raw/context/<source>/` (kept, so a reduction can
be rerun offline) and reduced into small Parquet files under `data/context/`. Re-running skips every
piece already reduced, and every download already on disk. How each source is reduced, and why the
result is small, is described in docs/attribution.md ("How the context data is reduced").

| Layer | Source | Files in `data/context/` |
|---|---|---|
| Tree cover in 2000, forest loss per year | Hansen et al. Global Forest Change v1.12 (Landsat) | `hansen/<tile>.parquet` |
| Land cover per year (IGBP) | NASA MODIS MCD12Q1 v061 | `modis/<year>.parquet` |
| Peatland | CIFOR tropical peatland map v2.1 (Gumbricht et al. 2017) | `peat.parquet` |
| Monthly rainfall, 0.1° | NASA GPM IMERG Final monthly V07 (GPM_3IMERGM) | `imerg/<YYYY-MM>.parquet` |
| El Niño (ONI) and Indian Ocean Dipole (DMI) | NOAA CPC and NOAA PSL | `climate.parquet` |

The files hold integer pixel counts (or fixed-point values) on the context cells only;
`layer_sql` turns them into the shares and rates the attribution reads. MODIS land cover and IMERG
need an Earthdata token (`EARTHDATA_TOKEN`); the other sources need no account.
"""

from __future__ import annotations

import logging
from pathlib import Path

from .. import config
from ..db import quote

log = logging.getLogger("app.context")

SOURCES = ("hansen", "peat", "modis", "imerg", "climate")
#: Pixels of one Hansen tile per 0.05° cell (200 x 200).
HANSEN_CELL_PX = 40000
#: IMERG rainfall is stored in hundredths of mm/day.
RAIN_SCALE = 100
#: Last year of Hansen forest loss, and the canopy cover (%) that counts as tree cover in 2000.
HANSEN_LAST_YEAR = 2024
CANOPY_MIN = 30
#: IGBP classes of MODIS LC_Type1 grouped for attribution.
GROUPS: dict[str, tuple[int, ...]] = {
    "forest": (1, 2, 3, 4, 5),
    "shrub_savanna": (6, 7, 8, 9),
    "grassland": (10,),
    "wetland": (11,),
    "cropland": (12,),
    "urban": (13,),
    "mosaic": (14,),
    "other": (15, 16, 17),
}


def table_path(name: str, root: Path | None = None) -> Path:
    """A single-file layer (`peat`, `climate`)."""
    return (root or config.context_dir()) / f"{name}.parquet"


def piece_dir(source: str, root: Path | None = None) -> Path:
    """Folder of a layer stored in pieces (`hansen` per tile, `modis` per year, `imerg` per month)."""
    return (root or config.context_dir()) / source


def layer_sql(root: Path | None = None) -> dict[str, str]:
    """SQL of every context layer present under `root` (default `data/context`), in the units the
    attribution reads:

    - `forest` (cx, cy, forest2000) and `forest_loss` (cx, cy, year, loss): shares of the cell;
    - `landcover` (cx, cy, year, <group shares>): shares of the cell's classified pixels;
    - `peat` (cx, cy, peat): share of the cell's mapped pixels;
    - `rain` (rx, ry, month, rain): mm/day on the 0.1° grid;
    - `climate` (month, oni, dmi)."""
    out = {}

    def glob(source: str) -> str | None:
        d = piece_dir(source, root)
        return quote(str(d / "*.parquet")) if d.is_dir() and any(d.glob("*.parquet")) else None

    if g := glob("hansen"):
        out["forest"] = f"SELECT cx, cy, px / {HANSEN_CELL_PX} AS forest2000 FROM read_parquet({g}) WHERE year = 0"
        out["forest_loss"] = (f"SELECT cx, cy, year, px / {HANSEN_CELL_PX} AS loss FROM read_parquet({g}) "
                              "WHERE year > 0")
    if g := glob("modis"):
        shares = ", ".join(f"{k} / n AS {k}" for k in GROUPS)
        out["landcover"] = f"SELECT cx, cy, year, {shares} FROM read_parquet({g})"
    if (p := table_path("peat", root)).is_file():
        out["peat"] = f"SELECT cx, cy, peat / n AS peat FROM read_parquet({quote(str(p))})"
    if g := glob("imerg"):
        out["rain"] = f"SELECT rx, ry, month, rain / {RAIN_SCALE} AS rain FROM read_parquet({g})"
    if (p := table_path("climate", root)).is_file():
        out["climate"] = f"SELECT month, oni, dmi FROM read_parquet({quote(str(p))})"
    return out


def run(sources: tuple[str, ...] = SOURCES) -> None:
    """Downloads and reduces the named sources."""
    from . import climate, hansen, imerg, modis, peat
    modules = {"hansen": hansen, "peat": peat, "modis": modis, "imerg": imerg, "climate": climate}
    for name in sources:
        log.info("context %s ...", name)
        modules[name].run()
