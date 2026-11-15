"""Critical fire periods on hand-built daily records."""

from __future__ import annotations

import datetime as dt

import pytest

from app import critical


def record(start: dt.date, end: dt.date, value) -> tuple[list[dt.date], list[float | None]]:
    """Every day from `start` to `end` with `value(day)`."""
    days = [start + dt.timedelta(days=i) for i in range((end - start).days + 1)]
    return days, [value(d) for d in days]


def flagged(group: dict) -> list[int]:
    return [p["period"] for p in group["periods"] if p["critical"]]


def test_a_recurring_season_is_critical():
    days, values = record(dt.date(2003, 1, 1), dt.date(2008, 12, 31), lambda d: 5.0 if d.month == 9 else 1.0)
    out = critical.critical_periods(days, values)
    months = out["months"]
    assert months["years"] == list(range(2003, 2009))
    assert flagged(months) == [9]
    sep = months["periods"][8]
    lengths = [366 if y % 4 == 0 else 365 for y in range(2003, 2009)]
    assert sep["ratio"] == pytest.approx(sum(5 / ((n - 30 + 150) / n) for n in lengths) / 6, abs=1e-3)
    assert sep["years_above"] == sep["n_years"] == 6 and sep["recurrence"] == 1
    assert sep["values"] == [150.0] * 6
    assert sep["expected"][0] == pytest.approx(30 * 485 / 365, abs=1e-3)
    weeks = flagged(out["weeks"])
    september = {w for w in range(1, 53) if dt.date.fromisocalendar(2005, w, 4).month == 9}
    assert september <= set(weeks)
    assert all({w - 1, w, w + 1} & september for w in weeks)
    assert out["activity"] == {"mean_annual": pytest.approx(485.2, abs=0.2), "confidence": "high"}


def test_weeks_are_measured_over_a_three_week_window():
    days, values = record(dt.date(2003, 1, 1), dt.date(2008, 12, 31), lambda d: 1.0)
    spiky = [v * (4.0 if d.isocalendar().week == 20 else 1.0) for d, v in zip(days, values)]
    week20 = critical.critical_periods(days, spiky)["weeks"]["periods"][19]
    assert week20["ratio"] == pytest.approx((4 + 1 + 1) / 3 / ((51 + 4) / 52), abs=0.02)
    assert week20["values"][1] == 28.0


def test_confidence_follows_mean_annual_activity():
    for per_year, level in ((1.0, "low"), (10.0, "moderate"), (100.0, "high")):
        days, values = record(dt.date(2003, 1, 1), dt.date(2008, 12, 31), lambda d: per_year / 365)
        assert critical.critical_periods(days, values)["activity"]["confidence"] == level


def test_one_extreme_year_is_not_a_season():
    days, values = record(dt.date(2003, 1, 1), dt.date(2008, 12, 31),
                          lambda d: 100.0 if (d.year, d.month) == (2005, 3) else 1.0)
    march = critical.critical_periods(days, values)["months"]["periods"][2]
    assert march["ratio"] >= critical.RATIO_MIN
    assert march["years_above"] == 1 and not march["critical"]


def test_unobserved_days_do_not_dilute_a_period():
    def value(d: dt.date) -> float | None:
        if d.month == 9:
            return None if d.day % 2 else 5.0
        return 1.0

    days, values = record(dt.date(2003, 1, 1), dt.date(2008, 12, 31), value)
    sep = critical.critical_periods(days, values)["months"]["periods"][8]
    lengths = [366 if y % 4 == 0 else 365 for y in range(2003, 2009)]
    assert sep["ratio"] == pytest.approx(sum(5 / ((n - 30 + 75) / (n - 15)) for n in lengths) / 6, abs=1e-3)
    assert sep["critical"]


def test_only_complete_years_count():
    days, values = record(dt.date(2002, 7, 4), dt.date(2006, 11, 14), lambda d: 1.0)
    out = critical.critical_periods(days, values)
    assert out["months"]["years"] == [2003, 2004, 2005]
    assert out["weeks"]["years"] == [2003, 2004, 2005]
    assert not flagged(out["months"]) and not flagged(out["weeks"])


def test_week_53_uses_only_the_years_that_have_it():
    days, values = record(dt.date(2003, 1, 1), dt.date(2016, 12, 31), lambda d: 1.0)
    weeks = critical.critical_periods(days, values)["weeks"]
    w53 = weeks["periods"][52]
    have = [y for y in weeks["years"] if dt.date(y, 12, 28).isocalendar().week == 53]
    assert w53["n_years"] == len(have)
    assert [y for y, v in zip(weeks["years"], w53["values"]) if v is not None] == have


def test_too_few_years_or_no_fire_flags_nothing():
    days, values = record(dt.date(2003, 1, 1), dt.date(2004, 12, 31), lambda d: 5.0 if d.month == 9 else 1.0)
    assert not flagged(critical.critical_periods(days, values)["months"])
    days, values = record(dt.date(2003, 1, 1), dt.date(2008, 12, 31), lambda d: 0.0)
    months = critical.critical_periods(days, values)["months"]
    assert not flagged(months) and all(p["n_years"] == 0 for p in months["periods"])
