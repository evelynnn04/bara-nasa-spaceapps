# MODIS–VIIRS harmonisation

This document describes how the burning activity calendar turns two satellite fire records into one
consistent time series for Indonesia, how the method was fitted and tested, and how well it works.

## The problem

NASA FIRMS publishes active fire pixels from two instrument families:

| | MODIS | VIIRS |
|---|---|---|
| Satellites | Terra (from 2000), Aqua (from 4 July 2002) | S-NPP (2012), NOAA-20 (2018), NOAA-21 (2023) |
| Pixel size at nadir | about 1 km | 375 m |
| Smallest fires seen | larger | much smaller |

A VIIRS pixel covers about one seventh of the area of a MODIS pixel, and VIIRS detects far smaller
fires, so the same fire produces many more VIIRS detections. Over Indonesia, raw VIIRS detections
outnumber Aqua MODIS detections about seven to one (2012–2025). That ratio is not constant:

- it is higher where and when fires are small;
- raw counts can disagree on which month a season peaks (in 2015, MODIS says September and VIIRS
  says October).

The MODIS record is the long one (from 2002), but MODIS is ageing. VIIRS is its successor. A
calendar spanning both needs one unit in which the sensor of origin no longer matters.

A hard fire radiative power floor, counting a VIIRS cell only above about 13 MW by day and 14 MW by
night (roughly what MODIS can see), discards about 72 % of VIIRS cell-days and distorts the seasonal
shape, so it is not used.

## The method

**Unit:** MODIS-equivalent active fire cell-days on a 0.05° grid (about 5.5 km).

A **cell-day** is one grid cell (`cx = floor(lon / 0.05)`, `cy = floor(lat / 0.05)`) on one local
solar day (UTC + longitude / 15 hours). Values are generally not whole numbers.

**Detections counted** (both sensors):
- presumed vegetation fires only (FIRMS `type = 0`);
- all confidence classes;
- exact duplicate rows removed.

Near-real-time rows have no `type` yet. They count as vegetation fires unless they fall on a
static-source mask built from typed detections (gas flares, volcanoes, other static sources).

**Weights:**

- **MODIS (Aqua):** a cell-day counts 1 if Aqua detected at least one qualifying pixel in it.
- **VIIRS:** a cell-day counts

  ```
  w = sqrt(n) / k[r, m]        ln k[r, m] = mu + rho_r + sigma_m
  ```

  where
  - `n` is the number of qualifying pixels in the cell that day, from the day's reference satellite;
  - `r` is the cell's island group;
  - `m` is the calendar month.

In plain words: VIIRS cells count the square root of their pixels, scaled by an island-group and
month factor; MODIS cells count once.

The square root reflects that many small VIIRS pixels in one cell usually describe one fire that
MODIS would see as one or a few pixels. The factor absorbs what remains: the overall sensitivity
difference, and its variation with typical fire size by region and season. The exponent 0.5 is
fixed, not fitted.

**Day/night filter:** with only "day" selected, `n` is the daytime pixel count and a MODIS cell-day
counts only if it has daytime pixels. Night works the same way.

**Island group of a cell:** the province (geoBoundaries ADM1) containing the cell centre
`((cx + 0.5) · 0.05, (cy + 0.5) · 0.05)`. Failing that, the nearest province within 0.3°; failing
that, `Other`, whose region effect is fixed at 0.

| Island group | Provinces |
|---|---|
| Sumatra | Aceh, North/West/South Sumatra, Riau, Jambi, Bengkulu, Lampung, Bangka-Belitung Islands, Riau Islands |
| Kalimantan | West, Central, South, East and North Kalimantan |
| Papua | Papua, West Papua |
| Java-Bali-NT | Jakarta, West/Central/East Java, Yogyakarta, Banten, Bali, West and East Nusa Tenggara |
| Sulawesi-Maluku | North, Central, South, Southeast and West Sulawesi; Gorontalo; Maluku; North Maluku |

**The spliced record:**

- **Aqua MODIS before 1 February 2012** (from 4 July 2002). Terra-only months before Aqua are
  shown as raw data only, not as part of the harmonised record.
- **VIIRS from 1 February 2012**, one satellite per day: S-NPP if it observed that day, else
  NOAA-20, else NOAA-21. A new satellite therefore never reads as more fire.

