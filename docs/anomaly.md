# Fire activity anomalies

This document describes how the backend decides whether a month's fire activity is unusual for a
place and season, which rules turn a score into a label, and what the labels can and cannot say.

The question answered is: **given the active fire observations of a month, how unusual are they in
this grid cell compared with the same month in other years?** The labels describe observed activity
against history. They are not a fire danger forecast, and they say nothing about ignition cause,
spread or damage.

## The method

### 1. One consistent product

Scores use one product: VIIRS 375 m active fire pixels of the day's reference satellite (S-NPP,
else NOAA-20, else NOAA-21), from 1 February 2012. MODIS is not mixed in, because MODIS and VIIRS
detect fires of different sizes (see [harmonisation.md](harmonisation.md)), so their raw counts are
not comparable across years.

**Why not the harmonised record?** The harmonised record would add the Aqua years 2002–2011, but
its factors are fitted per island group and month. At that scale it ranks years almost exactly like
MODIS: on paired days 2012–2025, the Spearman correlation of national monthly totals across years is
0.91 to 1.00 for every month. At the 0.25° cell level it does not. Scoring each cell-month once from
Aqua cell-days and once from harmonised VIIRS (leave one year out, 399,242 grid-month-years):

- only 57 % of the cell-months MODIS labels `elevated` or higher get such a label from harmonised
  VIIRS, and harmonised VIIRS raises 1.8 times as many alerts;
- the median rank correlation across years within a cell and month is 0.72 (lower quartile 0.54).

A cell's pre-2012 history would therefore come from a sensor that ranks its years differently, and
its label would partly depend on which sensor saw which year. The harmonised record also has no
FRP. It stays the right record for the national and island-group charts.

A pixel counts under the same rule as the rest of the record: presumed vegetation fires only (FIRMS
`type = 0`), all confidence classes, exact duplicates removed. Untyped near-real-time pixels on the
static-source mask (volcanoes, gas flares, other industrial sources) are removed. A day the reference
satellite did not observe Indonesia is missing, never zero.

### 2. Grid and daily values

The grid is fixed 0.25° cells, `gx = floor(lon / 0.25)`, `gy = floor(lat / 0.25)`, with id
`g<gx>_<gy>`. A 0.25° cell is about 28 km north to south; it is an angular cell, not an equal-area
one. Each is the sum of 5 x 5 cells of the 0.05° cell-day table, so for grid cell `g` and local day
`d`:

```
FC(g, d)  = number of qualifying pixels in g on d       (hotspot count)
FRP(g, d) = sum of the fire radiative power of those pixels, in MW
```

The daily values come straight from the stored cell-day table (`anomaly.grid_daily_sql`).

### 3. Calendar-month baseline

A month is summed over days 1 to D. D is the month's length, or the last data day when the month
is not over yet. The reference is the same days of the same calendar month in every other year of
the VIIRS record (`reference=other`, the default), or only in earlier years (`reference=prior`). A
reference year counts only when its satellite observed at least 90 % of those days; the others are
listed in `baseline.excluded_years`.

An unfinished month is compared with the same days of the other years, never with whole months,
and is marked `provisional`.

### 4. Score

For an observation `x` and the `n` reference values `X_1 ... X_n` of one indicator:

```
p_upper = (1 + #{X_j >= x}) / (n + 1)
A       = 1 - p_upper
```

`A` is the share of the `n + 1` slots that lie below `x`. It is computed separately for the hotspot
count and for FRP. A month with no hotspots scores 0. The score assumes no distribution, but it is
our choice of rank statistic, not a published hotspot method.

### 5. Labels

| Score `A` | Label | Meaning |
|---|---|---|
| below 0.80 | `normal` | no sign of unusually high activity |
| 0.80 to below 0.90 | `elevated` | higher than usual |
| 0.90 to below 0.97 | `anomalous` | unusually high |
| 0.97 and above | `extreme` | among the most unusual |

The boundaries are adapted from the 80th, 90th and 97th percentile classes of the Severe Fire
Danger Index (Jolly et al. 2019), which classifies forecast fire danger, not observed hotspots. They
are provisional.

