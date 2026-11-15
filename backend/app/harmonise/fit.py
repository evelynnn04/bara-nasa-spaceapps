"""Fit the VIIRS factors, evaluate them, and write `params.json`.

Model, per hotspot type setting and half of the day `d`: `ln k_d[r, m] = mu_d + rho_d,r + sigma_d,m`,
so a VIIRS hotspot counts `1 / k_d[r, m]` Aqua MODIS-equivalent hotspots. The factors are fitted
on paired days of the overlap (days both Aqua and the VIIRS reference satellite observed
Indonesia) by iterative proportional fitting, each effect shrunk towards 0 by `A / (A + n0)`, with
`A` the stratum's Aqua hotspots. The rounds repeat until no effect changes by more than
`TOLERANCE`. The island group `Other` keeps effect 0.

Fire radiative power is fitted the same way on the paired-day FRP sums of each half (Aqua FRP as
it is, VIIRS FRP divided by `kf_d[r, m]`), with the shrinkage weighted by Aqua hotspots too.

Evaluation, per type setting, all on paired days:

- leave-one-year-out: each year of the overlap is predicted with factors fitted on the others,
  nationally (day and night together, day only, night only) and per island group; the national
  day-and-night result gives the verdict;
- even years for training, odd years for testing;
- the years in which the two records name a different peak month, with how often MODIS itself
  names the VIIRS month when its days are resampled;
- 2015 September / October for both sensors;
- control: S-NPP against NOAA-20 under the same VIIRS factors, May 2018 - December 2025. Two
  copies of one instrument should stay "converged".
"""

from __future__ import annotations

import datetime as dt
import json
import logging
import math
import random
from collections import defaultdict

import duckdb

from .. import config, store
from . import metrics, weights
from .regions import GROUPS

log = logging.getLogger("app.fit")

N0 = 2000.0
TOLERANCE = 1e-6
MAX_ITERATIONS = 10_000
CONTROL_START = dt.date(2018, 5, 1)
#: Resamples of MODIS's days used to judge whether a peak-month miss is within its sampling noise.
PEAK_RESAMPLES = 1000
METHOD = ("Aqua MODIS-equivalent hotspots: each VIIRS hotspot counts 1 / k_d[island group, month], "
          "with separate factors by day and by night")
UNIT = "hotspots (Aqua MODIS-equivalent)"
HALVES = weights.HALVES

Key = tuple[int, int, str]  # year, month, island group


