"""Validation of the critical-period definition on the full record.

Run `python -m app validate-critical` after the cache is built. It reproduces every number of the
"Validation" section of `docs/critical-periods.md` for the record in `data/`, over Indonesia, its
provinces and its cities/regencies, day and night detections:

- the critical months of the country and each province, against two published definitions;
- a permutation test of each month, corrected for the twelve months tested;
- the stability of the chosen thresholds and of alternatives (even against odd years, leaving one
  year out, broken-up seasons);
- the stability of weekly flags for windows of 1, 3 and 5 weeks;
- the stability by mean annual activity behind the confidence levels.

It reuses `app.critical` for every intensity and flag. The permutation test is random with a fixed
seed, so repeated runs give the same output.
"""

from __future__ import annotations

import bisect
import json
import logging
import math
import random
from dataclasses import dataclass
from statistics import mean, median
from typing import Callable

from . import config, critical, queries, store
from .critical import MONTHS, WEEKS, Table
from .harmonise import weights

log = logging.getLogger("app.critical_validation")

MONTH_NAMES = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
SEED = 7
PERMUTATIONS = 4000
#: False discovery rate of the Benjamini-Hochberg correction.
FDR = 0.05
#: Mean annual activity (fire cell-days) bands the results are reported in.
TIERS = ((0, 5), (5, 50), (50, 500), (500, math.inf))
CONFIDENCE_BANDS = (0, 1, 2, 5, 10, 20, 50, math.inf)
WINDOWS = (1, 3, 5)
#: Weeks scored for stability; week 53 occurs in a few years only.
WEEK_SPAN = 52

YearFilter = Callable[[list[float]], set[int]]


def _all_active(annual: list[float]) -> set[int]:
    return {i for i, a in enumerate(annual) if a > 0}


def _at_least(cd: float) -> YearFilter:
    return lambda annual: {i for i, a in enumerate(annual) if a >= cd}


def _share_of_median(share: float) -> YearFilter:
    def pick(annual: list[float]) -> set[int]:
        active = [a for a in annual if a > 0]
        floor = share * median(active) if active else 0.0
        return {i for i, a in enumerate(annual) if a > 0 and a >= floor}
    return pick


#: name -> (arguments of `critical.assess`, years kept). The first is the definition in use.
VARIANTS: dict[str, tuple[dict, YearFilter]] = {
    "chosen: mean >= 1.5, above average in >= 1/2": ({}, _all_active),
    "intensity >= 1.25": ({"ratio_min": 1.25}, _all_active),
    "intensity >= 2.0": ({"ratio_min": 2.0}, _all_active),
    "above average in >= 2/3": ({"recurrence_min": 2 / 3}, _all_active),
    "median instead of mean": ({"stat": median}, _all_active),
    "leave out years < 5 cell-days": ({}, _at_least(5)),
    "leave out years < 1/4 of median year": ({}, _share_of_median(0.25)),
}


@dataclass
class Area:
    id: str
    name: str
    level: str
    months: Table
    weeks: dict[int, Table]

    @property
    def mean_annual(self) -> float:
        return sum(self.months.annual) / len(self.months.years) if self.months.years else 0.0


def load(con) -> list[Area]:
    """Every area of the region cache with its month table and week tables for each window."""
    flags = queries.day_flags(con)
    days = [f[0] for f in flags]
    names = {}
    if config.boundaries_path().is_file():
        for f in json.loads(config.boundaries_path().read_text(encoding="utf-8"))["features"]:
            names[f["properties"]["id"]] = f["properties"]["name"]
    rows = con.execute("SELECT region_id, any_value(level) FROM region_daily "
                       "WHERE daynight = 'all' AND hotspots = 'vegetation' GROUP BY 1 ORDER BY 1").fetchall()
    out = []
    for n, (rid, level) in enumerate(rows, 1):
        values = queries.record_series(queries.daily_cached(con, "all", [rid]), flags)
        out.append(Area(rid, names.get(rid, rid), level, critical.table(days, values, MONTHS),
                        {w: critical.table(days, values, WEEKS, w) for w in WINDOWS}))
        if n % 100 == 0:
            log.info("loaded %d of %d areas", n, len(rows))
    return out