Each indicator gets its own label. The headline `label` is the higher of the two, and
`dominant_indicator` says which set it (`both` when they agree).

### Sample size limits

The highest score with `n` reference values is `n / (n + 1)`. The VIIRS record gives 13 or 14 other
years per month, so:

| `n` | highest score | reachable labels |
|---|---|---|
| 14 | 0.933 | normal, elevated, anomalous |
| 13 | 0.929 | normal, elevated, anomalous |
| 4 to 8 | 0.80 to 0.89 | normal, elevated |
| below 4 | under 0.80 | none: `insufficient_baseline` |

`extreme` cannot occur with the current record. With 14 reference years, `anomalous` means "higher
than every reference year" and `elevated` "higher than all but one or two". When `x` beats every
reference year but the highest reachable label is below `extreme`, the record sets
`hotspot_at_ceiling` or `frp_at_ceiling`: the true class may be higher. With fewer than four
reference years (for example `reference=prior` before 2016), no label is given rather than a
misleading `normal`.

### Sparse cells

Where a cell usually has no fire in that month, a handful of hotspots already beats every reference
year and scores at the ceiling. Records whose reference median is zero carry `sparse_history: true`,
and when such a record is `elevated` or higher it also carries a `disclaimer` saying that the label
comes from only a few detections in a place that usually has none. In November 2026 about two
thirds of the `anomalous` grid cells are sparse in this sense. Neither the flag nor the disclaimer
changes the score or the label.

## Endpoint

`GET /api/anomalies?area=...|poly=...&year=YYYY&month=M&reference=other|prior`

`year` and `month` default to the last data month. The area selection works as for the other
endpoints.

| Field | Content |
|---|---|
| `period` | year, month, first and last day compared, `provisional` |
| `baseline` | reference years, sample size, excluded years, `max_score`, `reachable_labels` |
| `thresholds` | lower score bound of each label |
| `data_quality` | observed days of the target window, satellites used, flags (`provisional_partial_month`, `low_coverage`, `limited_resolution`, `insufficient_baseline`) |
| `area` | one record for the whole selection, summed over its own 0.05° cells |
| `grids` | one record per 0.25° cell touching the selection with at least one hotspot in the month, highest label first |
| `counts` | number of grid cells per label |

Each record carries `period_start`, `period_end`, `product`, `hotspot_count`, `summed_frp_mw`,
`hotspot_score`, `frp_score`, both per-indicator labels, `label`, `dominant_indicator`,
`historical_sample_size`, `baseline_granularity`, `score_calibration_status` (`uncalibrated`),
`sparse_history` and `history` (mean, median, standard deviation, 80th/90th/97th percentiles,
maximum and zero share of the reference values for each indicator).

A grid record also has `grid_id`, its centre, `bbox`, `in_area_share` and `environmental_context`.
A grid cell can cross area borders, so its values always cover the whole cell, and `in_area_share`
gives the share of its hotspots inside the selection.

The `area` record also lists `years`: the window totals of the target year and every reference
year, oldest first, so a chart can plot the month against its history.

`environmental_context` reports the cell's main island group, province and city/regency, its active
0.05° cells, the night share of its hotspots and its highest pixel FRP. It sits beside the score
and never changes it. Forest cover and wind are not available yet; they are `null` and listed in
`unavailable`.

## Regional anomalies

A region's anomaly is **not** built from its cells' labels. The `area` record sums the hotspots and
FRP of every 0.05° cell inside the selection into one monthly total per year, and scores that total
against the same region's totals in the reference years, with the same score and labels as a grid
cell. Summing first keeps every cell of the region and avoids border cells, which the 0.25° grid
splits between regions.

The share of a region's cells that are unusual is a different measure, of spatial extent. `counts`
gives it: the number of active grid cells touching the selection under each label. A region can be
`normal` overall while a few of its cells are `anomalous` (November 2026 nationally: area `normal`,
473 of 1,382 active cells `anomalous`). The other way round, a region can be `anomalous` while most
of its cells are `normal`, when its fire is spread over many cells.

## Evaluation

