"""The weight, the fit, the paired-day rule and the verdict."""

from __future__ import annotations

import datetime as dt
import math
import random

import pytest

from app import store
from app.harmonise import fit, metrics, weights
from app.pipeline.celldays import day_status

from .conftest import ref_k, reference_params


def harmonised(root, daynight: str = "all", hotspots: str = "vegetation") -> dict[str, float]:
    con = store.connect(reference_params(), root)
    w = weights.weight_sql(daynight, hotspots)
    paired = weights.paired_sql(dt.date(2012, 2, 1), dt.date(2025, 12, 31), hotspots=hotspots)
    return dict(con.execute(f"SELECT side, sum({w}) FROM ({paired}) c GROUP BY 1").fetchall())


def test_worked_example_riau_september(worked_example):
    out = harmonised(worked_example)
    k_day, k_night = ref_k("day", "Sumatra", 9), ref_k("night", "Sumatra", 9)
    assert k_day == pytest.approx(5.58, abs=0.005) and k_night == pytest.approx(16.14, abs=0.01)
    assert out["a"] == 3.0
    assert out["b"] == pytest.approx(7 / k_day + 3 / k_night)
    assert out["b"] == pytest.approx(1.44, abs=0.005)


def test_day_night_filter_uses_one_half_on_both_sides(worked_example):
    k_day, k_night = ref_k("day", "Sumatra", 9), ref_k("night", "Sumatra", 9)
    assert harmonised(worked_example, "day") == {"a": 2.0, "b": pytest.approx(7 / k_day)}
    assert harmonised(worked_example, "night") == {"a": 1.0, "b": pytest.approx(3 / k_night)}


def test_all_types_setting_counts_other_hotspots(worked_example):
    k_day, k_night = ref_k("day", "Sumatra", 9), ref_k("night", "Sumatra", 9)
    assert harmonised(worked_example, hotspots="all") == {"a": 3.0, "b": pytest.approx(11 / k_day + 3 / k_night)}


def test_frp_is_divided_per_half(worked_example):
    con = store.connect(reference_params(), worked_example)
    rows = dict(con.execute(f"""
        SELECT side, sum({weights.frp_sql()})
        FROM ({weights.paired_sql(dt.date(2015, 1, 1), dt.date(2015, 12, 31))}) c GROUP BY 1
    """).fetchall())
    assert rows["a"] == pytest.approx(30.0)
    assert rows["b"] == pytest.approx(50.0 / 2.0)


def synthetic_table(mu: dict, rho: dict, sigma: dict, scale: float = 2e5) -> dict:
    """Paired-day sums whose VIIRS side follows the factor model exactly, per half of the day."""
    rng = random.Random(7)
    table = {}
    for y in range(2012, 2026):
        for m in range(1, 13):
            for r in rho:
                cell = {}
                for half in fit.HALVES:
                    a = scale * (0.5 + rng.random())
                    cell[f"A_{half}"] = a
                    cell[f"B_{half}"] = a * math.exp(mu[half] + rho[r][half] + sigma[m][half])
                table[(y, m, r)] = cell
    return table


def centred(values: dict) -> dict:
    mean = sum(values.values()) / len(values)
    return {k: v - mean for k, v in values.items()}


def test_fit_recovers_known_factors_per_half():
    mu = {"day": 1.78, "night": 2.87}
    rho = {"day": centred({"Sumatra": -0.11, "Kalimantan": -0.19, "Java-Bali-NT": 0.43, "Sulawesi-Maluku": 0.10,
                           "Papua": -0.05}),
           "night": centred({"Sumatra": -0.13, "Kalimantan": -0.17, "Java-Bali-NT": 0.38, "Sulawesi-Maluku": 0.24,
                             "Papua": -0.02})}
    sigma = {"day": centred({m: 0.1 * math.sin(m) for m in range(1, 13)}),
             "night": centred({m: 0.1 * math.cos(m) for m in range(1, 13)})}
    table = synthetic_table(mu, {r: {h: rho[h][r] for h in rho} for r in rho["day"]},
                            {m: {h: sigma[h][m] for h in sigma} for m in range(1, 13)})
    for half in fit.HALVES:
        model = fit.ipf(table, half)
        assert model["converged"] and model["iterations"] < fit.MAX_ITERATIONS
        for r in rho[half]:
            for m in range(1, 13):
                expected = math.exp(mu[half] + rho[half][r] + sigma[half][m])
                assert fit.k_of(model, r, m) == pytest.approx(expected, rel=2e-3)


