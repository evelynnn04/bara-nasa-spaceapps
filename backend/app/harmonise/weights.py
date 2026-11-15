"""The harmonisation weights and the relations they are applied to, written once.

Unit: hotspots, Aqua MODIS-equivalent.

- An Aqua MODIS hotspot counts 1.
- A VIIRS hotspot counts `1 / k_d[island group, month]`, where `d` is its half of the day. Per
  cell-day that is `n_day / k_day + n_night / k_night`, with the hotspot counts from the day's
  reference satellite.

With a day or night filter only that half is counted, on both sides. The "all" view is the sum of
the two halves, each divided by its own factor.

Fire radiative power is harmonised the same way: Aqua FRP as it is, VIIRS FRP divided by
`kf_d[island group, month]`, again per half of the day.

Two hotspot type settings exist, each with its own fitted factors: `vegetation` (presumed
vegetation fires, the default) and `all` (every hotspot type).

Every path that turns cell-days into numbers (the fit, the region cache, the API series, map,
agreement check, events and anomaly scores) builds its SQL from `weight_sql`, `hotspots_sql` and
`frp_sql`, so they cannot drift apart.
"""

from __future__ import annotations

import datetime as dt
import json
from pathlib import Path

import duckdb

from .. import config
from ..db import quote

DAYNIGHT = {"all": (True, True), "day": (True, False), "night": (False, True)}
#: Hotspot type settings -> suffix of their columns in the cell-day table.
HOTSPOTS = {"vegetation": "", "all": "_all"}
HALVES = ("day", "night")


def _halves(daynight: str, hotspots: str, c: str, prefix: str) -> list[tuple[str, str]]:
    """(cell-day column, half) pairs selected by the day/night filter, for columns
    `{prefix}_{half}{suffix}`."""
    day, night = DAYNIGHT[daynight]
    sfx = HOTSPOTS[hotspots]
    return [(f"{c}.{prefix}_{half}{sfx}", half) for half, on in (("day", day), ("night", night)) if on]


def hotspots_sql(daynight: str = "all", hotspots: str = "vegetation", c: str = "c") -> str:
    """Raw hotspot count of a cell-day under the day/night filter and type setting."""
    return "(" + " + ".join(col for col, _ in _halves(daynight, hotspots, c, "n")) + ")"


def weight_sql(daynight: str = "all", hotspots: str = "vegetation", c: str = "c", raw: bool = False) -> str:
    """Harmonised hotspots of a cell-day over relation `c`, which carries the factors as columns
    `k_day` and `k_night` (as `observations_sql` does). With `raw`, VIIRS hotspots count 1 like
    Aqua's."""
    n = hotspots_sql(daynight, hotspots, c)
    if raw:
        return f"CAST({n} AS DOUBLE)"
    viirs = " + ".join(f"{col} / {c}.k_{half}" for col, half in _halves(daynight, hotspots, c, "n"))
    return f"CASE WHEN {c}.sensor = 'modis' THEN CAST({n} AS DOUBLE) ELSE {viirs} END"


def frp_sql(daynight: str = "all", hotspots: str = "vegetation", c: str = "c", raw: bool = False) -> str:
    """Harmonised fire radiative power of a cell-day (MODIS-equivalent MW): Aqua FRP as it is,
    VIIRS FRP of each half divided by that half's FRP factor (`kf_day`, `kf_night`). NULL when no
    FRP factors were fitted. With `raw`, VIIRS FRP is left as it is."""
    parts = _halves(daynight, hotspots, c, "frp")
    total = " + ".join(col for col, _ in parts)
    if raw:
        return f"({total})"
    viirs = " + ".join(f"{col} / {c}.kf_{half}" for col, half in parts)
    return f"CASE WHEN {c}.sensor = 'modis' THEN {total} ELSE {viirs} END"


def load_params(path: Path | None = None) -> dict:
    """The fitted parameters written by `python -m app fit`."""
    path = path or config.params_path()
    if not path.is_file():
        raise RuntimeError(f"{path} is missing. Run `python -m app fit` first.")
    return json.loads(path.read_text(encoding="utf-8"))


def register_factors(con: duckdb.DuckDBPyConnection, params: dict) -> None:
    """Creates table `factor(hotspots, region, month, k_day, k_night, kf_day, kf_night)` from the
    fitted parameters, one row per type setting, island group and month. The FRP factors are NULL
    when the parameters have none."""
    def num(v) -> str:
        return "NULL" if v is None else repr(float(v))

    rows = ", ".join(f"({quote(r['hotspots'])}, {quote(r['region'])}, {int(r['month'])}, {num(r['k_day'])}, "
                     f"{num(r['k_night'])}, {num(r.get('kf_day'))}, {num(r.get('kf_night'))})"
                     for r in params["k_table"])
    con.execute(f"""
        CREATE OR REPLACE TABLE factor AS
        SELECT hotspots, region, month, k_day, k_night, CAST(kf_day AS DOUBLE) AS kf_day,
               CAST(kf_night AS DOUBLE) AS kf_night
        FROM (VALUES {rows}) AS t(hotspots, region, month, k_day, k_night, kf_day, kf_night)
    """)


def observations_sql(where: str = "TRUE", hotspots: str = "vegetation") -> str:
    """Aqua cell-days and the day's VIIRS-reference cell-days, with cell lookup and the factors of
    the type setting.

    Column `side` is 'a' (Aqua) or 'b' (VIIRS reference), and the day's flags come along
    (`aqua`, `viirs_ref`, `record_platform`). Needs relations `celldays`, `days`, `cells` and
    `factor`."""
    if hotspots not in HOTSPOTS:
        raise ValueError(f"unknown hotspot type setting {hotspots!r}")
    return f"""
        SELECT c.*, CASE WHEN c.platform = 'Aqua' THEN 'a' ELSE 'b' END AS side,
               d.aqua, d.viirs_ref, d.record_platform,
               k.island_group, k.province_id, k.regency_id, f.k_day, f.k_night, f.kf_day, f.kf_night
        FROM celldays c
        JOIN days d ON d.local_date = c.local_date AND (c.platform = 'Aqua' OR c.platform = d.viirs_ref)
        JOIN cells k ON k.cx = c.cx AND k.cy = c.cy
        JOIN factor f ON f.hotspots = {quote(hotspots)} AND f.region = k.island_group
                     AND f.month = month(c.local_date)
        WHERE {where}
    """


def record_sql(where: str = "TRUE", hotspots: str = "vegetation") -> str:
    """Cell-days of the spliced harmonised record: Aqua before the splice, the VIIRS reference
    satellite of the day from it on. A day its satellite did not observe has no rows."""
    return observations_sql(f"c.platform = d.record_platform AND ({where})", hotspots)


def paired_sql(start: dt.date, end: dt.date, where: str = "TRUE", hotspots: str = "vegetation") -> str:
    """Aqua and VIIRS-reference cell-days on paired days only: days both Aqua and the VIIRS
    reference satellite observed Indonesia."""
    return observations_sql(f"d.aqua AND d.viirs_ref IS NOT NULL "
                            f"AND c.local_date BETWEEN DATE '{start}' AND DATE '{end}' AND ({where})", hotspots)