def flags(t: Table, periods: int, rows: set[int] | None = None, variant: str = next(iter(VARIANTS))) -> list[bool]:
    """Critical flags of periods 1 to `periods` under a variant, over the row indices `rows`."""
    kwargs, keep = VARIANTS[variant]
    picked = keep(t.annual) if rows is None else keep(t.annual) & rows
    order = sorted(picked)
    return [critical.assess(critical.column(t, p, order), **kwargs)[0] for p in range(1, periods + 1)]


def jaccard(a: list[bool], b: list[bool]) -> float:
    """Shared flags over flags in either; 1 when neither has any."""
    union = sum(x or y for x, y in zip(a, b))
    return 1.0 if union == 0 else sum(x and y for x, y in zip(a, b)) / union


def runs(mask: list[bool]) -> int:
    """Number of runs of consecutive flagged periods, wrapping around the year."""
    if not any(mask) or all(mask):
        return int(any(mask))
    return sum(1 for i, m in enumerate(mask) if m and not mask[i - 1])


def benjamini_hochberg(p: list[float], q: float = FDR) -> list[bool]:
    """Which p-values remain significant at false discovery rate `q`."""
    order = sorted(range(len(p)), key=p.__getitem__)
    k = max((i + 1 for i, j in enumerate(order) if p[j] <= q * (i + 1) / len(p)), default=0)
    out = [False] * len(p)
    for j in order[:k]:
        out[j] = True
    return out


def permutation_p(t: Table, rng: random.Random, n: int = PERMUTATIONS) -> list[float]:
    """One-sided p-value of each month's mean intensity under no seasonality.

    Shuffling the months within each year gives every month, in each year, a uniformly random one
    of that year's intensities; the null distribution of a month's mean is therefore the mean over
    years of one random intensity per year, the same for every month."""
    rows = [[v for v in row if v is not None] for row in t.intensity]
    rows = [r for r in rows if r]
    if not rows:
        return [1.0] * MONTHS.periods
    null = []
    for _ in range(n):
        null.append(sum(r[int(rng.random() * len(r))] for r in rows) / len(rows))
    null.sort()
    out = []
    for p in range(1, MONTHS.periods + 1):
        col = critical.column(t, p)
        obs = mean(col) if col else 0.0
        ge = len(null) - bisect.bisect_left(null, obs - 1e-12)
        out.append((1 + ge) / (1 + n))
    return out


def giglio(t: Table) -> list[bool]:
    """Months whose mean total is at least 10 % of the mean annual total (Giglio et al. 2006)."""
    means = [mean(row[p] or 0.0 for row in t.total) for p in range(MONTHS.periods)]
    return [m >= 0.1 * sum(means) for m in means] if sum(means) else [False] * MONTHS.periods


def run80(t: Table) -> list[bool]:
    """Shortest run of consecutive months (wrapping) holding over 80 % of the mean annual total."""
    means = [mean(row[p] or 0.0 for row in t.total) for p in range(MONTHS.periods)]
    total = sum(means)
    if not total:
        return [False] * MONTHS.periods
    for length in range(1, MONTHS.periods + 1):
        start = max(range(MONTHS.periods), key=lambda s: sum(means[(s + k) % 12] for k in range(length)))
        if sum(means[(start + k) % 12] for k in range(length)) > 0.8 * total:
            return [any((start + k) % 12 == m for k in range(length)) for m in range(MONTHS.periods)]
    return [True] * MONTHS.periods


def _names(mask: list[bool]) -> str:
    return ",".join(MONTH_NAMES[i] for i, m in enumerate(mask) if m) or "-"


