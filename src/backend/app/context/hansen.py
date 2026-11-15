"""Tree cover in 2000 and yearly forest loss from Hansen et al. Global Forest Change v1.12.

Source: Hansen, M. C. et al. (2013), High-resolution global maps of 21st-century forest cover
change, Science 342, 850-853, updated to 2024 (v1.12). 1 arc-second (about 30 m) Landsat tiles of
10° x 10°, public, no account. Loss year 1-24 means loss in 2001-2024.

Reduction per 0.05° cell (exactly 200 x 200 pixels, since the tiles start on whole degrees), one
file `hansen/<tile>.parquet` per tile with columns (cx, cy, year, px):

- `year` 0: `px` pixels of the cell with tree canopy cover of at least `CANOPY_MIN` % in 2000, the
  forest definition Global Forest Watch uses with this dataset;
- `year` 2001-2024: `px` pixels of such forest lost in that year.

Pixel counts are exact; `context.layer_sql` divides them by the 40,000 pixels of a cell. Only
context cells with forest, and years with loss, are written.
"""

from __future__ import annotations

import logging
from pathlib import Path

import duckdb
import numpy as np

from .. import config
from ..db import quote
from . import CANOPY_MIN, HANSEN_LAST_YEAR, fetch, grid, piece_dir

log = logging.getLogger("app.context.hansen")

VERSION = "GFC-2024-v1.12"
URL = "https://storage.googleapis.com/earthenginepartners-hansen/{v}/Hansen_{v}_{layer}_{tile}.tif"
LAST_YEAR = HANSEN_LAST_YEAR
#: Pixels per cell side: 0.05° / 0.00025°.
PX = 200
TILE_DEG = 10


def tile_name(top: int, left: int) -> str:
    """Tile name from its top latitude and left longitude, e.g. `00N_100E`, `10S_120E`."""
    return f"{abs(top):02d}{'N' if top >= 0 else 'S'}_{abs(left):03d}{'E' if left >= 0 else 'W'}"


def tiles() -> list[tuple[int, int]]:
    """(top, left) of the tiles holding cells of the fire record (all Indonesia tiles when the cell
    lookup is missing)."""
    west, south, east, north = config.INDONESIA_BBOX
    every = [(top, left) for top in range(int(np.ceil(north / TILE_DEG)) * TILE_DEG, int(south), -TILE_DEG)
             for left in range(int(west // TILE_DEG) * TILE_DEG, int(east), TILE_DEG)]
    cells = config.derived_dir() / "cells.parquet"
    if not cells.is_file():
        return every
    used = set(duckdb.execute(
        f"SELECT DISTINCT CAST(ceil((cy + 1) * {config.GRID} / {TILE_DEG} - 1e-9) AS INT) * {TILE_DEG}, "
        f"CAST(floor(cx * {config.GRID} / {TILE_DEG} + 1e-9) AS INT) * {TILE_DEG} "
        f"FROM read_parquet({quote(str(cells))})").fetchall())
    return [t for t in every if t in used]


def reduce_tile(cover: Path, lossyear: Path, top: int, left: int) -> tuple[np.ndarray, ...]:
    """(cx, cy, forest pixels, loss pixels[cell, year 0..LAST_YEAR-2000]) of every cell of one tile
    pair. Loss year 0 means no loss."""
    import rasterio
    from rasterio.windows import Window

    with rasterio.open(cover) as a, rasterio.open(lossyear) as b:
        n = a.width // PX
        years = LAST_YEAR - 2000 + 1
        forest = np.zeros((n, n), dtype=np.int64)
        loss = np.zeros((n, n, years), dtype=np.int64)
        col_cell = (np.arange(a.width) // PX)[None, :] * years
        for i in range(n):
            win = Window(0, i * PX, a.width, PX)
            f = a.read(1, window=win) >= CANOPY_MIN
            ly = b.read(1, window=win).astype(np.int64)
            forest[i] = f.reshape(PX, n, PX).sum(axis=(0, 2))
            key = np.broadcast_to(col_cell, ly.shape) + np.minimum(ly, years - 1)
            loss[i] = np.bincount(key[f], minlength=n * years).reshape(n, years)
    cy0 = round(top / config.GRID) - 1
    cx0 = round(left / config.GRID)
    rows, cols = np.meshgrid(np.arange(n), np.arange(n), indexing="ij")
    return (cx0 + cols).ravel(), (cy0 - rows).ravel(), forest.ravel(), loss.reshape(n * n, years)


def tile_path(top: int, left: int) -> Path:
    return piece_dir("hansen") / f"{tile_name(top, left)}.parquet"


def write_tile(dest: Path, cx: np.ndarray, cy: np.ndarray, forest: np.ndarray, loss: np.ndarray) -> int:
    """Writes one tile's forest and loss pixel counts on its context cells with forest; returns the
    cell count."""
    keep = (forest > 0) & grid.keep(cx, cy)
    cells = np.repeat(np.nonzero(keep)[0], loss.shape[1])
    yrs = np.tile(np.arange(loss.shape[1]), keep.sum())
    vals = loss[keep].ravel()
    lost = (vals > 0) & (yrs > 0)
    grid.write_parquet(dest, {
        "cx": ("SMALLINT", np.concatenate([cx[keep], cx[cells][lost]])),
        "cy": ("SMALLINT", np.concatenate([cy[keep], cy[cells][lost]])),
        "year": ("SMALLINT", np.concatenate([np.zeros(keep.sum(), int), 2000 + yrs[lost]])),
        "px": ("USMALLINT", np.concatenate([forest[keep], vals[lost]])),
    })
    return int(keep.sum())


def run() -> None:
    """Downloads and reduces each tile pair."""
    todo = [(top, left) for top, left in tiles() if not tile_path(top, left).is_file()]
    layers = ("treecover2000", "lossyear")
    files = fetch.download_many((URL.format(v=VERSION, layer=layer, tile=tile_name(top, left)),
                                 fetch.raw_dir("hansen") / f"{layer}_{tile_name(top, left)}.tif")
                                for top, left in todo for layer in layers)
    for top, left in todo:
        cover, loss = next(files), next(files)
        n = write_tile(tile_path(top, left), *reduce_tile(cover, loss, top, left))
        log.info("hansen %s: %d cells with forest", tile_name(top, left), n)