def test_ipf_matches_a_hand_computed_round():
    # Two island groups, one month: the first round gives mu = ln(sum B / sum A) and
    # rho_r = s_r ln(B_r / (A_r exp(mu))), s_r = A_r / (A_r + n0).
    table = {(2015, 9, "Sumatra"): {"A_day": 100.0, "B_day": 800.0},
             (2015, 9, "Papua"): {"A_day": 300.0, "B_day": 1200.0}}
    one = fit.ipf(table, "day", n0=100.0, max_iterations=1)
    mu = math.log(2000 / 400)
    assert one["mu"] == pytest.approx(mu)
    rho = {"Sumatra": 100 / 200 * math.log(800 / (100 * math.exp(mu))),
           "Papua": 300 / 400 * math.log(1200 / (300 * math.exp(mu)))}
    assert one["rho"] == pytest.approx(rho)
    pa = 100 * math.exp(mu + rho["Sumatra"]) + 300 * math.exp(mu + rho["Papua"])
    assert one["sigma"][9] == pytest.approx(400 / 500 * math.log(2000 / pa))


def test_ipf_stops_on_tolerance():
    table = {(2015, m, r): {"A_day": 50.0 + m, "B_day": (300.0 + 7 * m) * (1.2 if r == "Papua" else 1.0)}
             for m in range(1, 13) for r in ("Sumatra", "Papua")}
    loose = fit.ipf(table, "day", tolerance=1e-3)
    tight = fit.ipf(table, "day", tolerance=1e-9)
    assert loose["converged"] and tight["converged"]
    assert loose["iterations"] < tight["iterations"] < fit.MAX_ITERATIONS
    capped = fit.ipf(table, "day", tolerance=0.0, max_iterations=3)
    assert capped["iterations"] == 3 and not capped["converged"]


def test_other_region_keeps_effect_zero():
    table = {(2015, m, r): {"A_day": 100.0, "B_day": 600.0 * (2.0 if r == "Other" else 1.0)}
             for m in range(1, 13) for r in ("Sumatra", "Other")}
    assert "Other" not in fit.ipf(table, "day")["rho"]


def test_paired_day_rule_drops_gaps():
    first = dt.date(2020, 8, 1)
    days = [first + dt.timedelta(days=i) for i in range(20)]
    seen = {"Aqua": set(days), "SNPP": set(days), "NOAA20": set(days)}
    seen["Aqua"] -= {days[3], days[4]}                    # two quiet days: still observed
    seen["Aqua"] -= {days[10], days[11], days[12]}        # three empty days: a gap
    seen["SNPP"] -= {days[15]}                            # S-NPP outage: NOAA-20 stands in
    seen["NOAA20"] -= {days[16]}
    seen["SNPP"] -= {days[16]}                            # both out: no VIIRS that day
    status = {r["local_date"]: r for r in day_status(seen, first, days[-1])}
    assert status[days[3]]["aqua"] and status[days[4]]["aqua"]
    assert not any(status[d]["aqua"] for d in days[10:13])
    assert status[days[15]]["viirs_ref"] == "NOAA20"
    assert status[days[16]]["viirs_ref"] is None and status[days[16]]["record_platform"] is None


def test_paired_days_exclude_gap_days(tmp_path):
    from .conftest import RIAU, day_row, write_dataset
    good, gap = dt.date(2020, 8, 10), dt.date(2020, 8, 20)
    celldays = [("modis", "Aqua", good, 2020, 10, 1, 0, 1.0, 1.0), ("viirs", "SNPP", good, 2020, 10, 4, 1, 1.0, 1.0),
                ("viirs", "SNPP", gap, 2020, 10, 9, 0, 1.0, 1.0)]
    root = write_dataset(tmp_path, celldays, [day_row(good), day_row(gap, aqua=False)], [RIAU])
    table = fit.stratum_table(store.connect(None, root), "vegetation", dt.date(2020, 1, 1), dt.date(2020, 12, 31))
    assert table[(2020, 8, "Sumatra")]["B_day"] == 4 and table[(2020, 8, "Sumatra")]["B_night"] == 1


def test_peak_misses_report_margins_and_resampling():
    pairs = [(2013, m, 100.0 + (10 if m == 8 else 0), 100.0 + (12 if m == 6 else 0)) for m in range(1, 13)]
    daily = {(2013, m): [1.0] * 25 + [10.0] * 5 for m in range(1, 13)}
    out = fit.peak_misses(pairs, daily, resamples=200)
    assert [(r["year"], r["modis_peak"], r["viirs_peak"]) for r in out] == [(2013, 8, 6)]
    assert out[0]["modis_margin"] == pytest.approx(0.1) and out[0]["viirs_margin"] == pytest.approx(0.12)
    assert 0 < out[0]["modis_resampled_share"] < 1


@pytest.mark.parametrize("matches,years,expected", [(6, 7, "converged"), (5, 7, "partial"), (12, 14, "converged")])
def test_verdict_uses_exact_peak_fraction(matches, years, expected):
    m = {"n_months": 160, "r_log": 0.99, "malr": 0.08, "peak_matches": matches, "peak_years": years}
    assert metrics.verdict(m) == expected


def test_agreement_metrics():
    pairs = [(2015, m, 100.0 * m, 110.0 * m) for m in range(1, 13)]
    m = metrics.agreement(pairs)
    assert m["bias"] == pytest.approx(1.1)
    assert m["malr"] == pytest.approx(math.log(1.1))
    assert m["peak_matches"] == 1 and m["peak_years"] == 1
