"""Historically critical fire periods of an area (see `docs/critical-periods.md`).

A period is a calendar month or an ISO week. For every complete year of the record, each period is
compared with the rest of its own year through its **intensity**: the period's mean daily value
divided by the year's mean daily value, both over observed days only. Comparing within the year
keeps one extreme year (such as 2015) from deciding the season on its own.

A week's intensity is taken over a centred window of `WEEK_WINDOW` weeks, because single weeks
are too noisy to repeat from one half of the record to the other.

A period is **critical** when, over the years with any fire activity:

- its mean intensity is at least `RATIO_MIN` (it typically burns at 1.5 times its year's average
  rate), and
- it was above its year's average rate (intensity above 1) in at least `RECURRENCE_MIN` of them,
  so that the elevation recurs and does not come from a single year;
- and at least `MIN_YEARS` years support it.

Areas with little fire give unstable results; `confidence` says how far to trust them, from the
area's mean annual activity. The thresholds were chosen and checked on the record of every
province and city/regency with `python -m app validate-critical` (see `critical_validation.py`).
"""

from __future__ import annotations

import datetime as dt
from collections import defaultdict
from dataclasses import dataclass
from statistics import mean, median
from typing import Callable

#: Mean intensity a critical period must reach.
RATIO_MIN = 1.5
#: Share of active years in which a critical period must burn above its year's average rate.
RECURRENCE_MIN = 0.5
#: Fewest active years a period needs before it can be called critical.
MIN_YEARS = 3
#: Weeks in the centred window a week's intensity is measured over.
WEEK_WINDOW = 3
#: Mean annual activity (fire cell-days over complete years) from which the result is of moderate,
#: then high confidence. Below the first, even and odd years agree on under half the flags.
CONFIDENCE_FROM = {"moderate": 2.0, "high": 20.0}


@dataclass(frozen=True)
class Kind:
    """A kind of period: how a day maps to (year, period), how many periods a year has, and the
    first and last day of a year."""

    key: Callable[[dt.date], tuple[int, int]]
    periods: int
    bounds: Callable[[int], tuple[dt.date, dt.date]]


def _iso_key(d: dt.date) -> tuple[int, int]:
    iso = d.isocalendar()
    return iso.year, iso.week


MONTHS = Kind(lambda d: (d.year, d.month), 12, lambda y: (dt.date(y, 1, 1), dt.date(y, 12, 31)))
WEEKS = Kind(_iso_key, 53, lambda y: (dt.date.fromisocalendar(y, 1, 1),
                                      dt.date.fromisocalendar(y + 1, 1, 1) - dt.timedelta(days=1)))


@dataclass
class Table:
    """One kind of period over the complete years of a record.

    Rows follow `years`, columns the periods 1 to `kind.periods`. `total` is the period's own
    total, `expected` what it would hold at its year's average rate over the same observed days
    (both `None` when the period does not occur that year), and `intensity` the period's
    (windowed) rate over the year's rate, `None` when undefined: the period does not occur, was
    never observed, or the year had no fire."""

    years: list[int]
    annual: list[float]
    total: list[list[float | None]]
    expected: list[list[float | None]]
    intensity: list[list[float | None]]


def complete_years(first: dt.date, last: dt.date, kind: Kind) -> list[int]:
    """Years of `kind` whose every day lies between `first` and `last`."""
    return [y for y in range(first.year - 1, last.year + 2)
            if first <= kind.bounds(y)[0] and kind.bounds(y)[1] <= last]