def stratum_table(con: duckdb.DuckDBPyConnection, hotspots: str = "vegetation", start: dt.date = config.FIT_START,
                  end: dt.date = config.FIT_END) -> dict[Key, dict[str, float]]:
    """Paired-day sums per (year, month, island group) and half of the day: Aqua hotspots `A_d`,
    VIIRS-reference hotspots `B_d`, Aqua FRP `FA_d` and VIIRS-reference FRP `FB_d` (MW)."""
    exprs = []
    for half in HALVES:
        exprs += [f"sum({weights.hotspots_sql(half, hotspots)})", f"sum({weights.frp_sql(half, hotspots, raw=True)})"]
    rows = con.execute(f"""
        SELECT year(c.local_date) AS y, month(c.local_date) AS m, c.island_group AS r, c.side, {", ".join(exprs)}
        FROM ({weights.paired_sql(start, end, hotspots=hotspots)}) c
        GROUP BY ALL
    """).fetchall()
    out: dict[Key, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    for y, m, r, side, n_day, f_day, n_night, f_night in rows:
        cell = out[(y, m, r)]
        a, fa = ("A", "FA") if side == "a" else ("B", "FB")
        cell[f"{a}_day"] += n_day
        cell[f"{a}_night"] += n_night
        cell[f"{fa}_day"] += f_day
        cell[f"{fa}_night"] += f_night
    return {k: dict(v) for k, v in out.items()}


def control_table(con: duckdb.DuckDBPyConnection, hotspots: str = "vegetation", start: dt.date = CONTROL_START,
                  end: dt.date = config.FIT_END) -> dict[Key, dict[str, float]]:
    """Hotspots of S-NPP (`S_d`) and NOAA-20 (`N_d`) per half of the day, on days both observed."""
    rows = con.execute(f"""
        SELECT year(c.local_date), month(c.local_date), k.island_group, c.platform,
               sum({weights.hotspots_sql("day", hotspots)}), sum({weights.hotspots_sql("night", hotspots)})
        FROM celldays c
        JOIN days d ON d.local_date = c.local_date AND d.snpp AND d.noaa20
        JOIN cells k ON k.cx = c.cx AND k.cy = c.cy
        WHERE c.platform IN ('SNPP', 'NOAA20') AND c.local_date BETWEEN DATE '{start}' AND DATE '{end}'
        GROUP BY ALL
    """).fetchall()
    out: dict[Key, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    for y, m, r, p, day, night in rows:
        side = "S" if p == "SNPP" else "N"
        out[(y, m, r)][f"{side}_day"] += day
        out[(y, m, r)][f"{side}_night"] += night
    return {k: dict(v) for k, v in out.items()}


def ipf(table: dict[Key, dict[str, float]], half: str, years: set[int] | None = None, n0: float = N0,
        a: str = "A", b: str = "B", tolerance: float = TOLERANCE, max_iterations: int = MAX_ITERATIONS) -> dict:
    """Shrunk iterative proportional fit of ln k = mu + rho_r + sigma_m for one half of the day.

    `a` and `b` name the MODIS and VIIRS sums (`A`/`B` for hotspots, `FA`/`FB` for FRP); the
    shrinkage weight is always the stratum's Aqua hotspots. Starting from `mu = ln(sum B / sum A)`
    and all effects at 0, each round updates

        rho_r   = s_r ln( B_r / sum_m A[r, m] exp(mu + sigma_m) ),   s_r = N_r / (N_r + n0)
        sigma_m = s_m ln( B_m / sum_r A[r, m] exp(mu + rho_r) ),     s_m = N_m / (N_m + n0)

    until no effect changes by more than `tolerance` (or `max_iterations` rounds)."""
    A: dict[tuple[str, int], float] = defaultdict(float)
    B: dict[tuple[str, int], float] = defaultdict(float)
    N: dict[tuple[str, int], float] = defaultdict(float)
    for (y, m, r), v in table.items():
        if years is None or y in years:
            A[(r, m)] += v.get(f"{a}_{half}", 0.0)
            B[(r, m)] += v.get(f"{b}_{half}", 0.0)
            N[(r, m)] += v.get(f"A_{half}", 0.0)
    mu = math.log(sum(B.values()) / sum(A.values()))
    every_region = sorted({r for r, _ in A})
    regions = [r for r in every_region if r != "Other"]
    months = sorted({m for _, m in A})
    rho: dict[str, float] = {}
    sigma: dict[int, float] = {}
    rounds, change = 0, math.inf
    while change > tolerance and rounds < max_iterations:
        rounds += 1
        change = 0.0
        for r in regions:
            pa = sum(A[(r, m)] * math.exp(mu + sigma.get(m, 0.0)) for m in months)
            pb = sum(B[(r, m)] for m in months)
            na = sum(N[(r, m)] for m in months)
            if pa > 0 and pb > 0:
                new = na / (na + n0) * math.log(pb / pa)
                change = max(change, abs(new - rho.get(r, 0.0)))
                rho[r] = new
        for m in months:
            pa = sum(A[(r, m)] * math.exp(mu + rho.get(r, 0.0)) for r in every_region)
            pb = sum(B[(r, m)] for r in every_region)
            na = sum(N[(r, m)] for r in every_region)
            if pa > 0 and pb > 0:
                new = na / (na + n0) * math.log(pb / pa)
                change = max(change, abs(new - sigma.get(m, 0.0)))
                sigma[m] = new
    return {"mu": mu, "rho": rho, "sigma": sigma, "iterations": rounds, "converged": change <= tolerance}


def fit_halves(table: dict[Key, dict[str, float]], years: set[int] | None = None, a: str = "A",
               b: str = "B") -> dict[str, dict]:
    """One model per half of the day."""
    return {half: ipf(table, half, years, a=a, b=b) for half in HALVES}


def k_of(model: dict, region: str, month: int) -> float:
    return math.exp(model["mu"] + model["rho"].get(region, 0.0) + model["sigma"].get(month, 0.0))


def months_in(years, start: dt.date = config.FIT_START, end: dt.date = config.FIT_END) -> list[tuple[int, int]]:
    return [(y, m) for y in years for m in range(1, 13) if start <= dt.date(y, m, 1) <= end]


def series(table: dict[Key, dict[str, float]], models: dict[str, dict], months: list[tuple[int, int]],
           region: str | None = None, daynight: str = "all", a: str = "A", b: str = "B",
           a_scaled: bool = False) -> list[tuple]:
    """Monthly (year, month, a, b), nationally or for one island group, with b the sum over the
    selected halves of `B_d / k_d` (and a divided the same way when `a_scaled`)."""
    halves = [h for h, on in zip(HALVES, weights.DAYNIGHT[daynight]) if on]
    out = []
    for y, m in months:
        sa = sb = 0.0
        for g in GROUPS:
            if region is not None and g != region:
                continue
            v = table.get((y, m, g))
            if not v:
                continue
            for half in halves:
                k = k_of(models[half], g, m)
                va = v.get(f"{a}_{half}", 0.0)
                sa += va / k if a_scaled else va
                sb += v.get(f"{b}_{half}", 0.0) / k
        out.append((y, m, sa, sb))
    return out


def scored(pairs: list[tuple]) -> dict:
    m = metrics.agreement(pairs)
    return {**metrics.rounded(m), "verdict": metrics.verdict(m)}


def daily_aqua(con: duckdb.DuckDBPyConnection, hotspots: str = "vegetation") -> dict[tuple[int, int], list[float]]:
    """National Aqua hotspots of every paired day in the fit window, per (year, month)."""
    rows = con.execute(f"""
        SELECT d.local_date, coalesce(sum({weights.hotspots_sql("all", hotspots)}), 0)
        FROM days d
        LEFT JOIN celldays c ON c.local_date = d.local_date AND c.platform = 'Aqua'
        WHERE d.aqua AND d.viirs_ref IS NOT NULL
          AND d.local_date BETWEEN DATE '{config.FIT_START}' AND DATE '{config.FIT_END}'
        GROUP BY 1 ORDER BY 1
    """).fetchall()
    out: dict[tuple[int, int], list[float]] = defaultdict(list)
    for d, n in rows:
        out[(d.year, d.month)].append(float(n))
    return dict(out)


def _margin(values: dict[int, float]) -> float:
    top = sorted(values.values(), reverse=True)
    return (top[0] - top[1]) / top[1] if len(top) > 1 and top[1] > 0 else math.inf


def peak_misses(pairs: list[tuple], daily: dict[tuple[int, int], list[float]],
                resamples: int = PEAK_RESAMPLES, seed: int = 7) -> list[dict]:
    """Years in which MODIS and harmonised VIIRS name a different peak month.

    For each, the margin of either peak over its runner-up, and `modis_resampled_share`: the share
    of resamples in which MODIS names the VIIRS month when its paired days are drawn again with
    replacement within each month. A share of a few percent or more means the miss lies within
    MODIS's own day-to-day sampling noise."""
    rng = random.Random(seed)
    out = []
    by_year: dict[int, list[tuple]] = defaultdict(list)
    for y, m, a, b in pairs:
        by_year[y].append((m, a, b))
    for y, rows in sorted(by_year.items()):
        if len(rows) < metrics.MIN_MONTHS_FOR_PEAK:
            continue
        ma = {m: a for m, a, _ in rows}
        mb = {m: b for m, _, b in rows}
        pa, pb = max(ma, key=ma.get), max(mb, key=mb.get)
        if pa == pb:
            continue
        days = {m: daily.get((y, m), []) for m in ma}
        hits = 0
        for _ in range(resamples):
            totals = {m: sum(rng.choice(v) for _ in v) if v else 0.0 for m, v in days.items()}
            hits += max(totals, key=totals.get) == pb
        out.append({"year": y, "modis_peak": pa, "viirs_peak": pb, "modis_margin": round(_margin(ma), 4),
                    "viirs_margin": round(_margin(mb), 4), "modis_resampled_share": round(hits / resamples, 4)})
    return out


def evaluate(table: dict[Key, dict[str, float]], control: dict[Key, dict[str, float]], full: dict[str, dict],
             frp_full: dict[str, dict], daily: dict[tuple[int, int], list[float]] | None = None) -> dict:
    """Leave-one-year-out, even/odd split, peak misses, the 2015 check, the S-NPP / NOAA-20 control
    and the leave-one-year-out FRP check."""
    years = sorted({y for y, _, _ in table})
    loyo: dict[str, list[tuple]] = defaultdict(list)
    loyo_region: dict[str, list[tuple]] = defaultdict(list)
    frp: dict[str, list[tuple]] = defaultdict(list)
    for y in years:
        rest = set(years) - {y}
        models = fit_halves(table, rest)
        frp_models = fit_halves(table, rest, a="FA", b="FB")
        ms = months_in([y])
        for dn in weights.DAYNIGHT:
            loyo[dn] += series(table, models, ms, daynight=dn)
            frp[dn] += series(table, frp_models, ms, daynight=dn, a="FA", b="FB")
        for g in GROUPS:
            loyo_region[g] += series(table, models, ms, region=g)
    even = {y for y in years if y % 2 == 0}
    odd = [y for y in years if y % 2 == 1]
    split = series(table, fit_halves(table, even), months_in(odd))

    by_month = {(y, m): (a, b) for y, m, a, b in loyo["all"]}
    fitted = {(y, m): b for y, m, _, b in series(table, full, months_in([2015]))}
    raw = {(y, m): sum(table.get((y, m, g), {}).get(f"B_{h}", 0.0) for g in GROUPS for h in HALVES)
           for y, m in months_in([2015])}
    story = {
        "modis_sep_over_oct": by_month[(2015, 9)][0] / by_month[(2015, 10)][0],
        "viirs_harmonised_sep_over_oct": by_month[(2015, 9)][1] / by_month[(2015, 10)][1],
        "viirs_harmonised_full_fit_sep_over_oct": fitted[(2015, 9)] / fitted[(2015, 10)],
        "viirs_raw_sep_over_oct": raw[(2015, 9)] / raw[(2015, 10)],
    } if (2015, 10) in by_month and by_month[(2015, 10)][0] > 0 and raw[(2015, 10)] > 0 else {}

    ctrl_months = months_in(range(CONTROL_START.year, config.FIT_END.year + 1), CONTROL_START)
    ctrl = series(control, full, ctrl_months, a="S", b="N", a_scaled=True)
    nonzero = lambda v: any(a for *_, a, _ in v)  # noqa: E731
    return {
        "leave_one_year_out": {
            "national": scored(loyo["all"]),
            "national_day": scored(loyo["day"]),
            "national_night": scored(loyo["night"]),
            "island_groups": {g: scored(v) for g, v in loyo_region.items() if nonzero(v)},
        },
        "split_even_train_odd_test": scored(split),
        "peak_misses": peak_misses(loyo["all"], daily) if daily is not None else [],
        "story_2015": {k: round(v, 4) for k, v in story.items()},
        "control_snpp_vs_noaa20": scored(ctrl),
        "frp_leave_one_year_out": {dn: scored(v) for dn, v in frp.items()},
        "loyo_series_national": [[y, m, round(a, 6), round(b, 6)] for y, m, a, b in loyo["all"]],
    }


def factor_block(model: dict, table: dict[Key, dict[str, float]], half: str, a: str, b: str) -> dict:
    """The fitted factors of one half of the day, with the sums they were fitted on."""
    return {
        "mu": round(model["mu"], 6),
        "base_factor": round(math.exp(model["mu"]), 6),
        "region_factor": {g: round(math.exp(model["rho"].get(g, 0.0)), 6) for g in GROUPS},
        "month_factor": {str(m): round(math.exp(model["sigma"].get(m, 0.0)), 6) for m in range(1, 13)},
        "iterations": model["iterations"],
        "converged": model["converged"],
        "aqua_sum": round(sum(v.get(f"{a}_{half}", 0.0) for v in table.values()), 3),
        "viirs_sum": round(sum(v.get(f"{b}_{half}", 0.0) for v in table.values()), 3),
    }


def fit_setting(con: duckdb.DuckDBPyConnection, hotspots: str) -> tuple[dict, dict[str, dict], dict[str, dict]]:
    """Fits and evaluates one hotspot type setting; returns (record, count models, FRP models)."""
    table = stratum_table(con, hotspots)
    full = fit_halves(table)
    frp_full = fit_halves(table, a="FA", b="FB")
    ev = evaluate(table, control_table(con, hotspots), full, frp_full, daily_aqua(con, hotspots))
    months = months_in(range(config.FIT_START.year, config.FIT_END.year + 1))
    record = {
        "factors": {h: factor_block(full[h], table, h, "A", "B") for h in HALVES},
        "frp_factors": {h: factor_block(frp_full[h], table, h, "FA", "FB") for h in HALVES},
        "evaluation": ev,
        "verdict": ev["leave_one_year_out"]["national"]["verdict"],
        "series_national": [[y, m, a, b] for y, m, a, b in series(table, full, months)],
    }
    return record, full, frp_full


def fit(con: duckdb.DuckDBPyConnection) -> dict:
    """Fits every type setting, evaluates them and returns the parameter record (not yet written)."""
    settings, k_table = {}, []
    for hotspots in weights.HOTSPOTS:
        record, full, frp_full = fit_setting(con, hotspots)
        settings[hotspots] = record
        k_table += [{"hotspots": hotspots, "region": g, "month": m,
                     "k_day": k_of(full["day"], g, m), "k_night": k_of(full["night"], g, m),
                     "kf_day": k_of(frp_full["day"], g, m), "kf_night": k_of(frp_full["night"], g, m)}
                    for g in GROUPS for m in range(1, 13)]
    return {
        "method": METHOD,
        "unit": UNIT,
        "n0": N0,
        "tolerance": TOLERANCE,
        "max_iterations": MAX_ITERATIONS,
        "grid_deg": config.GRID,
        "splice": config.SPLICE.isoformat(),
        "aqua_start": config.AQUA_START.isoformat(),
        "fit_window": [config.FIT_START.isoformat(), config.FIT_END.isoformat()],
        "default_hotspots": "vegetation",
        "verdict": settings["vegetation"]["verdict"],
        "settings": settings,
        "k_table": k_table,
        "fitted": dt.date.today().isoformat(),
    }


def run() -> None:
    """Fits on the derived tables and writes `params.json`."""
    record = fit(store.connect())
    config.params_path().write_text(json.dumps(record, indent=1) + "\n", encoding="utf-8")
    for hotspots, s in record["settings"].items():
        for half, f in s["factors"].items():
            log.info("%s %s: base factor %.3f after %d rounds", hotspots, half, f["base_factor"], f["iterations"])
        nat = s["evaluation"]["leave_one_year_out"]["national"]
        log.info("%s leave-one-year-out: r_log %s malr %s bias %s peaks %d/%d -> %s", hotspots, nat["r_log"],
                 nat["malr"], nat["bias"], nat["peak_matches"], nat["peak_years"], nat["verdict"])
    log.info("wrote %s", config.params_path())
