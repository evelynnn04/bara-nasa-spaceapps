"""Monthly El Niño and Indian Ocean Dipole indices.

- ONI, the Oceanic Niño Index of NOAA CPC: 3-month running mean of ERSSTv5 sea surface temperature
  anomalies in the Niño 3.4 region. El Niño conditions at ONI >= +0.5 °C. Each 3-month season is
  stored on its middle month (DJF on January).
- DMI, the Dipole Mode Index of NOAA PSL (HadISST1): west minus east tropical Indian Ocean SST
  anomaly (Saji et al. 1999). Positive IOD at DMI >= +0.4 °C, the threshold of the Australian
  Bureau of Meteorology.

Both are public text files, no account. `climate.parquet` (month, oni, dmi).
"""

from __future__ import annotations

import datetime as dt
import logging

import numpy as np

from ..pipeline.download import _get
from . import grid, table_path

log = logging.getLogger("app.context.climate")

ONI_URL = "https://www.cpc.ncep.noaa.gov/data/indices/oni.ascii.txt"
DMI_URL = "https://psl.noaa.gov/gcos_wgsp/Timeseries/Data/dmi.had.long.data"
SEASONS = ("DJF", "JFM", "FMA", "MAM", "AMJ", "MJJ", "JJA", "JAS", "ASO", "SON", "OND", "NDJ")
MISSING = -99.0


def parse_oni(text: str) -> dict[dt.date, float]:
    """ONI anomaly per middle month of each season."""
    out = {}
    for line in text.splitlines()[1:]:
        parts = line.split()
        if len(parts) == 4 and parts[0] in SEASONS:
            out[dt.date(int(parts[1]), SEASONS.index(parts[0]) + 1, 1)] = float(parts[3])
    return out


def parse_dmi(text: str) -> dict[dt.date, float]:
    """DMI per month; the PSL missing value (-9999) is left out."""
    out = {}
    for line in text.splitlines():
        parts = line.split()
        if len(parts) == 13 and parts[0].isdigit():
            for m, v in enumerate(parts[1:], 1):
                if float(v) > -999:
                    out[dt.date(int(parts[0]), m, 1)] = float(v)
    return out


def run() -> None:
    """Downloads both indices and writes `climate.parquet` (always refreshed; they are tiny)."""
    oni = parse_oni(_get(ONI_URL).decode())
    dmi = parse_dmi(_get(DMI_URL).decode())
    months = sorted(set(oni) | set(dmi))
    n = grid.write_parquet(table_path("climate"), {
        "month": ("DATE", np.array([m.toordinal() for m in months])),
        "oni": ("FLOAT", np.array([oni.get(m, np.nan) for m in months])),
        "dmi": ("FLOAT", np.array([dmi.get(m, np.nan) for m in months])),
    })
    log.info("climate indices: %d months (ONI to %s, DMI to %s)", n, max(oni), max(dmi))