def table(days: list[dt.date], values: list[float | None], kind: Kind, window: int = 1) -> Table:
    """Totals, expected values and intensities of every period of every complete year.

    `days` is continuous and ascending, `values` the harmonised value of each day (`None` when it
    was not observed). A period's intensity is measured over a centred `window` of periods of the
    same year, fewer at the year's edges."""
    years = complete_years(days[0], days[-1], kind) if days else []
    wanted = set(years)
    total: dict[tuple[int, int], float] = defaultdict(float)
    observed: dict[tuple[int, int], int] = defaultdict(int)
    present: set[tuple[int, int]] = set()
    for d, v in zip(days, values):
        y, p = kind.key(d)
        if y not in wanted:
            continue
        present.add((y, p))
        if v is not None:
            total[(y, p)] += v
            observed[(y, p)] += 1

    periods = range(1, kind.periods + 1)
    half = window // 2
    out = Table(years, [], [], [], [])
    for y in years:
        n = sum(observed[(y, p)] for p in periods)
        s = sum(total[(y, p)] for p in periods)
        rate = s / n if n else 0.0
        out.annual.append(s)
        row_t, row_e, row_i = [], [], []
        for p in periods:
            if (y, p) not in present:
                row_t.append(None)
                row_e.append(None)
                row_i.append(None)
                continue
            row_t.append(total[(y, p)])
            row_e.append(rate * observed[(y, p)])
            near = [(y, q) for q in range(p - half, p + half + 1) if (y, q) in present]
            wn = sum(observed[k] for k in near)
            row_i.append(sum(total[k] for k in near) / wn / rate if wn and rate > 0 else None)
        out.total.append(row_t)
        out.expected.append(row_e)
        out.intensity.append(row_i)
    return out


def assess(intensities: list[float], ratio_min: float = RATIO_MIN, recurrence_min: float = RECURRENCE_MIN,
           min_years: int = MIN_YEARS, stat: Callable[[list[float]], float] = mean) -> tuple[bool, float, int, int]:
    """(critical, typical intensity, years above average, years) of one period, from its defined
    intensities over the years. `stat` summarises them (the mean by default)."""
    n = len(intensities)
    typical = stat(intensities) if n else 0.0
    above = sum(1 for r in intensities if r > 1)
    critical = n >= min_years and typical >= ratio_min and above / n >= recurrence_min
    return critical, typical, above, n


def column(t: Table, p: int, rows: list[int] | None = None) -> list[float]:
    """Defined intensities of period `p` (1-based), over all years or the row indices `rows`."""
    picked = range(len(t.years)) if rows is None else rows
    return [v for v in (t.intensity[i][p - 1] for i in picked) if v is not None]


def confidence(mean_annual: float) -> str:
    """`low`, `moderate` or `high`, from an area's mean annual activity."""
    level = "low"
    for name, start in CONFIDENCE_FROM.items():
        if mean_annual >= start:
            level = name
    return level


def _summary(t: Table, kind: Kind) -> dict:
    """The API form of a table: per period its flag, mean intensity, recurrence, median value, and
    value and expected value per year."""
    out = []
    for p in range(1, kind.periods + 1):
        critical, ratio, above, n = assess(column(t, p))
        vals = [None if row[p - 1] is None else round(row[p - 1], 4) for row in t.total]
        shown = [v for v in vals if v is not None]
        out.append({
            "period": p,
            "critical": critical,
            "ratio": round(ratio, 3),
            "years_above": above,
            "n_years": n,
            "recurrence": round(above / n, 3) if n else 0.0,
            "median": round(median(shown), 4) if shown else None,
            "values": vals,
            "expected": [None if row[p - 1] is None else round(row[p - 1], 4) for row in t.expected],
        })
    return {"years": t.years, "periods": out}


def critical_periods(days: list[dt.date], values: list[float | None]) -> dict:
    """Critical calendar months (1-12) and ISO weeks (1-53) of a daily record.

    `days` is continuous and ascending, `values` the harmonised value of each day (`None` when the
    record satellite did not observe it). ISO week 53 exists in some years only; its statistics use
    those years. `activity` gives the mean annual total over the complete calendar years and the
    resulting confidence (`low`, `moderate` or `high`)."""
    months = table(days, values, MONTHS)
    annual = sum(months.annual) / len(months.years) if months.years else 0.0
    return {
        "method": {"ratio_min": RATIO_MIN, "recurrence_min": RECURRENCE_MIN, "min_years": MIN_YEARS,
                   "week_window": WEEK_WINDOW, "confidence_from": CONFIDENCE_FROM},
        "activity": {"mean_annual": round(annual, 3), "confidence": confidence(annual)},
        "months": _summary(months, MONTHS),
        "weeks": _summary(table(days, values, WEEKS, WEEK_WINDOW), WEEKS),
    }