**Areas:** the value for any area and period is the sum of the weights over its cells and days. The
method is additive, so it works for any drawn area. A cell belongs to an area when its centre lies
inside it.

**Missing stays missing:** a day the record's satellite did not observe Indonesia has no value. It
is never shown as zero.

## Fitting

The factors are fitted on every **paired day** from 1 February 2012 to 31 December 2025: days on
which both Aqua and the VIIRS reference satellite observed Indonesia.

- **VIIRS:** a day with no detection of any type, nationally, is an outage.
- **MODIS:** quiet days are real, so only runs of three or more empty days count as gaps.

Without this rule, known Aqua outages (17 August – 2 September 2020, 1–16 April 2022) would read as
"MODIS saw no fire" and dominate the error.

**Fitting procedure:** iterative proportional fitting with shrinkage (`n0 = 2000`, 8 iterations).
For stratum g, let
- `A_g` be the MODIS cell-days,
- `B_g` the sum of `sqrt(n)` over VIIRS cell-days,
- `N_g` the MODIS cell-days.

Then:

1. `mu = ln(B / A)` over all paired days; every effect starts at 0.
2. For each island group r: `rho_r = N_r / (N_r + n0) · ln(B_r / sum over r of exp(mu + sigma_m))`.
3. For each month m: `sigma_m = N_m / (N_m + n0) · ln(B_m / sum over m of exp(mu + rho_r))`.
4. Steps 2 and 3 are repeated, 8 times in all.

The shrinkage keeps sparse strata close to the national factor. The fitted values are written to
`backend/app/harmonise/params.json` by `python -m app fit`, which every query reads.

## Evaluation

All comparisons use monthly series on paired days: `a` = MODIS cell-days, `b` = harmonised VIIRS.

| Metric | Definition |
|---|---|
| `r_log` | Pearson correlation of `log(1 + count)` |
| `malr` | median of `\|ln(b / a)\|` over months where both are at least 10 |
| `bias` | `exp(median ln(b / a))` over the same months |
| peak agreement | share of years (with at least 10 months) in which both name the same peak month, as an exact fraction |

| Verdict | Requires |
|---|---|
| converged | `r_log ≥ 0.95`, `malr ≤ 0.25` and peak agreement ≥ 6/7 |
| partial | `r_log ≥ 0.90` and `malr ≤ 0.50` |
| did not converge | otherwise |

These thresholds were set before fitting and are not tuned to the result.

- **Main test, leave-one-year-out:** each year 2012–2025 is predicted with factors fitted on the
  other 13 years.
- **Also reported:**
  - an even-years-train / odd-years-test split;
  - September ÷ October 2015 for both sensors;
  - a control: S-NPP against NOAA-20 under the same VIIRS weights, May 2018 – December 2025, on
    days both observed. Two copies of one instrument should come out "converged", which shows the
    metric does not invent disagreement.

## Results

From `backend/app/harmonise/params.json` (fit window 1 February 2012 – 31 December 2025).

**Factors:** base factor `e^mu` = 6.509 (`mu` = 1.8732).

| Island group | Factor |
|---|---|
| Java-Bali-NT | 1.581 |
| Sulawesi-Maluku | 1.152 |
| Sumatra | 0.930 |
| Papua | 0.858 |
| Kalimantan | 0.842 |
| Other | 1.000 (fixed) |

| Jan | Feb | Mar | Apr | May | Jun | Jul | Aug | Sep | Oct | Nov | Dec |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1.033 | 1.096 | 1.131 | 0.965 | 0.960 | 0.955 | 0.905 | 0.936 | 1.007 | 1.142 | 1.112 | 1.032 |

A VIIRS cell-day in Riau in September, for example, is divided by 6.509 × 0.930 × 1.007 ≈ 6.10, so
7 pixels count `sqrt(7) / 6.10` ≈ 0.43 and a cell needs about 42 pixels to count as one MODIS
cell-day nationally.

**Evaluation:**

| Test | r_log | malr | bias | Peak agreement | Verdict |
|---|---|---|---|---|---|
| Leave-one-year-out, national | 0.995 | 0.079 | 1.00 | 11/14 | partial |
| Even years train, odd years test | 0.995 | 0.090 | 1.04 | 4/7 | partial |
| Control: S-NPP vs NOAA-20 | 0.998 | 0.044 | 1.02 | 6/7 | converged |

