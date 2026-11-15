"""The harmonisation weight and the relations it is applied to, written once.

Unit: MODIS-equivalent active fire cell-days on the 0.05° grid.

- A MODIS (Aqua) cell-day counts 1 when it holds at least one qualifying pixel.
- A VIIRS cell-day counts `sqrt(n) / k[island group, month]`, where `n` is its qualifying pixel
  count from the day's reference satellite.

With a day or night filter, `n` is the daytime or night-time count, and a MODIS cell-day counts
only if it has pixels in that half of the day.

Every path that turns cell-days into numbers (the fit, the region cache, the API series, map,
agreement check and CSV) builds its SQL from `weight_sql`, so they cannot drift apart.
"""

from __future__ import annotations

import datetime as dt
import json
from pathlib import Path

import duckdb

from .. import config
from ..db import quote

DAYNIGHT = {"all": (True, True), "day": (True, False), "night": (False, True)}


def pixels_sql(daynight: str = "all", c: str = "c") -> str:
    """Qualifying pixel count of a cell-day under the day/night filter."""
    day, night = DAYNIGHT[daynight]
    return f"({c}.n_day * {int(day)} + {c}.n_night * {int(night)})"


def weight_sql(daynight: str = "all", k: str | None = None, c: str = "c") -> str:
    """The cell-day weight over relation `c`, which carries the factor as column `k` (as
    `record_sql` and `paired_sql` do). Pass `k='1.0'` for raw sqrt(n)."""
    n = pixels_sql(daynight, c)
    k = k or f"{c}.k"
    return (f"CASE WHEN {c}.sensor = 'modis' THEN (CASE WHEN {n} > 0 THEN 1.0 ELSE 0.0 END) "
            f"ELSE sqrt(CAST({n} AS DOUBLE)) / {k} END")


#: Cell-day FRP column under each day/night filter.
FRP_COLUMN = {"all": "frp_sum", "day": "frp_day", "night": "frp_night"}


def frp_sql(daynight: str = "all", c: str = "c") -> str:
    """Harmonised fire radiative power of a cell-day (MODIS-equivalent MW) under the day/night
    filter: Aqua FRP as it is, VIIRS FRP divided by the FRP factor `kf` of the relation. NULL when no
    FRP factors were fitted. The factors are fitted on day and night together, like `k`."""
    col = f"{c}.{FRP_COLUMN[daynight]}"
    return f"CASE WHEN {c}.sensor = 'modis' THEN {col} ELSE {col} / {c}.kf END"


def load_params(path: Path | None = None) -> dict:
    """The fitted parameters written by `python -m app fit`."""
    path = path or config.params_path()
    if not path.is_file():
        raise RuntimeError(f"{path} is missing. Run `python -m app fit` first.")
    return json.loads(path.read_text(encoding="utf-8"))


def register_factors(con: duckdb.DuckDBPyConnection, params: dict) -> None:
    """Creates table `factor(region, month, k, kf)` from the fitted parameters (72 rows). `kf`, the
    FRP factor, is NULL when the parameters have none."""
    kf = {(r["region"], int(r["month"])): float(r["k"]) for r in params.get("frp", {}).get("k_table", [])}
    rows = []
    for r in params["k_table"]:
        key = (r["region"], int(r["month"]))
        f = repr(kf[key]) if key in kf else "NULL"
        rows.append(f"({quote(key[0])}, {key[1]}, {float(r['k'])!r}, {f})")
    rows = ", ".join(rows)
    con.execute(f"CREATE OR REPLACE TABLE factor AS SELECT * FROM (VALUES {rows}) AS t(region, month, k, kf)")


def observations_sql(where: str = "TRUE") -> str:
    """Aqua cell-days and the day's VIIRS-reference cell-days, with cell lookup and factor.

    Column `side` is 'a' (Aqua) or 'b' (VIIRS reference), and the day's flags come along
    (`aqua`, `viirs_ref`, `record_platform`). Needs relations `celldays`, `days`, `cells` and
    `factor`."""
    return f"""
        SELECT c.*, CASE WHEN c.platform = 'Aqua' THEN 'a' ELSE 'b' END AS side,
               d.aqua, d.viirs_ref, d.record_platform,
               k.island_group, k.province_id, k.regency_id, f.k, CAST(f.kf AS DOUBLE) AS kf
        FROM celldays c
        JOIN days d ON d.local_date = c.local_date AND (c.platform = 'Aqua' OR c.platform = d.viirs_ref)
        JOIN cells k ON k.cx = c.cx AND k.cy = c.cy
        JOIN factor f ON f.region = k.island_group AND f.month = month(c.local_date)
        WHERE {where}
    """


def record_sql(where: str = "TRUE") -> str:
    """Cell-days of the spliced harmonised record: Aqua before the splice, the VIIRS reference
    satellite of the day from it on. A day its satellite did not observe has no rows."""
    return observations_sql(f"c.platform = d.record_platform AND ({where})")


def paired_sql(start: dt.date, end: dt.date, where: str = "TRUE") -> str:
    """Aqua and VIIRS-reference cell-days on paired days only: days both Aqua and the VIIRS
    reference satellite observed Indonesia."""
    return observations_sql(f"d.aqua AND d.viirs_ref IS NOT NULL "
                            f"AND c.local_date BETWEEN DATE '{start}' AND DATE '{end}' AND ({where})")
