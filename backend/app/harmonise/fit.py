"""Fit the VIIRS factors, evaluate them, and write `params.json`.

Model: `ln k[r, m] = mu + rho_r + sigma_m`, so a VIIRS cell-day weighs `sqrt(n) / k`. The factors
are fitted on paired days of the overlap (days both Aqua and the VIIRS reference satellite observed
Indonesia) by iterative proportional fitting, each effect shrunk towards 0 by `N / (N + n0)`, with
N the stratum's MODIS cell-days. The exponent 0.5 is fixed, not fitted. The island group `Other`
keeps effect 0.

Evaluation, all on paired days:

- leave-one-year-out: each year of the overlap is predicted with factors fitted on the others,
  nationally and per island group (this gives the verdict);
- even years for training, odd years for testing;
- 2015 September / October for both sensors;
- control: S-NPP against NOAA-20 under the same VIIRS weights, May 2018 - December 2025. Two
  copies of one instrument should stay "converged".
"""

from __future__ import annotations

import datetime as dt
import json
import logging
import math
from collections import defaultdict

import duckdb

from .. import config, store
from . import metrics, weights
from .regions import GROUPS

log = logging.getLogger("app.fit")

ALPHA = 0.5
N0 = 2000.0
ITERATIONS = 8
CONTROL_START = dt.date(2018, 5, 1)
METHOD = "MODIS-equivalent active fire cell-days: VIIRS sqrt(pixels) / k[island group, month]"
UNIT = "MODIS-equivalent active fire cell-days"

Key = tuple[int, int, str]  # year, month, island group


def stratum_table(con: duckdb.DuckDBPyConnection, start: dt.date = config.FIT_START,
                  end: dt.date = config.FIT_END) -> dict[Key, dict[str, float]]:
    """Paired-day sums per (year, month, island group): MODIS cell-days `A`, VIIRS sqrt(n) `B`, and
    raw pixels `a_px`, `b_px`. Uses the shared weight expression with all factors set to 1."""
    w = weights.weight_sql("all", k="1.0")
    n = weights.pixels_sql("all")
    rows = con.execute(f"""
        SELECT year(c.local_date) AS y, month(c.local_date) AS m, c.island_group AS r, c.side,
               sum({w}) AS w, sum({n}) AS px
        FROM ({weights.paired_sql(start, end)}) c
        GROUP BY ALL
    """).fetchall()
    out: dict[Key, dict[str, float]] = defaultdict(lambda: {"A": 0.0, "B": 0.0, "a_px": 0.0, "b_px": 0.0})
    for y, m, r, side, wsum, px in rows:
        cell = out[(y, m, r)]
        if side == "a":
            cell["A"] += wsum
            cell["a_px"] += px
        else:
            cell["B"] += wsum
            cell["b_px"] += px
    return dict(out)


def control_table(con: duckdb.DuckDBPyConnection, start: dt.date = CONTROL_START,
                  end: dt.date = config.FIT_END) -> dict[Key, dict[str, float]]:
    """Sums of sqrt(n) for S-NPP (`S`) and NOAA-20 (`N`) on days both observed."""
    w = weights.weight_sql("all", k="1.0")
    rows = con.execute(f"""
        SELECT year(c.local_date), month(c.local_date), k.island_group, c.platform, sum({w})
        FROM celldays c
        JOIN days d ON d.local_date = c.local_date AND d.snpp AND d.noaa20
        JOIN cells k ON k.cx = c.cx AND k.cy = c.cy
        WHERE c.platform IN ('SNPP', 'NOAA20') AND c.local_date BETWEEN DATE '{start}' AND DATE '{end}'
        GROUP BY ALL
    """).fetchall()
    out: dict[Key, dict[str, float]] = defaultdict(lambda: {"S": 0.0, "N": 0.0})
    for y, m, r, p, wsum in rows:
        out[(y, m, r)]["S" if p == "SNPP" else "N"] += wsum
    return dict(out)


