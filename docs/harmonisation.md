# MODIS–VIIRS harmonisation

This document describes how the burning activity calendar turns two satellite fire records into one
consistent record of hotspot counts for Indonesia, how the method was chosen and fitted, and how
well it works.

## The problem

NASA FIRMS publishes active fire hotspots from two instrument families:

| | MODIS | VIIRS |
|---|---|---|
| Satellites | Terra (from 2000), Aqua (from 4 July 2002) | S-NPP (2012), NOAA-20 (2018), NOAA-21 (2023) |
| Pixel size at nadir | about 1 km | 375 m |
| Smallest fires seen | larger | much smaller |

The challenge asks for a calendar of **hotspot counts**. A VIIRS pixel covers about one seventh of
the area of a MODIS pixel and VIIRS detects far smaller fires, so the same fire produces many more
VIIRS hotspots: over Indonesia, about seven VIIRS hotspots for every Aqua hotspot (2012–2025). The
ratio is not constant:

- it differs by island group and season, with typical fire size;
- it is far higher at night than by day, and the night share of hotspots changes from year to year
  (see "Why day and night are converted separately");
- raw counts can disagree on which month a season peaks (in 2015, MODIS says September and raw VIIRS
  says October).

The MODIS record is the long one (from 2002), but MODIS is ageing and VIIRS is its successor. A
calendar spanning both needs one unit in which the sensor of origin no longer matters.

## The method

**Unit:** hotspots, Aqua MODIS-equivalent.

- **Aqua MODIS:** each hotspot counts 1. Before 1 February 2012 the record is the FIRMS Aqua count
  as it is.
- **VIIRS** (from 1 February 2012): each hotspot counts

  ```
  1 / k_d[r, m]        ln k_d[r, m] = mu_d + rho_d,r + sigma_d,m
  ```

  where
  - `d` is its half of the day, from the FIRMS `daynight` flag (day or night);
  - `r` is the island group of its 0.05° cell;
  - `m` is the calendar month of its local solar date.

Per cell and day, with the counts the cell-day table stores:

```
MODIS:  n_day + n_night
VIIRS:  n_day / k_day[r, m] + n_night / k_night[r, m]
```

In plain words: an Aqua hotspot counts once; a VIIRS hotspot counts a fraction of one, set by its
island group, month and whether it was seen by day or at night.

**Day/night filter:** with only "day" selected, only daytime hotspots count, on both sides, divided
by the day factor. Night works the same way. The "all" view is the sum of the two halves, each with
its own factor; it is not `(n_day + n_night)` divided by one factor.

**Hotspot types:** two settings, each with its own fitted factors.

- `vegetation` (the default): presumed vegetation fires, FIRMS `type = 0`, plus untyped
  near-real-time hotspots that do not fall on a static-source mask built from typed detections.
- `all`: every hotspot, including volcanoes, gas flares and other static sources (types 0 to 3 and
  every untyped hotspot).

**Also counted:** all confidence classes; exact duplicate rows are removed.

**Island group of a cell:** the province (geoBoundaries ADM1) containing the cell centre
`((cx + 0.5) · 0.05, (cy + 0.5) · 0.05)`, with `cx = floor(lon / 0.05)` and `cy = floor(lat / 0.05)`.
Failing that, the nearest province within 0.3°; failing that, `Other`, whose island effect is fixed
at 0.

| Island group | Provinces |
|---|---|
| Sumatra | Aceh, North/West/South Sumatra, Riau, Jambi, Bengkulu, Lampung, Bangka-Belitung Islands, Riau Islands |
| Kalimantan | West, Central, South, East and North Kalimantan |
| Papua | Papua, West Papua |
| Java-Bali-NT | Jakarta, West/Central/East Java, Yogyakarta, Banten, Bali, West and East Nusa Tenggara |
| Sulawesi-Maluku | North, Central, South, Southeast and West Sulawesi; Gorontalo; Maluku; North Maluku |

