"""Binning of raster pixels into the 0.05° cells of the fire record, and the cells kept.

Every context layer is kept only on the **context cells**: cells that touch Indonesian land (any
part of the cell inside a province outline of `boundaries.geojson`), the ring of cells around them,
and every cell of the fire record (`cells.parquet`) outside that. Fire outside these cells is never
attributed, so nothing else is stored.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

import duckdb
import numpy as np

from .. import config
from ..db import quote

#: Cells of the record cover this box (config.INDONESIA_BBOX) as integer indices.
CX0 = int(np.floor(config.INDONESIA_BBOX[0] / config.GRID))
CY0 = int(np.floor(config.INDONESIA_BBOX[1] / config.GRID))
CX1 = int(np.floor(config.INDONESIA_BBOX[2] / config.GRID))
CY1 = int(np.floor(config.INDONESIA_BBOX[3] / config.GRID))
NX, NY = CX1 - CX0 + 1, CY1 - CY0 + 1
#: Parquet settings of every context table: zstd at a high level, since the tables are written once.
PARQUET = "FORMAT parquet, COMPRESSION zstd, COMPRESSION_LEVEL 19"


def cell_index(lon: np.ndarray, lat: np.ndarray) -> np.ndarray:
    """Flat index into the Indonesia cell box for pixel centres, or -1 outside it."""
    cx = np.floor(lon / config.GRID).astype(np.int64) - CX0
    cy = np.floor(lat / config.GRID).astype(np.int64) - CY0
    inside = (cx >= 0) & (cx < NX) & (cy >= 0) & (cy < NY)
    return np.where(inside, cy * NX + cx, -1)


@lru_cache(maxsize=1)
def kept() -> np.ndarray:
    """Flat boolean mask of the context cells over the Indonesia cell box (see module doc)."""
    from .. import geo

    raster, _ = geo.rasterise(geo.load_boundaries(), "province")
    k = round(config.GRID / raster.res)
    land = np.frombuffer(raster.cells, dtype=np.uint16).reshape(raster.height, raster.width) > 0
    ny, nx = raster.height // k, raster.width // k
    touch = land[: ny * k, : nx * k].reshape(ny, k, nx, k).any(axis=(1, 3))
    oy, ox = round((raster.south / config.GRID)) - CY0, round((raster.west / config.GRID)) - CX0
    mask = np.zeros((NY, NX), dtype=bool)
    mask[oy:oy + ny, ox:ox + nx] = touch
    ring = mask.copy()
    ring[1:, :] |= mask[:-1, :]
    ring[:-1, :] |= mask[1:, :]
    ring[:, 1:] |= mask[:, :-1]
    ring[:, :-1] |= mask[:, 1:]
    ring[1:, 1:] |= mask[:-1, :-1]
    ring[:-1, :-1] |= mask[1:, 1:]
    ring[1:, :-1] |= mask[:-1, 1:]
    ring[:-1, 1:] |= mask[1:, :-1]
    cells = config.derived_dir() / "cells.parquet"
    if cells.is_file():
        for cx, cy in duckdb.execute(f"SELECT cx, cy FROM read_parquet({quote(str(cells))})").fetchall():
            if 0 <= cx - CX0 < NX and 0 <= cy - CY0 < NY:
                ring[cy - CY0, cx - CX0] = True
    return ring.ravel()


def keep(cx: np.ndarray, cy: np.ndarray) -> np.ndarray:
    """Whether each cell (cx, cy) is a context cell."""
    i, j = np.asarray(cx) - CX0, np.asarray(cy) - CY0
    inside = (i >= 0) & (i < NX) & (j >= 0) & (j < NY)
    out = np.zeros(i.shape, dtype=bool)
    out[inside] = kept()[j[inside] * NX + i[inside]]
    return out


class Accumulator:
    """Per-cell sums of pixel counts, per class when `classes` is given."""

    def __init__(self, classes: int = 1):
        self.classes = classes
        self.sums = np.zeros((NY * NX, classes), dtype=np.float64)

    def add(self, idx: np.ndarray, cls: np.ndarray | None = None, weight: np.ndarray | None = None) -> None:
        """Adds pixels with flat cell index `idx` (-1 skipped), class `cls` and `weight` (default 1)."""
        ok = idx >= 0
        flat = idx[ok] * self.classes + (cls[ok] if cls is not None else 0)
        w = weight[ok] if weight is not None else None
        self.sums += np.bincount(flat, weights=w, minlength=self.sums.size).reshape(self.sums.shape)

    def cells(self) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """(cx, cy, sums) of every context cell with at least one pixel, ordered by cy then cx."""
        nz = np.nonzero((self.sums.sum(axis=1) > 0) & kept())[0]
        return nz % NX + CX0, nz // NX + CY0, self.sums[nz]


def write_parquet(dest: Path, columns: dict[str, tuple[str, np.ndarray]]) -> int:
    """Writes equal-length arrays as a Parquet table; `columns` maps name to (DuckDB type, values).
    DATE values are proleptic ordinals (`date.toordinal()`); NaN becomes NULL. Returns the row
    count."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(".csv")
    names = list(columns)
    arrays = [np.asarray(columns[n][1]) for n in names]
    fmt = ["%d" if a.dtype.kind in "iub" else "%.6g" for a in arrays]
    with tmp.open("w") as f:
        f.write(",".join(names) + "\n")
        if len(arrays[0]):
            np.savetxt(f, np.column_stack([a.astype(np.float64) for a in arrays]), fmt=fmt, delimiter=",")
    types = ", ".join(f"'{n}': '{'BIGINT' if columns[n][0] == 'DATE' else columns[n][0]}'" for n in names)
    select = ", ".join(f"DATE '0001-01-01' + CAST({n} - 1 AS INTEGER) AS {n}" if columns[n][0] == "DATE" else n
                       for n in names)
    duckdb.execute(f"COPY (SELECT {select} FROM read_csv({quote(str(tmp))}, header=true, nullstr='nan', "
                   f"columns={{{types}}})) TO {quote(str(dest))} ({PARQUET})")
    tmp.unlink()
    return len(arrays[0])
