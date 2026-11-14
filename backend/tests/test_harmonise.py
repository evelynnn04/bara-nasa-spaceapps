"""The weight, the fit, the paired-day rule and the verdict."""

from __future__ import annotations

import datetime as dt
import math
import random

import pytest

from app import store
from app.harmonise import fit, metrics, weights
from app.pipeline.celldays import day_status

from .conftest import REF_MONTH, REF_REGION, reference_params


def harmonised(root, daynight: str = "all") -> dict[str, float]:
    con = store.connect(reference_params(), root)
    w = weights.weight_sql(daynight)
    rows = con.execute(f"""
        SELECT side, sum({w}) FROM ({weights.paired_sql(dt.date(2012, 2, 1), dt.date(2025, 12, 31))}) c GROUP BY 1
    """).fetchall()
    return dict(rows)


def test_worked_example_riau_september(worked_example):
    out = harmonised(worked_example)
    k = 6.509 * REF_REGION["Sumatra"] * REF_MONTH[9]
    assert out["a"] == 1.0
    assert out["b"] == pytest.approx(math.sqrt(7) / k)
    assert out["b"] == pytest.approx(0.43, abs=0.005)


def test_day_night_filter_applies_to_both_sides(worked_example):
    k = 6.509 * REF_REGION["Sumatra"] * REF_MONTH[9]
    day = harmonised(worked_example, "day")
    night = harmonised(worked_example, "night")
    assert day == {"a": 1.0, "b": pytest.approx(math.sqrt(5) / k)}
    assert night["a"] == 0.0
    assert night["b"] == pytest.approx(math.sqrt(2) / k)


def synthetic_table(mu: float, rho: dict, sigma: dict, scale: float = 2e6) -> dict:
    rng = random.Random(7)
    table = {}
    for y in range(2012, 2026):
        for m in range(1, 13):
            for r in rho:
                a = scale * (0.5 + rng.random())
                table[(y, m, r)] = {"A": a, "B": a * math.exp(mu + rho[r] + sigma[m]), "a_px": a, "b_px": a}
    return table


def test_fit_recovers_known_factors():
    rho = {"Sumatra": -0.07, "Kalimantan": -0.17, "Java-Bali-NT": 0.46, "Sulawesi-Maluku": 0.14, "Papua": -0.15}
    sigma = {m: 0.1 * math.sin(m) for m in range(1, 13)}
    centre_r = sum(rho.values()) / len(rho)
    centre_s = sum(sigma.values()) / 12
    rho = {r: v - centre_r for r, v in rho.items()}
    sigma = {m: v - centre_s for m, v in sigma.items()}
    model = fit.ipf(synthetic_table(1.87, rho, sigma))
    for r in rho:
        for m in sigma:
            assert fit.k_of(model, r, m) == pytest.approx(math.exp(1.87 + rho[r] + sigma[m]), rel=2e-3)


def test_other_region_keeps_factor_one():
    table = synthetic_table(1.8, {"Sumatra": 0.0, "Other": 0.5}, {m: 0.0 for m in range(1, 13)})
    model = fit.ipf(table)
    assert "Other" not in model["rho"]


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
    celldays = [("modis", "Aqua", good, 2020, 10, 1, 0, 1.0, 1.0), ("viirs", "SNPP", good, 2020, 10, 4, 0, 1.0, 1.0),
                ("viirs", "SNPP", gap, 2020, 10, 9, 0, 1.0, 1.0)]
    root = write_dataset(tmp_path, celldays, [day_row(good), day_row(gap, aqua=False)], [RIAU])
    table = fit.stratum_table(store.connect(None, root), dt.date(2020, 1, 1), dt.date(2020, 12, 31))
    assert table[(2020, 8, "Sumatra")]["B"] == pytest.approx(2.0)


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