**The spliced record:**

- **Aqua MODIS before 1 February 2012** (from 4 July 2002). Terra is not used: it crosses in the
  morning, and its overpass time has drifted.
- **VIIRS from 1 February 2012**, one satellite per day: S-NPP if it observed that day, else
  NOAA-20, else NOAA-21. A new satellite therefore never reads as more fire.

**Areas:** the value for any area and period is a sum over its cells and days. The method is
additive, so it works for any drawn area. A cell belongs to an area when its centre lies inside it.

**Missing stays missing:** a day the record's satellite did not observe Indonesia has no value. It
is never shown as zero.

**Example.** In Riau (Sumatra) in September, the day factor is 5.937 × 0.896 × 1.049 = 5.58 and the
night factor 17.558 × 0.880 × 1.044 = 16.13. Seven daytime and three night-time VIIRS hotspots count
7 / 5.58 + 3 / 16.13 = 1.44 hotspots.

**Fire radiative power**, used by the anomaly scores (see [anomaly.md](anomaly.md)), is harmonised
the same way: Aqua FRP as it is, VIIRS FRP of each half divided by its own factor `kf_d[r, m]`,
fitted like `k_d` on FRP sums.

## Why day and night are converted separately

VIIRS hotspots per Aqua hotspot, on paired days:

| Year | 2012 | 2013 | 2014 | 2015 | 2016 | 2017 | 2018 | 2019 | 2020 | 2021 | 2022 | 2023 | 2024 | 2025 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Day and night together | 6.3 | 6.8 | 7.6 | 8.4 | 6.8 | 7.1 | 7.4 | 8.0 | 7.6 | 7.1 | 7.3 | 7.0 | 6.4 | 6.9 |
| Daytime only | 5.2 | 5.6 | 6.0 | 5.9 | 5.8 | 6.5 | 6.4 | 6.3 | 6.7 | 6.2 | 6.5 | 6.0 | 5.6 | 6.2 |
| Night only | 19 | 16 | 16 | 19 | 20 | 27 | 18 | 14 | 27 | 30 | 56 | 19 | 32 | 27 |
| Night share of VIIRS hotspots | 25 % | 26 % | 34 % | 44 % | 20 % | 12 % | 21 % | 38 % | 16 % | 16 % | 12 % | 22 % | 16 % | 14 % |

- **The daytime ratio is steady**, between 5.2 and 6.7.
- **The night ratio is much higher and unstable**, between 14 and 56. At night the 375 m VIIRS band
  detects small and smouldering fires that Aqua MODIS mostly misses (Schroeder et al. 2014).
- **The night share follows the fire year.** It is highest in the big peat-fire years 2015 and 2019.
- **One factor for both halves is therefore wrong whenever the night share is unusual:** it
  overstates big-fire years and understates quiet ones. With one shared factor the night-only view
  reads 3.4 times MODIS; with separate factors, 1.3 times.

## Fitting

The factors are fitted on every **paired day** from 1 February 2012 to 31 December 2025: days on
which both Aqua and the VIIRS reference satellite observed Indonesia.

- **VIIRS:** a day with no detection of any type, nationally, is an outage.
- **MODIS:** quiet days are real, so only runs of three or more empty days count as gaps. This
  removes the documented Aqua outages (17 August – 2 September 2020, 1–16 April 2022), which would
  otherwise read as "MODIS saw no fire".

**Fitting procedure:** for each type setting and each half of the day separately, let `A[r,m]` be
the Aqua hotspots and `B[r,m]` the VIIRS reference hotspots of island group `r` and month `m` on
paired days. Start with `mu = ln(sum B / sum A)` and every effect at 0, then repeat

```
rho_r   = s_r · ln( B_r / sum_m A[r,m] · exp(mu + sigma_m) ),   s_r = A_r / (A_r + n0)
sigma_m = s_m · ln( B_m / sum_r A[r,m] · exp(mu + rho_r) ),     s_m = A_m / (A_m + n0)
```

