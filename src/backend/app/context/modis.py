"""Yearly land cover from NASA MODIS MCD12Q1 v061 (Terra and Aqua, 500 m, IGBP classes).

Source: Friedl, M., Sulla-Menashe, D. (2022), MODIS/Terra+Aqua Land Cover Type Yearly L3 Global
500m SIN Grid V061, NASA LP DAAC, doi:10.5067/MODIS/MCD12Q1.061. Needs an Earthdata token. The
17 sinusoidal tiles over Indonesia take about 54 MB per year; layer `LC_Type1` holds the IGBP class.

Reduction: every pixel goes to the 0.05° cell holding its centre (the sinusoidal grid is equal-area,
so pixel counts are area shares). `modis/<year>.parquet` (cx, cy, year, n, <group>...) holds, per
context cell, the number of classified pixels `n` and the number in each class group of `GROUPS`
(about 145 pixels per cell). `context.layer_sql` divides them into shares.
"""

from __future__ import annotations

import logging
import re
from pathlib import Path

import numpy as np

from .. import config
from . import GROUPS, fetch, grid, piece_dir

log = logging.getLogger("app.context.modis")

SHORT_NAME, VERSION = "MCD12Q1", "061"
SDS = "LC_Type1"
FILL = 255
#: MODIS sinusoidal grid: sphere radius, tile side and pixels per tile side (MODIS Land grid).
R = 6371007.181
TILE = 1111950.5197665233
PIXELS = 2400
X0, Y0 = -20015109.355798, 10007554.677899

CLASSES = 18


def pixel_centres(h: int, v: int, n: int = PIXELS) -> tuple[np.ndarray, np.ndarray]:
    """(lon, lat) in degrees of the pixel centres of sinusoidal tile h, v as (n, n) arrays."""
    size = TILE / n
    x = X0 + h * TILE + (np.arange(n) + 0.5) * size
    y = Y0 - v * TILE - (np.arange(n) + 0.5) * size
    lat = y / R
    lon = x[None, :] / (R * np.cos(lat)[:, None])
    return np.degrees(lon), np.broadcast_to(np.degrees(lat)[:, None], (n, n))


def add_tile(acc: grid.Accumulator, classes: np.ndarray, h: int, v: int) -> None:
    """Adds one tile's class array to the per-cell class counts."""
    lon, lat = pixel_centres(h, v, classes.shape[0])
    idx = grid.cell_index(lon, lat)
    idx = np.where((classes == FILL) | (classes >= CLASSES), -1, idx)
    acc.add(idx.ravel(), cls=classes.ravel().astype(np.int64).clip(0, CLASSES - 1))


def read_tile(path: Path) -> np.ndarray:
    """The IGBP class array of one MCD12Q1 HDF4 file."""
    from pyhdf.SD import SD, SDC

    f = SD(str(path), SDC.READ)
    try:
        return f.select(SDS).get()
    finally:
        f.end()


def counts(acc: grid.Accumulator, year: int) -> dict[str, tuple[str, np.ndarray]]:
    """Columns cx, cy, year, n (classified pixels) and the pixel count of each class group."""
    cx, cy, sums = acc.cells()
    sums = sums.astype(np.int64)
    cols = {"cx": ("SMALLINT", cx), "cy": ("SMALLINT", cy), "year": ("SMALLINT", np.full(len(cx), year)),
            "n": ("USMALLINT", sums.sum(axis=1))}
    for name, classes in GROUPS.items():
        cols[name] = ("USMALLINT", sums[:, list(classes)].sum(axis=1))
    return cols


def year_path(year: int) -> Path:
    return piece_dir("modis") / f"{year}.parquet"


def run() -> None:
    """Downloads and reduces each year's tiles."""
    token = config.earthdata_token()
    by_year: dict[int, list[dict]] = {}
    for g in fetch.granules(SHORT_NAME, VERSION, bbox=config.INDONESIA_BBOX):
        by_year.setdefault(int(g["start"][:4]), []).append(g)
    for year, items in sorted(by_year.items()):
        if year_path(year).is_file():
            continue
        acc = grid.Accumulator(CLASSES)
        for g in items:
            hv = re.search(r"\.h(\d\d)v(\d\d)\.", g["url"])
            path = fetch.download(g["url"], fetch.raw_dir("modis") / Path(g["url"]).name, token=token)
            add_tile(acc, read_tile(path), int(hv.group(1)), int(hv.group(2)))
        n = grid.write_parquet(year_path(year), counts(acc, year))
        log.info("modis land cover %d: %d tiles, %d cells", year, len(items), n)