def ipf(table: dict[Key, dict[str, float]], years: set[int] | None = None,
        n0: float = N0, iterations: int = ITERATIONS) -> dict:
    """Shrunk iterative proportional fit of ln k = mu + rho_r + sigma_m on the given years."""
    A: dict[tuple[str, int], float] = defaultdict(float)
    B: dict[tuple[str, int], float] = defaultdict(float)
    for (y, m, r), v in table.items():
        if years is None or y in years:
            A[(r, m)] += v["A"]
            B[(r, m)] += v["B"]
    mu = math.log(sum(B.values()) / sum(A.values()))
    every_region = sorted({r for r, _ in A})
    regions = [r for r in every_region if r != "Other"]
    months = sorted({m for _, m in A})
    rho: dict[str, float] = {}
    sigma: dict[int, float] = {}
    for _ in range(iterations):
        for r in regions:
            pa = sum(A[(r, m)] * math.exp(mu + sigma.get(m, 0.0)) for m in months)
            pb = sum(B[(r, m)] for m in months)
            na = sum(A[(r, m)] for m in months)
            if pa > 0 and pb > 0:
                rho[r] = na / (na + n0) * math.log(pb / pa)
        for m in months:
            pa = sum(A[(r, m)] * math.exp(mu + rho.get(r, 0.0)) for r in every_region)
            pb = sum(B[(r, m)] for r in every_region)
            na = sum(A[(r, m)] for r in every_region)
            if pa > 0 and pb > 0:
                sigma[m] = na / (na + n0) * math.log(pb / pa)
    return {"mu": mu, "rho": rho, "sigma": sigma}


def k_of(model: dict, region: str, month: int) -> float:
    return math.exp(model["mu"] + model["rho"].get(region, 0.0) + model["sigma"].get(month, 0.0))


def months_in(years, start: dt.date = config.FIT_START, end: dt.date = config.FIT_END) -> list[tuple[int, int]]:
    return [(y, m) for y in years for m in range(1, 13) if start <= dt.date(y, m, 1) <= end]


def series(table: dict[Key, dict[str, float]], model: dict, months: list[tuple[int, int]],
           region: str | None = None, a_key: str = "A", b_key: str = "B", a_scaled: bool = False) -> list[tuple]:
    """Monthly (year, month, a, b) with b = sum of B / k, nationally or for one island group."""
    out = []
    for y, m in months:
        a = b = 0.0
        for g in GROUPS:
            if region is not None and g != region:
                continue
            v = table.get((y, m, g))
            if not v:
                continue
            k = k_of(model, g, m)
            a += v[a_key] / k if a_scaled else v[a_key]
            b += v[b_key] / k
        out.append((y, m, a, b))
    return out


def scored(pairs: list[tuple]) -> dict:
    m = metrics.agreement(pairs)
    return {**metrics.rounded(m), "verdict": metrics.verdict(m)}


def evaluate(table: dict[Key, dict[str, float]], control: dict[Key, dict[str, float]], full: dict) -> dict:
    """Leave-one-year-out, even/odd split, the 2015 check and the S-NPP / NOAA-20 control."""
    years = sorted({y for y, _, _ in table})
    loyo_national: list[tuple] = []
    loyo_region: dict[str, list[tuple]] = defaultdict(list)
    for y in years:
        model = ipf(table, set(years) - {y})
        ms = months_in([y])
        loyo_national += series(table, model, ms)
        for g in GROUPS:
            loyo_region[g] += series(table, model, ms, region=g)
    even = [y for y in years if y % 2 == 0]
    odd = [y for y in years if y % 2 == 1]
    split = series(table, ipf(table, set(even)), months_in(odd))

    by_month = {(y, m): (a, b) for y, m, a, b in loyo_national}
    raw = {(y, m): (sum(table.get((y, m, g), {}).get("a_px", 0) for g in GROUPS),
                    sum(table.get((y, m, g), {}).get("b_px", 0) for g in GROUPS)) for y, m in months_in([2015])}
    story = {
        "modis_cell_days_sep_over_oct": by_month[(2015, 9)][0] / by_month[(2015, 10)][0],
        "viirs_harmonised_sep_over_oct": by_month[(2015, 9)][1] / by_month[(2015, 10)][1],
        "modis_pixels_sep_over_oct": raw[(2015, 9)][0] / raw[(2015, 10)][0],
        "viirs_pixels_sep_over_oct": raw[(2015, 9)][1] / raw[(2015, 10)][1],
    } if (2015, 10) in by_month else {}

    ctrl_months = months_in(range(CONTROL_START.year, config.FIT_END.year + 1), CONTROL_START)
    ctrl = series(control, full, ctrl_months, a_key="S", b_key="N", a_scaled=True)
    return {
        "leave_one_year_out": {"national": scored(loyo_national),
                               "island_groups": {g: scored(v) for g, v in loyo_region.items() if any(a for *_, a, _ in v)}},
        "split_even_train_odd_test": scored(split),
        "story_2015": {k: round(v, 4) for k, v in story.items()},
        "control_snpp_vs_noaa20": scored(ctrl),
        "loyo_series_national": [[y, m, round(a, 6), round(b, 6)] for y, m, a, b in loyo_national],
    }