until no effect changes by more than 1e-6 (at most 10,000 rounds), with `n0 = 2000` hotspots.

- This is iterative proportional fitting, the standard fit of a log-linear model to its margins
  (Deming & Stephan 1940; Bishop, Fienberg & Holland 1975).
- The shrinkage weight `A / (A + n0)` keeps sparse strata close to the national factor (credibility
  weighting, Bühlmann 1967).
- The vegetation fits stop after 103 rounds (day) and 31 rounds (night); the all-types fits after
  109 and 28.
- FRP factors are fitted the same way on FRP sums, with the same shrinkage weight (Aqua hotspots).

The fitted values, the evaluation below and the monthly national series are written to
`src/backend/app/harmonise/params.json` by `python -m app fit`, which every query reads.

## Choosing the method

Before settling on this method we compared 12 methods from the literature and 15 new variants on
this data, all in hotspot units.

**Scoring.** Every method is scored on monthly series over paired days, `a` the Aqua count and `b`
the harmonised VIIRS value, with three metrics, each answering a question the calendar is used for:

| Metric | Calendar question | Definition |
|---|---|---|
| Monthly amount error | How many hotspots were there? | mean of `\|ln((b + c) / (a + c))\|` over months, `c = max(1, 0.5 % of the mean of a)` (Morley et al. 2018) |
| Anomaly class mismatch | Is this month above or below normal? | share of months where `b` and `a` fall in different classes of the ratio to MODIS's own calendar-month median (below 0.5, 0.5–0.8, 0.8–1.25, 1.25–2, above 2) |
| Seasonal shape error | Which months burn most? | mean over years of the sum over months of `\|a_m / sum a − b_m / sum b\|` |

Each metric becomes a skill, `max(−1, (e_ref − e) / (e_ref − e_twin))`, where the reference (0) is
one national ratio and the ceiling (1) is S-NPP against NOAA-20, two copies of one instrument. The
score is the mean of nine skills: three metrics, each for Indonesia, the five island groups and 22
provinces.

**Validation.** Leave-one-year-out cross-validation (Roberts et al. 2017); a forward test with
factors fitted on 2012–2018 and frozen for 2019–2025 (Bergmeir & Benítez 2012); and a test on
January–October 2026, opened once after the finalists were fixed. A method counts as better only when
the 95 % bootstrap interval of the score difference (500 resamples over years) excludes zero; among
tied methods the simplest is taken (Hastie et al. 2009).

| Method | Cross-validation, vegetation | Cross-validation, all types | Forward test | 2026 test |
|---|---:|---:|---:|---:|
| One national ratio | 0.000 | 0.000 | 0.000 | 0.000 |
| Ratio by island group and month, day and night together | 0.119 | 0.122 | −0.055 | 0.222 |
| Detection-probability weight per VIIRS pixel | 0.231 | 0.198 | 0.034 | 0.194 |
| **Day and night separately, island group and month (chosen)** | **0.281** | **0.168** | **0.082** | **0.260** |
| Day and night separately, island group × month | 0.287 | 0.185 | 0.072 | 0.300 |
| Footprint detection operator at 0.01° | 0.271 | 0.216 | 0.013 | 0.236 |

- **Converting day and night separately is the one step that gave a significant gain.** The chosen
  method beats one national ratio by +0.17 to +0.40 and the same model without the day/night split by
  +0.06 to +0.30 (95 % intervals). Against every other finalist the interval includes zero, so the
  simplest of them is chosen.
- **It holds on unseen data:** 0.260 on January–October 2026, about its cross-validation score. Both
  records name September as the 2026 peak, and the 2026 total is 5.6 % below MODIS.
- Methods fitted per area (regressions, quantile mapping) cannot be summed over a drawn area, so they
  cannot serve the app. A fire radiative power conversion fails because energy per hotspot changes
  with fire activity.