| Leave-one-year-out by island group | r_log | malr | bias | Peak agreement | Verdict |
|---|---|---|---|---|---|
| Sumatra | 0.984 | 0.136 | 0.96 | 12/14 | converged |
| Kalimantan | 0.990 | 0.142 | 1.05 | 12/14 | converged |
| Java-Bali-NT | 0.973 | 0.121 | 1.00 | 11/14 | partial |
| Sulawesi-Maluku | 0.976 | 0.157 | 1.09 | 13/14 | converged |
| Papua | 0.979 | 0.157 | 1.05 | 13/14 | converged |

The national verdict is **partial**: the levels agree closely (a typical monthly difference of
about 8 %, no overall bias), but the two records name a different peak month in three of fourteen
years. All three are near-ties:

| Year | MODIS peak | VIIRS peak | MODIS margin | VIIRS margin |
|---|---|---|---|---|
| 2013 | September | August | 1.3 % | 4.0 % |
| 2023 | October | September | 4.0 % | 7.7 % |
| 2025 | July | September | 3.6 % | 4.6 % |

**The 2015 season:** September ÷ October is 1.13 for MODIS cell-days and 1.10 for harmonised VIIRS
when 2015 is predicted from the other years (1.12 with the factors fitted on all years, which the
dashboard uses), so both name September. Raw VIIRS pixels give 0.92 and would name October.

**Distribution of VIIRS cell-days:** 58 % hold a single pixel and the 99th percentile is 19 pixels,
so most cell-days sit far below the 42 pixels that count as one MODIS cell-day.

**Data used:** FIRMS standard product and archive for 2000–2025 plus 2026 to date (near-real-time
where the standard product is not yet published), 8.9 million detections after cleaning, 3.8
million cell-days over 49,345 cells.

## Fire radiative power

The same fit also harmonises fire radiative power, for the anomaly scores (see
[anomaly.md](anomaly.md)). FRP adds up over pixels, so there is no square root: a VIIRS cell-day's
FRP is divided by `kf[r, m]`, fitted like `k` on paired-day monthly FRP sums, with the shrinkage
still weighted by MODIS cell-days. Aqua FRP is kept as it is. Base factor 1.881; leave one year out,
nationally: `r_log` 0.994, `malr` 0.126, bias 1.09, verdict partial. The factors are written under
`frp` in `params.json`.

## References

- Giglio, L., Schroeder, W., Justice, C. O. (2016). The collection 6 MODIS active fire detection algorithm and fire products. *Remote Sensing of Environment* 178, 31–41. doi:10.1016/j.rse.2016.02.054
- Schroeder, W., Oliva, P., Giglio, L., Csiszar, I. A. (2014). The New VIIRS 375 m active fire detection data product: algorithm description and initial assessment. *Remote Sensing of Environment* 143, 85–96. doi:10.1016/j.rse.2013.12.008
- Li, F., Zhang, X., Kondragunta, S., Csiszar, I. (2018). Comparison of fire radiative power estimates from VIIRS and MODIS observations. *Journal of Geophysical Research: Atmospheres* 123(9), 4545–4563. doi:10.1029/2017JD027823
- Kaiser, J. W., et al. (2012). Biomass burning emissions estimated with a global fire assimilation system based on observed fire radiative power. *Biogeosciences* 9, 527–554. doi:10.5194/bg-9-527-2012
- Remy, S., Kaiser, J. W. (2014). Daily global fire radiative power fields estimation from one or two MODIS instruments. *Atmospheric Chemistry and Physics* 14, 13377. doi:10.5194/acp-14-13377-2014
- Chen, Y., et al. (2023). Multi-decadal trends and variability in burned area from the fifth version of the Global Fire Emissions Database (GFED5). *Earth System Science Data* 15, 5227–5259. doi:10.5194/essd-15-5227-2023
- Chen et al. (2026). *Earth System Science Data* 18, 7535 (GFED5NRT, near-real-time GFED5). doi:10.5194/essd-18-7535-2026
- Zheng, et al. (2026). *Remote Sensing* 18(10), 1650 (fusion of MYD14 and VNP14IMG fire radiative power). doi:10.3390/rs18101650
