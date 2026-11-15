"""Paths, data sources and fixed dates shared by the pipeline, the fit and the API."""

from __future__ import annotations

import datetime as dt
import os
from dataclasses import dataclass
from pathlib import Path



def repo_dir(backend: Path) -> Path:
    """Repository root for a backend folder: two levels up in a checkout (`src/backend`), or the
    folder's parent when there is no second level, as in the Docker image where the backend is `/app`."""
    return backend.parents[1] if len(backend.parents) > 1 else backend.parent


BACKEND_DIR = Path(__file__).resolve().parents[1]
REPO_DIR = repo_dir(BACKEND_DIR)

#: Side of one harmonisation grid cell, in degrees.
GRID = 0.05

#: Aqua's first day of observation. Before it the MODIS record is Terra only.
AQUA_START = dt.date(2002, 7, 4)
#: The harmonised record uses Aqua MODIS before this day and the VIIRS reference satellite from it.
SPLICE = dt.date(2012, 2, 1)
#: Overlap used to fit and evaluate the VIIRS factors.
FIT_START = dt.date(2012, 2, 1)
FIT_END = dt.date(2025, 12, 31)
#: VIIRS satellites in order of preference for the reference record.
VIIRS_REFERENCE_ORDER = ("SNPP", "NOAA20", "NOAA21")

FIRMS_BASE = "https://firms.modaps.eosdis.nasa.gov"
ARCHIVE_URL = FIRMS_BASE + "/data/country/zips/{name}_{year}_Indonesia.csv"
AREA_URL = FIRMS_BASE + "/api/area/csv/{key}/{source}/{bbox}/{days}/{date}"
AVAILABILITY_URL = FIRMS_BASE + "/api/data_availability/csv/{key}/ALL"
#: The area API accepts at most this many days per request.
API_MAX_DAYS = 5
#: west, south, east, north. Wider than Indonesia so the clip, not the box, decides membership.
INDONESIA_BBOX = (94.5, -11.5, 141.5, 6.5)


@dataclass(frozen=True)
class Stream:
    """One FIRMS product family."""

    key: str
    sensor: str
    platforms: tuple[str, ...]
    #: Name in the country archive URL, or None when FIRMS does not publish one.
    archive_name: str | None
    first_year: int
    api_sp: str
    api_nrt: str
    first_date: dt.date


STREAMS: dict[str, Stream] = {
    s.key: s
    for s in (
        Stream("modis", "modis", ("Terra", "Aqua"), "modis", 2000, "MODIS_SP", "MODIS_NRT", dt.date(2000, 11, 1)),
        Stream("viirs-snpp", "viirs", ("SNPP",), "viirs-snpp", 2012, "VIIRS_SNPP_SP", "VIIRS_SNPP_NRT",
               dt.date(2012, 1, 20)),
        Stream("viirs-noaa20", "viirs", ("NOAA20",), "viirs-jpss1", 2018, "VIIRS_NOAA20_SP", "VIIRS_NOAA20_NRT",
               dt.date(2018, 4, 1)),
        Stream("viirs-noaa21", "viirs", ("NOAA21",), None, 2023, "VIIRS_NOAA21_SP", "VIIRS_NOAA21_NRT",
               dt.date(2023, 3, 1)),
    )
}

#: Satellite codes found in FIRMS files, mapped to platform names.
SATELLITE_CODES = {
    "Terra": "Terra", "T": "Terra",
    "Aqua": "Aqua", "A": "Aqua",
    "N": "SNPP", "SNPP": "SNPP",
    "N20": "NOAA20", "1": "NOAA20", "J1": "NOAA20",
    "N21": "NOAA21", "2": "NOAA21", "J2": "NOAA21",
}

#: MODIS integer confidence (0-100) split into the VIIRS classes.
MODIS_LOW_BELOW = 30
MODIS_HIGH_ABOVE = 80


def data_dir() -> Path:
    """Root of the local data cache (`DATA_DIR`, default `<repo>/data`)."""
    return Path(os.environ.get("DATA_DIR") or REPO_DIR / "data")


def raw_dir() -> Path:
    return data_dir() / "raw"


def parquet_dir() -> Path:
    return data_dir() / "parquet"


def derived_dir() -> Path:
    return data_dir() / "derived"


def boundaries_path() -> Path:
    """Country, province and city/regency outlines shared with the dashboard."""
    return Path(os.environ.get("BOUNDARIES_PATH") or REPO_DIR / "src" / "frontend" / "public" / "boundaries.geojson")


def params_path() -> Path:
    """Fitted harmonisation parameters, written by `python -m app fit`."""
    return Path(__file__).resolve().parent / "harmonise" / "params.json"


def context_dir() -> Path:
    """Environmental context layers reduced to the 0.05° grid (land cover, forest loss, peat,
    rainfall, climate indices), written by `python -m app context`."""
    return data_dir() / "context"


def _secret(var: str) -> str:
    """A secret from the environment or the repository `.env`, or "" when unset. Never logged."""
    value = os.environ.get(var, "").strip()
    if not value:
        env = REPO_DIR / ".env"
        if env.is_file():
            for line in env.read_text(encoding="utf-8").splitlines():
                name, _, v = line.partition("=")
                if name.strip() == var:
                    value = v.strip().strip('"').strip("'")
    return value


def map_key() -> str:
    """FIRMS map key from the environment or the repository `.env`. Never logged."""
    key = _secret("FIRMS_MAP_KEY")
    if not key:
        raise RuntimeError("FIRMS_MAP_KEY is not set. Add it to .env (see .env.example).")
    return key


def earthdata_token() -> str:
    """NASA Earthdata login token (https://urs.earthdata.nasa.gov, "Generate Token") from the
    environment or the repository `.env`. Only the MODIS land cover and GPM IMERG rainfall downloads
    of `python -m app context` use it. Never logged."""
    token = _secret("EARTHDATA_TOKEN")
    if not token:
        raise RuntimeError("EARTHDATA_TOKEN is not set. Add it to .env (see .env.example).")
    return token
