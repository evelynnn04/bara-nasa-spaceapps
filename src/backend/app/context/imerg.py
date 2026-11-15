"""Monthly rainfall from NASA GPM IMERG Final Precipitation L3 monthly 0.1° V07 (GPM_3IMERGM).

Source: Huffman, G. J. et al. (2023), GPM IMERG Final Precipitation L3 1 month 0.1 degree x 0.1
degree V07, NASA GES DISC, doi:10.5067/GPM/IMERG/3B-MONTH/07. Needs an Earthdata token and the GES
DISC data agreement accepted on the account. One HDF5 file of about 18 MB per month from January
1998; `Grid/precipitation` is the mean rate in mm/h.

Reduction: `imerg/<YYYY-MM>.parquet` (rx, ry, month, rain) with the mean rate in hundredths of
mm/day (`RAIN_SCALE`) of every 0.1° cell holding a context cell. A 0.1° cell (rx, ry) holds the
0.05° cells (2rx..2rx+1, 2ry..2ry+1), since both grids start at 0°.
"""

from __future__ import annotations

import datetime as dt
import logging
from pathlib import Path

import numpy as np

from .. import config
from . import RAIN_SCALE, fetch, grid, piece_dir

log = logging.getLogger("app.context.imerg")

SHORT_NAME, VERSION = "GPM_3IMERGM", "07"
RES = 0.1


def _sub(path: Path, var: str) -> np.ndarray:
    import rasterio

    with rasterio.open(f'HDF5:"{path}"://Grid/{var}') as r:
        return r.read()


def read_month(path: Path) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """(rx, ry, mm/day) of every 0.1° cell in the Indonesia box from one monthly file. The axis
    order is taken from the file's own `lon` and `lat` arrays."""
    try:
        lon = _sub(path, "lon").ravel()
        lat = _sub(path, "lat").ravel()
    except Exception:  # GDAL may not open 1-D arrays; fall back to the documented global 0.1° grid.
        lon = -179.95 + RES * np.arange(3600)
        lat = -89.95 + RES * np.arange(1800)
    p = np.squeeze(_sub(path, "precipitation"))
    if p.shape == (len(lat), len(lon)):
        p = p.T
    assert p.shape == (len(lon), len(lat)), f"unexpected IMERG shape {p.shape}"
    west, south, east, north = config.INDONESIA_BBOX
    i = np.nonzero((lon >= west) & (lon <= east))[0]
    j = np.nonzero((lat >= south) & (lat <= north))[0]
    sub = p[np.ix_(i, j)].astype(np.float64)
    rx = np.floor(lon[i] / RES + 1e-6).astype(np.int64)
    ry = np.floor(lat[j] / RES + 1e-6).astype(np.int64)
    RX, RY = np.meshgrid(rx, ry, indexing="ij")
    ok = sub >= 0
    return RX[ok], RY[ok], sub[ok] * 24


def wanted(rx: np.ndarray, ry: np.ndarray) -> np.ndarray:
    """Whether each 0.1° cell holds at least one context cell."""
    out = np.zeros(rx.shape, dtype=bool)
    for dx in (0, 1):
        for dy in (0, 1):
            out |= grid.keep(2 * rx + dx, 2 * ry + dy)
    return out


def month_path(month: str) -> Path:
    return piece_dir("imerg") / f"{month}.parquet"


def write_month(dest: Path, month: str, rx: np.ndarray, ry: np.ndarray, rain: np.ndarray) -> int:
    """Writes one month's rain on the 0.1° cells holding context cells; returns the cell count."""
    sel = wanted(rx, ry)
    rx, ry, rain = rx[sel], ry[sel], rain[sel]
    order = np.lexsort((rx, ry))
    first = dt.date(int(month[:4]), int(month[5:7]), 1).toordinal()
    return grid.write_parquet(dest, {
        "rx": ("SMALLINT", rx[order]), "ry": ("SMALLINT", ry[order]),
        "month": ("DATE", np.full(len(rx), first)),
        "rain": ("USMALLINT", np.rint(rain[order] * RAIN_SCALE).astype(np.int64)),
    })


def run() -> None:
    """Downloads and reduces each monthly file."""
    token = config.earthdata_token()
    for g in fetch.granules(SHORT_NAME, VERSION):
        month = g["start"][:7]
        if month_path(month).is_file():
            continue
        path = fetch.download(g["url"], fetch.raw_dir("imerg") / Path(g["url"]).name, token=token)
        n = write_month(month_path(month), month, *read_month(path))
        log.info("imerg %s: %d cells", month, n)