def _tier(a: Area, lo: float, hi: float) -> bool:
    return lo <= a.mean_annual < hi


def _label(lo: float, hi: float) -> str:
    return f"{lo:g}+" if hi == math.inf else f"{lo:g}-{hi:g}"


def stability(areas: list[Area], table_of: Callable[[Area], Table], periods: int, variant: str) -> dict:
    """Per tier: even/odd agreement, share of flags changed by leaving one year out, share of areas
    with a broken-up season, and agreement with the chosen definition."""
    out = {}
    for lo, hi in TIERS:
        sel = [a for a in areas if _tier(a, lo, hi)]
        halves, changed, broken, same = [], [], [], []
        for a in sel:
            t = table_of(a)
            years = range(len(t.years))
            even = {i for i in years if t.years[i] % 2 == 0}
            full = flags(t, periods, None, variant)
            x, y = flags(t, periods, even, variant), flags(t, periods, set(years) - even, variant)
            if any(x) or any(y):
                halves.append(jaccard(x, y))
            flips = sum(sum(f != g for f, g in zip(full, flags(t, periods, set(years) - {i}, variant))) for i in years)
            changed.append(flips / (len(t.years) * periods))
            broken.append(runs(full) > 1)
            same.append(jaccard(full, flags(t, periods)))
        out[(lo, hi)] = {"n": len(sel), "halves": mean(halves) if halves else math.nan,
                         "changed": mean(changed) if changed else math.nan,
                         "broken": mean(broken) if broken else math.nan, "same": mean(same) if same else math.nan}
    return out


