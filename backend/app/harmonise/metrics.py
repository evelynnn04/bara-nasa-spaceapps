"""Agreement metrics between two monthly series and the convergence verdict.

The thresholds were fixed before any fit and must not be edited to make a result pass.
"""

from __future__ import annotations

import math
from fractions import Fraction

THRESHOLDS = {
    "converged": {"r_log_min": 0.95, "malr_max": 0.25, "peak_min": Fraction(6, 7)},
    "partial": {"r_log_min": 0.90, "malr_max": 0.50},
}
#: Months with fewer counts than this on either side are left out of the ratio metrics.
MIN_COUNT_FOR_RATIO = 10
#: A year needs this many months for its peak month to be compared.
MIN_MONTHS_FOR_PEAK = 10
#: An area with less overlap than this many months gets "insufficient data".
MIN_MONTHS_FOR_VERDICT = 24


def _median(xs: list[float]) -> float | None:
    if not xs:
        return None
    s = sorted(xs)
    k = len(s) // 2
    return s[k] if len(s) % 2 else (s[k - 1] + s[k]) / 2


def agreement(pairs: list[tuple[int, int, float, float]]) -> dict:
    """Agreement of `pairs` = [(year, month, a, b)], a the MODIS side and b the VIIRS side.

    - r_log: Pearson correlation of log(1 + count).
    - malr: median |ln(b / a)| over months where both are at least `MIN_COUNT_FOR_RATIO`.
    - bias: exp(median ln(b / a)) over the same months.
    - peak: share of years (with at least `MIN_MONTHS_FOR_PEAK` months) where both name the same
      peak month, kept as an exact fraction (`peak_matches` / `peak_years`)."""
    n = len(pairs)
    out: dict = {"n_months": n, "r_log": None, "malr": None, "bias": None,
                 "peak_matches": 0, "peak_years": 0, "peak_agreement": None, "peaks": {}}
    if n < 3:
        return out
    la = [math.log1p(a) for _, _, a, _ in pairs]
    lb = [math.log1p(b) for _, _, _, b in pairs]
    ma, mb = sum(la) / n, sum(lb) / n
    va = sum((x - ma) ** 2 for x in la)
    vb = sum((y - mb) ** 2 for y in lb)
    cov = sum((x - ma) * (y - mb) for x, y in zip(la, lb))
    out["r_log"] = cov / math.sqrt(va * vb) if va > 0 and vb > 0 else None

    ratios = [math.log(b / a) for _, _, a, b in pairs if a >= MIN_COUNT_FOR_RATIO and b >= MIN_COUNT_FOR_RATIO]
    out["n_ratio_months"] = len(ratios)
    med = _median(ratios)
    out["malr"] = _median([abs(x) for x in ratios])
    out["bias"] = None if med is None else math.exp(med)

    matches = years = 0
    for year in sorted({y for y, *_ in pairs}):
        rows = [(m, a, b) for y, m, a, b in pairs if y == year]
        if len(rows) < MIN_MONTHS_FOR_PEAK:
            continue
        pa = max(rows, key=lambda r: r[1])[0]
        pb = max(rows, key=lambda r: r[2])[0]
        out["peaks"][str(year)] = [pa, pb]
        years += 1
        matches += pa == pb
    out["peak_matches"], out["peak_years"] = matches, years
    out["peak_agreement"] = matches / years if years else None
    return out


def verdict(m: dict) -> str:
    """converged | partial | did not converge | insufficient data.

    The peak test compares the exact fraction of matching years, so exactly 6 of 7 passes."""
    if (m.get("n_months") or 0) < MIN_MONTHS_FOR_VERDICT or m.get("r_log") is None or m.get("malr") is None:
        return "insufficient data"
    c, p = THRESHOLDS["converged"], THRESHOLDS["partial"]
    years = m.get("peak_years") or 0
    peak_ok = years > 0 and Fraction(m["peak_matches"], years) >= c["peak_min"]
    if m["r_log"] >= c["r_log_min"] and m["malr"] <= c["malr_max"] and peak_ok:
        return "converged"
    if m["r_log"] >= p["r_log_min"] and m["malr"] <= p["malr_max"]:
        return "partial"
    return "did not converge"


def rounded(m: dict, digits: int = 4) -> dict:
    """Copy of a metrics dict with floats rounded for storage and display (verdicts use the exact values)."""
    return {k: round(v, digits) if isinstance(v, float) else v for k, v in m.items()}
