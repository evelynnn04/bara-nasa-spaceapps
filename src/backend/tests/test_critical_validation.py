"""Helpers of the critical-period validation on hand-built records."""

from __future__ import annotations

import datetime as dt
import random

import pytest

from app import critical, critical_validation as cv

from .test_critical import record


def month_table(value) -> critical.Table:
    days, values = record(dt.date(2003, 1, 1), dt.date(2014, 12, 31), value)
    return critical.table(days, values, critical.MONTHS)


def test_jaccard_and_runs():
    assert cv.jaccard([True, True, False], [True, False, True]) == pytest.approx(1 / 3)
    assert cv.jaccard([False] * 3, [False] * 3) == 1.0
    assert cv.runs([True, False, True, False]) == 2
    assert cv.runs([True, False, False, True]) == 1
    assert cv.runs([False] * 4) == 0 and cv.runs([True] * 4) == 1


def test_benjamini_hochberg_is_stricter_than_the_raw_level():
    assert cv.benjamini_hochberg([0.001, 0.04, 0.03, 0.9]) == [True, False, False, False]
    assert cv.benjamini_hochberg([0.01, 0.02, 0.03, 0.04]) == [True, True, True, True]


def test_permutation_finds_a_recurring_season_only():
    season = month_table(lambda d: 5.0 if d.month == 9 else 1.0)
    p = cv.permutation_p(season, random.Random(1), 999)
    assert p[8] < 0.01 and min(p[:8] + p[9:]) > 0.5
    flat = month_table(lambda d: 1.0 + (d.toordinal() * 7919 % 13) / 10)
    assert min(cv.benjamini_hochberg(cv.permutation_p(flat, random.Random(1), 999))) is False


def test_variants_and_literature_rules():
    t = month_table(lambda d: 5.0 if d.month in (8, 9) else 1.0)
    assert cv.flags(t, 12) == [m in (8, 9) for m in range(1, 13)]
    assert cv.flags(t, 12, variant="intensity >= 2.0") == cv.flags(t, 12)
    assert cv.giglio(t) == [m in (8, 9) for m in range(1, 13)]
    assert sum(cv.run80(t)) == 8 and cv.runs(cv.run80(t)) == 1
    even = {i for i, y in enumerate(t.years) if y % 2 == 0}
    assert cv.flags(t, 12, even) == cv.flags(t, 12)
