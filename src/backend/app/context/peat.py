"""Peatland share of each cell from the CIFOR tropical and subtropical peatland map v2.1.

Source: Gumbricht, T. et al. (2017), An expert system model for mapping tropical wetlands and
peatlands reveals South America as the largest contributor, Global Change Biology 23, 3581-3599;
data doi:10.17528/CIFOR/DATA.00058 (CC BY 4.0, no account). About 0.0011° pixels, 1 = peat
(at least 30 cm of organic soil), 0 = not peat.

Reduction: a pixel goes to the cell holding its centre. `peat.parquet` (cx, cy, n, peat) holds, per
context cell with peat, the mapped pixels `n` (about 2,000) and the peat pixels among them;
`context.layer_sql` divides them into a share. Cells without peat are left out.
"""

from __future__ import annotations

import logging

import numpy as np

from .. import config
from . import fetch, grid, table_path

log = logging.getLogger("app.context.peat")

URL = "https://data.cifor-icraf.org/api/access/datafile/3261"
TIF = "TROP-SUBTROP_PeatV21_2016_CIFOR.tif"
ROWS = 512


def reduce(path) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """(cx, cy, mapped pixels, peat pixels) of every context cell with peat, reading the Indonesia
    window in strips."""
    import rasterio
    from rasterio.windows import Window, from_bounds

    acc = grid.Accumulator(2)
    with rasterio.open(path) as r:
        win = from_bounds(*config.INDONESIA_BBOX, r.transform).round_offsets().round_lengths()
        t = r.transform
        cols = win.col_off + np.arange(win.width)
        lon = t.c + (cols + 0.5) * t.a
        for row0 in range(win.row_off, win.row_off + win.height, ROWS):
            n = min(ROWS, win.row_off + win.height - row0)
            a = r.read(1, window=Window(win.col_off, row0, win.width, n))
            lat = t.f + (row0 + np.arange(n) + 0.5) * t.e
            valid = a <= 1
            idx = grid.cell_index(np.broadcast_to(lon, a.shape), np.broadcast_to(lat[:, None], a.shape))
            idx = np.where(valid, idx, -1)
            acc.add(idx.ravel(), cls=a.ravel().astype(np.int64).clip(0, 1))
    cx, cy, sums = acc.cells()
    sums = sums.astype(np.int64)
    keep = sums[:, 1] > 0
    return cx[keep], cy[keep], sums[keep].sum(axis=1), sums[keep, 1]


def run() -> None:
    """Downloads the map, writes `peat.parquet` and deletes the extracted copy (the archive stays)."""
    if table_path("peat").is_file():
        return
    import py7zr

    archive = fetch.download(URL, fetch.raw_dir("peat") / "TROP-SUBTROP_PeatV21_2016_CIFOR.7z")
    with py7zr.SevenZipFile(archive) as z:
        z.extract(fetch.raw_dir("peat"), targets=[TIF])
    tif = fetch.raw_dir("peat") / TIF
    cx, cy, n_px, peat_px = reduce(tif)
    n = grid.write_parquet(table_path("peat"), {"cx": ("SMALLINT", cx), "cy": ("SMALLINT", cy),
                                                "n": ("USMALLINT", n_px), "peat": ("USMALLINT", peat_px)})
    tif.unlink()
    log.info("peat: %d cells with peat", n)