**Choices tested on the data:**

| Choice | Basis | Test |
|---|---|---|
| Raw Aqua hotspots as the target | The challenge asks for hotspot counts; values before 2012 stay identical to FIRMS | Removing MODIS scan-edge duplicates (Freeborn et al. 2011) changes nothing |
| Aqua only | Same early-afternoon overpass as VIIRS (Giglio 2007) | Terra and Aqua together score worse |
| S-NPP, else NOAA-20, else NOAA-21 | One satellite per day (Remy & Kaiser 2014) | NOAA-20 first scores worse |
| All confidence classes | MODIS and VIIRS define confidence differently (Giglio et al. 2016; Schroeder et al. 2014) | Nominal and high only scores worse |
| Island group and calendar month | Regional scaling fitted on an overlap period, as for the near-real-time GFED5 extension (Chen et al. 2026; Giglio et al. 2010) | Finer strata are not significantly better |
| Separate day and night factors | VIIRS gains far more over coarser sensors at night (Schroeder et al. 2014) | The only significant gain |

## Evaluation

The checks below use the repository's own metrics on monthly series over paired days: `a` = Aqua
hotspots, `b` = harmonised VIIRS.

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
  other 13 years, for day and night together, day only and night only.
- **Also reported:**
  - an even-years-train / odd-years-test split;
  - the years in which the records name a different peak month, with the share of 1,000 resamples
    of MODIS's paired days (drawn with replacement within each month) in which MODIS itself names the
    VIIRS month;
  - September ÷ October 2015 for both sensors;
  - a control: S-NPP against NOAA-20 under the same VIIRS factors, May 2018 – December 2025, on days
    both observed. Two copies of one instrument should come out "converged", which shows the metrics
    do not invent disagreement.

## Results

From `src/backend/app/harmonise/params.json` (fit window 1 February 2012 – 31 December 2025).

**Factors.** Island and month values are multipliers on the base factor.

| | Vegetation, day | Vegetation, night | All types, day | All types, night |
|---|---:|---:|---:|---:|
| Base factor `e^mu` | 5.937 | 17.558 | 5.856 | 16.200 |
| Sumatra | 0.896 | 0.880 | 0.881 | 0.874 |
| Kalimantan | 0.824 | 0.843 | 0.819 | 1.000 |
| Java-Bali-NT | 1.534 | 1.461 | 1.487 | 1.410 |
| Sulawesi-Maluku | 1.106 | 1.270 | 1.050 | 1.057 |
| Papua | 0.950 | 0.983 | 0.954 | 1.084 |
| Other | 1.000 (fixed) | 1.000 (fixed) | 1.000 (fixed) | 1.000 (fixed) |
| Aqua hotspots in the fit | 389,222 | 59,146 | 401,197 | 71,822 |
| VIIRS hotspots in the fit | 2,310,717 | 1,038,499 | 2,349,482 | 1,163,513 |

| Month | Jan | Feb | Mar | Apr | May | Jun | Jul | Aug | Sep | Oct | Nov | Dec |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Vegetation, day | 1.033 | 1.144 | 1.187 | 0.953 | 0.912 | 0.992 | 0.886 | 0.954 | 1.049 | 1.182 | 1.140 | 1.017 |
| Vegetation, night | 1.070 | 0.939 | 0.944 | 1.077 | 1.095 | 1.068 | 1.096 | 1.146 | 1.044 | 1.188 | 1.127 | 1.046 |
| All types, day | 1.007 | 1.135 | 1.187 | 0.927 | 0.893 | 1.007 | 0.900 | 0.970 | 1.065 | 1.204 | 1.155 | 1.011 |
| All types, night | 1.064 | 0.957 | 0.935 | 1.108 | 1.074 | 1.099 | 1.102 | 1.108 | 0.946 | 1.042 | 1.072 | 1.044 |

