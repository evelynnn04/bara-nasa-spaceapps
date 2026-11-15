"""Monthly fire activity forecast on hand-built records."""

from __future__ import annotations

import datetime as dt
import math
import random

import pytest

from app import anomaly, forecast as fc, forecast_validation as fv

YEARS = list(range(2003, 2021))


def months(years: list[int]) -> list[tuple[int, int]]:
    return [(y, c) for y in years for c in range(1, 13)]


def synthetic_areas(phi: float = 0.6, oni_effect: float = 0.0, n: int = 12, seed: int = 3):
    """Log monthly series with a seasonal normal and an AR(1) anomaly of coefficient `phi`, plus
    `oni_effect` times the ONI season ending two months before the target (independent ONI values,
    so the two effects can be told apart)."""
    rng = random.Random(seed)
    oni = {m: rng.gauss(0, 1) for m in months(list(range(2002, 2021)))}
    areas = []
    for _ in range(n):
        level = rng.uniform(3, 5)
        a = 0.0
        z = {}
        for m in months(YEARS):
            a = phi * a + rng.gauss(0, 0.4)
            season = 1.5 * math.sin(m[1] / 12 * 2 * math.pi)
            z[m] = max(0.0, level + season + a + oni_effect * oni[fc.shift(m, -2)])
        areas.append(z)
    return areas, oni


def test_oni_table_is_keyed_by_the_last_month_of_each_season():
    text = " SEAS  YR   TOTAL   ANOM\n  DJF 2015  26.9   0.5\n  NDJ 2015  29.0   2.6\n  JAS 2026  29.1   2.16\n"
    assert fc.read_oni(text) == {(2015, 2): 0.5, (2016, 1): 2.6, (2026, 9): 2.16}


def test_months_and_shift():
    assert fc.shift((2025, 11), 3) == (2026, 2) and fc.shift((2026, 1), -1) == (2025, 12)
    days = [dt.date(2002, 7, 30) + dt.timedelta(days=i) for i in range(40)]
    totals = fc.monthly(days, [1.0 if i % 5 else None for i in range(40)])
    assert list(totals) == [(2002, 8)] and totals[(2002, 8)] == 25.0


def test_least_squares_recovers_a_line():
    rows = [[1.0, x, x * x] for x in range(6)]
    assert fc.least_squares(rows, [2 + 3 * x - 0.5 * x * x for x in range(6)]) == pytest.approx([2, 3, -0.5])


def lead1_mean(f: fc.Fit, i: int) -> float:
    return sum(f.coef[(1, c)][i] for c in range(1, 13)) / 12


def test_fit_recovers_persistence():
    areas, oni = synthetic_areas(phi=0.6)
    f = fc.fit(areas, oni, YEARS)
    assert lead1_mean(f, 1) == pytest.approx(0.6, abs=0.1)
    assert lead1_mean(f, 2) == pytest.approx(0.0, abs=0.1)
    assert all(len(f.coef[(3, c)]) == 2 for c in range(1, 13))
    assert fc.fit(areas, {}, YEARS).oni_leads == ()


def test_fit_recovers_the_oni_effect():
    areas, oni = synthetic_areas(phi=0.0, oni_effect=0.4)
    assert lead1_mean(fc.fit(areas, oni, YEARS), 2) == pytest.approx(0.4, abs=0.1)


def test_elevated_threshold_matches_the_anomaly_score():
    n = fc.normal({m: float(m[0] % 7) for m in months(YEARS)}, YEARS)
    th = fc.elevated_threshold(n, 5)
    ref = n.values[5]
    assert anomaly.upper_tail_score(th + 1e-6, ref) >= fc.ELEVATED
    assert anomaly.upper_tail_score(th, ref) < fc.ELEVATED


def test_predictions_are_ordered_and_probabilities_bounded():
    areas, oni = synthetic_areas()
    f = fc.fit(areas, oni, YEARS)
    n = fc.normal(areas[0], YEARS)
    for lead in fc.LEADS:
        p = fc.predict(f, n, areas[0], oni, (2020, 6), lead)
        assert p["low"] <= p["median"] <= p["high"] and 0 <= p["p_elevated"] <= 1
        assert p["uses_oni"] == (lead in fc.ONI_LEADS)


def test_forecast_of_a_quiet_area_gives_no_probability():
    areas, oni = synthetic_areas()
    f = fc.fit(areas, oni, YEARS)
    days = [dt.date(2003, 1, 1) + dt.timedelta(days=i) for i in range((dt.date(2020, 12, 31) - dt.date(2003, 1, 1)).days + 1)]
    quiet = fc.forecast(days, [0.01] * len(days), f, oni)
    assert quiet["activity"]["confidence"] == "low" and quiet["issued_after"] == "2020-12"
    assert [p["month"] for p in quiet["forecasts"]] == ["2021-01", "2021-02", "2021-03"]
    assert all(p["p_elevated"] is None and p["outlook"] is None for p in quiet["forecasts"])
    busy = fc.forecast(days, [5.0] * len(days), f, oni)
    assert busy["activity"]["confidence"] == "high" and all(p["outlook"] for p in busy["forecasts"])
    short = fc.forecast(days[:400], [1.0] * 400, f, oni)
    assert short["forecasts"] == [] and short["limitations"][0].startswith("Too few")


def test_outlook_labels():
    assert [fc.outlook(p) for p in (None, 0.1, 0.3, 0.7)] == [
        None, "near or below normal", "elevated possible", "elevated likely"]


def test_validation_scores():
    s = fv.Scores()
    s.add(10, 8, 5, 12, 0.6, True)
    s.add(0, 2, 0, 3, 0.1, False)
    r = s.summary(reference_mae=4.0)
    assert r["mae"] == 2 and r["skill"] == 0.5 and r["coverage"] == 1
    assert r["precision_0.5"] == 1 and r["recall_0.5"] == 1
    assert fv.groups("regency", 50) == ["regencies 20-200/yr"] and fv.groups("regency", 1) == []