def distribution(con: duckdb.DuckDBPyConnection) -> dict:
    """How VIIRS pixel counts per cell-day are spread on paired days."""
    n = weights.pixels_sql("all")
    single, p99, cells = con.execute(f"""
        SELECT avg(CASE WHEN {n} = 1 THEN 1.0 ELSE 0.0 END), quantile_disc({n}, 0.99), count(*)
        FROM ({weights.paired_sql(config.FIT_START, config.FIT_END)}) c WHERE side = 'b' AND {n} > 0
    """).fetchone()
    return {"viirs_cell_days": cells, "share_single_pixel": round(single, 4), "p99_pixels": p99}


def fit(con: duckdb.DuckDBPyConnection) -> dict:
    """Fits, evaluates and returns the parameter record (not yet written)."""
    table = stratum_table(con)
    full = ipf(table)
    record = {
        "method": METHOD,
        "unit": UNIT,
        "alpha": ALPHA,
        "n0": N0,
        "iterations": ITERATIONS,
        "grid_deg": config.GRID,
        "splice": config.SPLICE.isoformat(),
        "aqua_start": config.AQUA_START.isoformat(),
        "fit_window": [config.FIT_START.isoformat(), config.FIT_END.isoformat()],
        "mu": round(full["mu"], 6),
        "base_factor": round(math.exp(full["mu"]), 6),
        "region_factor": {g: round(math.exp(full["rho"].get(g, 0.0)), 6) for g in GROUPS},
        "month_factor": {str(m): round(math.exp(full["sigma"].get(m, 0.0)), 6) for m in range(1, 13)},
        "k_table": [{"region": g, "month": m, "k": k_of(full, g, m)} for g in GROUPS for m in range(1, 13)],
    }
    ev = evaluate(table, control_table(con), full)
    record["evaluation"] = ev
    record["verdict"] = ev["leave_one_year_out"]["national"]["verdict"]
    record["distribution"] = distribution(con)
    months = months_in(range(config.FIT_START.year, config.FIT_END.year + 1))
    record["series_national"] = [[y, m, a, b] for y, m, a, b in series(table, full, months)]
    record["fitted"] = dt.date.today().isoformat()
    return record


def run() -> None:
    """Fits on the derived tables and writes `params.json`."""
    record = fit(store.connect())
    config.params_path().write_text(json.dumps(record, indent=1) + "\n", encoding="utf-8")
    nat = record["evaluation"]["leave_one_year_out"]["national"]
    log.info("mu %.4f (base factor %.3f)", record["mu"], record["base_factor"])
    log.info("region factors %s", record["region_factor"])
    log.info("month factors %s", record["month_factor"])
    log.info("leave-one-year-out: r_log %s malr %s bias %s peaks %d/%d -> %s", nat["r_log"], nat["malr"],
             nat["bias"], nat["peak_matches"], nat["peak_years"], nat["verdict"])
    log.info("wrote %s", config.params_path())