The all-types fit uses every cell holding any hotspot, including the 1,115 cells that hold only
static sources (offshore gas flares, for example). Restricted to the cells with vegetation fires, it
gives base factors of 5.844 by day and 16.166 at night.

**Leave-one-year-out, national:**

| Series | r_log | malr | bias | Peak agreement | Verdict |
|---|---:|---:|---:|---:|---|
| Vegetation, day and night | 0.996 | 0.074 | 1.01 | 11/14 | partial |
| Vegetation, day only | 0.994 | 0.084 | 0.99 | 13/14 | converged |
| Vegetation, night only | 0.975 | 0.307 | 1.33 | 11/14 | partial |
| All types, day and night | 0.996 | 0.073 | 1.00 | 11/14 | partial |
| All types, day only | 0.994 | 0.084 | 0.99 | 13/14 | converged |
| All types, night only | 0.989 | 0.254 | 1.28 | 12/14 | partial |

**Leave-one-year-out by island group** (vegetation, day and night):

| Island group | r_log | malr | bias | Peak agreement | Verdict |
|---|---:|---:|---:|---:|---|
| Sumatra | 0.985 | 0.114 | 0.95 | 13/14 | converged |
| Kalimantan | 0.991 | 0.126 | 1.01 | 12/14 | converged |
| Java-Bali-NT | 0.975 | 0.127 | 1.01 | 12/14 | converged |
| Sulawesi-Maluku | 0.978 | 0.160 | 1.11 | 13/14 | converged |
| Papua | 0.980 | 0.161 | 1.04 | 13/14 | converged |

**Other tests** (vegetation): the even/odd split gives `r_log` 0.996, `malr` 0.079, bias 1.03 and
peak agreement 4/7 (partial); the S-NPP against NOAA-20 control gives 0.998, 0.046, 1.01 and 6/7
(converged).

**The national verdict is partial** because of the peak month alone: the levels agree closely (a
typical monthly difference of about 8 %, no overall bias), but the two records name a different peak
month in three of fourteen years. All three are near-ties within MODIS's own day-to-day sampling
noise:

| Year | MODIS peak | VIIRS peak | MODIS margin | VIIRS margin | MODIS resamples naming the VIIRS month |
|---|---|---|---:|---:|---:|
| 2013 | August | June | 8.2 % | 15.6 % | 27 % |
| 2023 | October | September | 4.5 % | 8.6 % | 38 % |
| 2025 | July | August | 1.7 % | 0.5 % | 18 % |

*Margin: how far the peak month is above the runner-up.*

**The 2015 season:** September ÷ October is 1.13 for MODIS and 1.10 for harmonised VIIRS when 2015
is predicted from the other years (1.11 with the factors fitted on all years, which the dashboard
uses), so both name September. Raw VIIRS hotspots give 0.92 and would name October.

**Fire radiative power** (vegetation): VIIRS measures 1.85 times Aqua's FRP by day and 2.13 times at
night. Leave one year out, nationally, day and night together: `r_log` 0.994, `malr` 0.128, bias
1.09, verdict partial; day only 0.994, 0.113, 1.07; night only 0.953, 0.498, 1.62.

**Data used:** FIRMS standard product and archive for 2000–2025 plus 2026 to date (near-real-time
where the standard product is not yet published), 8.9 million detections after cleaning, 4.0
million cell-days over 50,460 cells.

## Limits

- **Island drift.** The ratio of harmonised VIIRS to MODIS changes over the years in some island
  groups: about −0.19 per decade in Sumatra and +0.28 per decade in Sulawesi-Maluku. It comes from a
  dependence on fire activity that differs by region (in Riau the daytime ratio was 6.5 in 2013 and
  1.7 in 2021; in Sulawesi the ratio rises in quiet years), and quiet years cluster after 2019. No
  method tested removes it.
- **Night-only view.** Totals match, but the median month is about 1.3 times MODIS: quiet months
  are overstated, because Aqua records few hotspots at night (13 % of its total). The dashboard says
  so when the night filter is on.