`python -m app anomaly-eval` scores every complete month of every year against all other years
(leave one year out), for every grid cell active in that calendar month in any year. If years were
exchangeable, a label at or above threshold `t` would fire at most `1 - t` of the time.

Result on the record up to 14 November 2026 (427,697 grid-months):

| Indicator | normal | elevated | anomalous | extreme | at or above 0.80 (nominal at most 20 %) | at or above 0.90 (nominal at most 10 %) |
|---|---|---|---|---|---|---|
| Hotspot count | 85.6 % | 8.6 % | 5.8 % | 0 % | 14.4 % | 5.8 % |
| FRP | 83.6 % | 9.6 % | 6.8 % | 0 % | 16.4 % | 6.8 % |

With 14 reference years the score takes only the values k / 15, so the thresholds act as ranks:
`elevated` or higher means the month ranks in the top 3 of 15, and `anomalous` means it beats every
reference year. For untied values the expected rates are therefore 20 % and 6.7 %, not 20 % and
10 %. The observed rates are close to this and lower, because many cell-months tie at zero, and the
hotspot rates also stay below nominal in each calendar month. Among grid-months with at least one hotspot, 33 % (count) and 38 % (FRP) are `elevated` or higher, so
active cells are flagged more often than the nominal rates suggest.

### Known fire seasons

The `area` labels for September and October 2012–2025 match the large documented fire seasons:

| Area | Elevated or higher |
|---|---|
| Indonesia | Sep 2015 (A), Oct 2015 (A), Sep 2019 (E), Oct 2014 (E) |
| Riau | 2015 (Sep E, Oct A), Sep 2019 (A), Sep 2012, Oct 2013, Oct 2014 |
| South Sumatra | 2015 (A both months), Sep 2012, 2014 (both months) |
| Central Kalimantan | 2015 (A both months), Sep 2019, Oct 2014 |
| West Kalimantan | 2015 (E both months), Sep 2019 (A), Oct 2014 |

(A: anomalous, E: elevated.) All other years are `normal`. The El Niño season of 2023 is `normal`
everywhere: it ranks between 4th and 11th of 15 years (scores 0.33–0.73), below 2015, 2019 and 2014. It was
an active season, but not one of the largest in the VIIRS record.

The alert rates and these seasons give no reason to move the thresholds. Lowering `elevated` to
catch 2023 would tune the method to one event. What the check does show is that, with 14 years,
`normal` covers everything below the top three years, including clearly active seasons.

## Limits

- The thresholds are uncalibrated. The checks above cover alert rates and a handful of known
  seasons, not a systematic comparison with documented fire events.
- Coverage is counted per day for the whole country. Cloud cover over a single cell is unknown and
  can hide fires.
- The VIIRS reference satellite changes on S-NPP outage days (63 NOAA-20 days so far). The record
  does not adjust for small differences between the satellites.
- Fourteen reference years cannot resolve the 97 % class. Finer reference windows (weekly or daily
  seasonal baselines) would add values but not independent years, and remain to be evaluated.
- Agricultural burning and other non-wildfire vegetation fires count as fires.

## Sources

- Jolly, W. M. et al. (2019). Severe Fire Danger Index: a forecastable metric to inform firefighter
  and community wildfire risk management. Percentile normalisation against local climatology; 60,
  80, 90 and 97 percentile classes.
- Su et al. (2025). Convective potential and fuel availability complement near-surface weather in
  regulating global wildfire activity. Daily hotspot count and FRP per 0.25° cell.
- O, S. et al. (2020). Observational evidence of wildfire-promoting soil moisture anomalies.
  Anomalies against the same calendar month.
- Zhang et al. (2021). Spatiotemporal analysis of active fires in the Arctic region during
  2001–2019. Seasonality of active fire occurrence.
- Sofan, P. et al. (2022). Characteristics of false-positive active fires for biomass burning
  monitoring in Indonesia from VIIRS data and local geo-features. Screening of non-biomass thermal
  sources.
- Sofiev, M. and Kouznetsov, R. (2026). Observation operator and detection limits for MODIS and
  VIIRS fire radiative power products. Sensor detection limits.