def report(areas: list[Area]) -> None:
    """Prints every validation table."""
    rng = random.Random(SEED)
    local = [a for a in areas if a.level in ("province", "regency") and a.mean_annual > 0]
    top = [a for a in areas if a.level in ("country", "province")]
    top.sort(key=lambda a: -a.mean_annual)
    pvals = {a.id: permutation_p(a.months, rng) for a in areas if a.mean_annual > 0}

    print(f"Record: complete years {areas[0].months.years[0]}-{areas[0].months.years[-1]}; "
          f"{len(local)} provinces and cities/regencies with any fire.\n")
    print("1. Critical months of the country and provinces, against published definitions")
    print(f"   {'area':28} {'cd/yr':>8}  {'critical':20} {'significant':20} {'Giglio 10%':22} {'80% run':26} peak")
    jg, jr = [], []
    for a in top:
        crit = flags(a.months, 12)
        sig = benjamini_hochberg(pvals[a.id])
        g, r = giglio(a.months), run80(a.months)
        jg.append(jaccard(crit, g))
        jr.append(jaccard(crit, r))
        typical = [critical.assess(critical.column(a.months, p))[1] for p in range(1, 13)]
        peak = max(range(12), key=typical.__getitem__)
        print(f"   {a.name[:28]:28} {a.mean_annual:8.0f}  {_names(crit):20} {_names(sig):20} {_names(g):22} "
              f"{_names(r):26} {MONTH_NAMES[peak]} {typical[peak]:.1f}x")
    print(f"   Mean Jaccard with Giglio 10%: {mean(jg):.2f}; with 80% run: {mean(jr):.2f} ({len(top)} areas)")
    riau = next((a for a in areas if a.id == "idn-riau"), None)
    if riau:
        print("   Riau: " + "; ".join(
            f"{MONTH_NAMES[p - 1]} {v[1]:.2f}x {v[2]}/{v[3]} p={pvals[riau.id][p - 1]:.3f}"
            for p in range(1, 13) for v in [critical.assess(critical.column(riau.months, p))]))

    print("\n2. Permutation test of months (Benjamini-Hochberg, q = 0.05)")
    print(f"   {'cd/yr':10} {'areas':>6} {'critical months significant':>28} {'significant, not critical, per area':>36}")
    for lo, hi in TIERS:
        sel = [a for a in local if _tier(a, lo, hi)]
        hit, miss = [], []
        for a in sel:
            crit, sig = flags(a.months, 12), benjamini_hochberg(pvals[a.id])
            if any(crit):
                hit.append(sum(c and s for c, s in zip(crit, sig)) / sum(crit))
            miss.append(sum(s and not c for c, s in zip(crit, sig)))
        print(f"   {_label(lo, hi):10} {len(sel):6} {100 * mean(hit):27.0f}% {mean(miss):36.2f}")

    print("\n3. Stability of month flags by variant, per mean annual activity (cell-days/yr)")
    print("   even/odd agreement | flags changed by leaving one year out | areas with broken-up season | same as chosen")
    print(f"   {'variant':40}" + "".join(f"{_label(lo, hi):>30}" for lo, hi in TIERS))
    for name in VARIANTS:
        s = stability(local, lambda a: a.months, 12, name)
        print(f"   {name[:40]:40}" + "".join(
            f"{v['halves']:6.2f} {100 * v['changed']:5.1f}% {100 * v['broken']:4.0f}% {v['same']:5.2f}   "
            for v in s.values()))

    print("\n4. Stability of week flags (weeks 1-52) by window, per mean annual activity")
    print("   even/odd agreement | areas with broken-up season | mean critical weeks")
    for w in WINDOWS:
        s = stability(local, lambda a, w=w: a.weeks[w], WEEK_SPAN, next(iter(VARIANTS)))
        counts = {(lo, hi): mean(sum(flags(a.weeks[w], WEEK_SPAN)) for a in local if _tier(a, lo, hi)) for lo, hi in TIERS}
        print(f"   {w}-week " + "".join(
            f"{_label(lo, hi):>9}: {v['halves']:.2f} {100 * v['broken']:3.0f}% {counts[(lo, hi)]:4.1f}"
            for (lo, hi), v in s.items()))
    idn = next((a for a in areas if a.id == "idn"), None)
    if idn:
        for w in WINDOWS:
            wk = [p for p, f in enumerate(flags(idn.weeks[w], WEEKS.periods), 1) if f]
            print(f"   Indonesia, {w}-week window: weeks {wk[0]}-{wk[-1]} ({len(wk)})" if wk else f"   {w}-week: none")

    print("\n5. Even/odd agreement by mean annual activity (confidence levels)")
    print(f"   {'cd/yr':10} {'areas':>6} {'months':>8} {'weeks (3)':>10}")
    for lo, hi in zip(CONFIDENCE_BANDS, CONFIDENCE_BANDS[1:]):
        sel = [a for a in local if lo <= a.mean_annual < hi]
        m = stability_halves(sel, lambda a: a.months, 12)
        w = stability_halves(sel, lambda a: a.weeks[critical.WEEK_WINDOW], WEEK_SPAN)
        print(f"   {_label(lo, hi):10} {len(sel):6} {m:8.2f} {w:10.2f}")
    low = sum(1 for a in local if critical.confidence(a.mean_annual) == "low")
    print(f"   Areas rated low confidence: {low} of {len(local)}")


def stability_halves(areas: list[Area], table_of: Callable[[Area], Table], periods: int) -> float:
    """Mean even/odd agreement of the chosen definition over areas with any flag in either half."""
    out = []
    for a in areas:
        t = table_of(a)
        even = {i for i, y in enumerate(t.years) if y % 2 == 0}
        x, y = flags(t, periods, even), flags(t, periods, set(range(len(t.years))) - even)
        if any(x) or any(y):
            out.append(jaccard(x, y))
    return mean(out) if out else math.nan


def run() -> None:
    """Loads the record of every area and prints the validation report."""
    con = store.connect(weights.load_params())
    if not store.has(con, "days", "cells", "region_daily"):
        raise SystemExit("The derived tables are missing. Run `python -m app all` first.")
    areas = load(con)
    log.info("loaded %d areas", len(areas))
    report(areas)