- **Provinces and small areas.** Monthly differences from MODIS are about twice those of two
  identical instruments (monthly amount error about 0.41 against 0.20), whatever the method. This
  points to Aqua's sampling of the ground rather than to the conversion.
- **Aqua's orbit.** Its mean local overpass time in this data is about 13:30 until 2022, 13:50 in
  2023, 14:08 in 2024 and 14:42 in 2025, and the scores are higher without 2023–2025. Aqua MODIS
  science data is planned to end around August 2026; after that the factors can no longer be refitted
  or checked.
- **Near-real-time data.** From 1 August 2026 (VIIRS) and 1 September 2026 (MODIS) the record is
  near-real-time, with hotspot types inferred from the static-source mask.
- **Scope.** The factors are fitted for Indonesia and do not transfer to other regions.

## References

- Bergmeir, C., Benítez, J. M. (2012). On the use of cross-validation for time series predictor evaluation. *Information Sciences* 191, 192–213. doi:10.1016/j.ins.2011.12.028
- Bishop, Y. M. M., Fienberg, S. E., Holland, P. W. (1975). *Discrete Multivariate Analysis: Theory and Practice*. MIT Press.
- Bühlmann, H. (1967). Experience rating and credibility. *ASTIN Bulletin* 4(3), 199–207. doi:10.1017/S0515036100008989
- Chen, Y., van der Werf, G. R., et al. (2026). Tracking recent extremes and interannual variability of global fire emissions using a near-real-time extension to the Global Fire Emissions Database. *Earth System Science Data* 18, 7535. doi:10.5194/essd-18-7535-2026
- Deming, W. E., Stephan, F. F. (1940). On a least squares adjustment of a sampled frequency table when the expected marginal totals are known. *Annals of Mathematical Statistics* 11(4), 427–444. doi:10.1214/aoms/1177731829
- Freeborn, P. H., Wooster, M. J., Roberts, G. (2011). Addressing the spatiotemporal sampling design of MODIS to provide estimates of the fire radiative energy emitted from Africa. *Remote Sensing of Environment* 115(2), 475–489. doi:10.1016/j.rse.2010.09.017
- Giglio, L. (2007). Characterization of the tropical diurnal fire cycle using VIRS and MODIS observations. *Remote Sensing of Environment* 108(4), 407–421. doi:10.1016/j.rse.2006.11.018
- Giglio, L., Randerson, J. T., van der Werf, G. R., et al. (2010). Assessing variability and long-term trends in burned area by merging multiple satellite fire products. *Biogeosciences* 7, 1171–1186. doi:10.5194/bg-7-1171-2010
- Giglio, L., Schroeder, W., Justice, C. O. (2016). The collection 6 MODIS active fire detection algorithm and fire products. *Remote Sensing of Environment* 178, 31–41. doi:10.1016/j.rse.2016.02.054
- Hastie, T., Tibshirani, R., Friedman, J. (2009). *The Elements of Statistical Learning*, 2nd ed. Springer.
- Morley, S. K., Brito, T. V., Welling, D. T. (2018). Measures of model performance based on the log accuracy ratio. *Space Weather* 16(1), 69–88. doi:10.1002/2017SW001669
- Remy, S., Kaiser, J. W. (2014). Daily global fire radiative power fields estimation from one or two MODIS instruments. *Atmospheric Chemistry and Physics* 14, 13377–13390. doi:10.5194/acp-14-13377-2014
- Roberts, D. R., et al. (2017). Cross-validation strategies for data with temporal, spatial, hierarchical, or phylogenetic structure. *Ecography* 40(8), 913–929. doi:10.1111/ecog.02881
- Schroeder, W., Oliva, P., Giglio, L., Csiszar, I. A. (2014). The New VIIRS 375 m active fire detection data product: algorithm description and initial assessment. *Remote Sensing of Environment* 143, 85–96. doi:10.1016/j.rse.2013.12.008
