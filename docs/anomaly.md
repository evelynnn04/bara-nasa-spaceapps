# Fire activity anomalies

This document describes how the backend decides whether a month's fire activity is unusual for a
place and season, which rules turn a score into a label, and what the labels can and cannot say.

The question answered is: **given the fire activity of a month, how unusual is it in this area
compared with the same month in other years?** The labels describe observed activity against
history. They are not a fire danger forecast, and they say nothing about ignition cause, spread or
damage.

## The method

### 1. The harmonised record

Scores use the harmonised MODIS–VIIRS record described in [harmonisation.md](harmonisation.md):
Aqua MODIS from 4 July 2002, and the day's VIIRS reference satellite (S-NPP, else NOAA-20, else
NOAA-21) from 1 February 2012. This gives every month 23 or 24 earlier and later years to compare
with. Two indicators are scored, both in MODIS-equivalent units:

- **Activity**, in hotspots (Aqua MODIS-equivalent): an Aqua hotspot counts 1, a VIIRS hotspot
  `1 / k_d[island group, month]` for its half of the day `d`.
- **FRP**, summed fire radiative power in MW: Aqua FRP as it is, VIIRS FRP of each half of the day
  divided by `kf_d[island group, month]` (see "FRP harmonisation" below).

Hotspots count under the same rule as the rest of the record: with `hotspots=vegetation` (the
default) presumed vegetation fires only (FIRMS `type = 0`), untyped near-real-time hotspots on the
static-source mask (volcanoes, gas flares, other industrial sources) removed; with `hotspots=all`
every hotspot type, each setting with its own factors. All confidence classes count and exact
duplicates are removed. A day the record's satellite did not observe Indonesia is missing, never
zero.

### 2. One base grid, two kinds of units

Everything is summed from the 0.05° cells of the harmonised record (about 5.5 km, roughly the
finest grid the 1 km MODIS pixels support):

- **Areas** (the country, a province, a city/regency or a drawn polygon) sum their own 0.05° cells.
  Every cell belongs to one city/regency, so an area never takes in fire from outside it.
- **Grid cells** (on request) are fixed 0.25° blocks of 5 x 5 base cells, `gx = floor(lon / 0.25)`,
  `gy = floor(lat / 0.25)`, with id `g<gx>_<gy>`. A grid cell can cross area borders.

Areas are not summed from grid cells, and an area's label is not built from its cells' labels.

### 3. Calendar-month baseline

A month is summed over days 1 to D. D is the month's length, or the last data day when the month
is not over yet. The reference is the same days of the same calendar month in every other year of
the record (`reference=other`, the default), or only in earlier years (`reference=prior`). A
reference year counts only when its satellite observed at least 90 % of those days; the others are
listed in `baseline.excluded_years`. An unfinished month is compared with the same days of the other
years, never with whole months, and is marked `provisional`.

### 4. Score

For an observation `x` and the `n` reference values `X_1 ... X_n` of one indicator:

```
p_upper = (1 + #{X_j >= x}) / (n + 1)
A       = 1 - p_upper
```

`A` is the share of the `n + 1` slots that lie below `x`. It is computed separately for activity and
for FRP. A month with no fire scores 0. The score assumes no distribution, but it is our choice of
rank statistic, not a published method for fire activity.

### 5. Labels

| Score `A` | Label | Meaning |
|---|---|---|
| below 0.80 | `normal` | no sign of unusually high activity |
| 0.80 to below 0.90 | `elevated` | higher than usual |
| 0.90 to below 0.97 | `anomalous` | unusually high |
| 0.97 and above | `extreme` | among the most unusual |

The boundaries are adapted from the 80th, 90th and 97th percentile classes of the Severe Fire
Danger Index (Jolly et al. 2019), which classifies forecast fire danger, not observed fire. They
are provisional.

Each indicator gets its own label. The headline `label` is the higher of the two, and
`dominant_indicator` says which set it (`both` when they agree).

### Sample size limits

The highest score with `n` reference values is `n / (n + 1)`:

| `n` | highest score | reachable labels |
|---|---|---|
| 23 or 24 | 0.958 or 0.960 | normal, elevated, anomalous |
| 9 to 22 | 0.90 to 0.957 | normal, elevated, anomalous |
| 4 to 8 | 0.80 to 0.89 | normal, elevated |
| below 4 | under 0.80 | none: `insufficient_baseline` |

`extreme` needs at least 33 reference years and cannot occur with the current record. With 24
reference years, `elevated` or higher means the month ranks in the top 5 of 25, and `anomalous`
means the top 2. When `x` beats every reference year but the highest reachable label is below
`extreme`, the record sets `activity_at_ceiling` or `frp_at_ceiling`: the true class may be higher.
With fewer than four reference years (`reference=prior` for months before about 2007), no label is
given rather than a misleading `normal`.

### Sparse places

Where a place usually has no fire in that month, a few detections already beat most reference years.
Records whose reference median activity is zero carry `sparse_history: true`, and when such a record
is `elevated` or higher it also carries a `disclaimer` saying that the label comes from only a few
detections in a place that usually has none. This matters mostly for grid cells: in November 2026
(to 14 November), 446 of the 524 `anomalous` grid cells (85 %) are sparse. Neither the flag nor the disclaimer changes
the score or the label.

## FRP harmonisation

FRP is harmonised like the hotspot counts, by day and by night separately. FRP is a physical
quantity that adds up over hotspots, so the VIIRS FRP of each half of a cell-day is divided by

```
ln kf_d[r, m] = mu_d + rho_d,r + sigma_d,m
```

fitted with the same shrunk iterative proportional fit, on the same paired days (1 February 2012 to
31 December 2025), on monthly sums of Aqua FRP against VIIRS-reference FRP of that half, for each
hotspot type setting. The shrinkage weight is each stratum's Aqua hotspots, as for the count
factors. The factors are stored in the `k_table` of `src/backend/app/harmonise/params.json` (`kf_day`,
`kf_night`) by `python -m app fit`.

Separate halves matter for FRP as for counts: on paired days, VIIRS measures 1.7 to 2.6 times
Aqua's FRP by day across 2012–2025, but 1.4 to 8.4 times at night. For vegetation fires the base
factors are 1.85 by day and 2.13 at night. Leave one year out, nationally, day and night together:
`r_log` 0.994, `malr` 0.128, bias 1.09, verdict **partial**; day only 0.994, 0.113, 1.07; night only
0.953, 0.498, 1.62.

## How far down the harmonised record holds

Within a place and month, MODIS and harmonised VIIRS should rank the years alike if the record is
to be compared across the 2012 splice. On paired days 2012–2025, scoring each unit-month once from
Aqua and once from harmonised VIIRS (units active in at least five years):

| Unit | Median rank agreement (activity) | Median rank agreement (FRP) | MODIS alerts also raised by harmonised VIIRS |
|---|---|---|---|
| 0.05° grid | 0.65 | 0.65 | 61 % |
| 0.25° grid | 0.72 | 0.72 | 68 % |
| 1° grid | 0.74 | 0.72 | 68 % |
| City/regency | 0.72 | 0.70 | 67 % |
| Province | 0.83 | 0.82 | 74 % |
| Island group | 0.95 | 0.95 | 80 % |

The two sensors see different fires: VIIRS detects small fires MODIS misses, and a small place holds
too few detections a month for that to average out. Agreement grows with the size of the area and
is good from the province upward. A better conversion cannot fix this, because raw VIIRS hotspot
counts agree with MODIS no better than the harmonised values. Moving the record from cell-days to
hotspots does not change this: on the same unit-months (Spearman correlation of the yearly values of
each unit and calendar month, 2012–2025), the agreement of the two units differs by at most 0.01 at
every scale, and the share of MODIS alerts also raised by VIIRS by at most 3 points.

So the labels of grid cells and cities/regencies partly depend on which sensor saw which year, and
should be read as indicative. The grid uses 0.25° rather than the 0.05° base grid because agreement
is lower at 0.05° and most 0.05° cells burn in only one or two months of the year.

## Endpoint

`GET /api/anomalies?area=...|poly=...&year=YYYY&month=M&reference=other|prior&grids=true|false&daynight=all|day|night&hotspots=vegetation|all`

`year` and `month` default to the last data month. The area selection, `daynight` and `hotspots`
work as for the other endpoints. `grids` defaults to `false`.

With `daynight=day` or `night`, both indicators count only that half of the day, in the target and
the reference years alike, each divided by that half's own factor (`k_d`, `kf_d`). Data built before
the hotspot unit answers with 503 until `python -m app build` and `python -m app cache` are run
again.

| Field | Content |
|---|---|
| `period` | year, month, first and last day compared, `provisional` |
| `unit`, `product` | the record's unit and the satellites it uses |
| `baseline` | reference years, sample size, excluded years, `max_score`, `reachable_labels` |
| `thresholds` | lower score bound of each label |
| `data_quality` | observed days of the target window, satellites used, flags (`provisional_partial_month`, `low_coverage`, `limited_resolution`, `insufficient_baseline`) |
| `area` | the record of the whole selection, with `years` |
| `grids`, `counts`, `grid_deg` | with `grids=true` only: one record per 0.25° cell touching the selection with activity in the month (highest label first), and the number of cells per label |

Each record carries `period_start`, `period_end`, `product`, `activity` (hotspots),
`frp_mw`, `activity_score`, `frp_score`, both per-indicator labels and ceiling flags, `label`,
`dominant_indicator`, `historical_sample_size`, `baseline_granularity`, `score_calibration_status`
(`uncalibrated`), `sparse_history`, `disclaimer` and `history` (mean, median, standard deviation,
80th/90th/97th percentiles, maximum and zero share of the reference values for each indicator).

The `area` record also lists `years`: the window totals of the target year and every reference
year, oldest first, so a chart can plot the month against its history.

### Year view

`GET /api/anomalies?period=year&year=YYYY&area=...|poly=...&reference=...&daynight=...&hotspots=...`

`months` lists every month of the year inside the record. Each is scored against the same month in
the reference years, exactly as `period=month` would score it: each entry has the fields of the
`area` record, plus `month`, `provisional`, its own `baseline` and `data_quality`. `summary`
gives the number of months per label and `alert_months`, the months `elevated` or higher.

The year as a whole gets **no label**. Comparing a year's total with other years' totals has no
precedent in the reviewed references, which support comparing a month with the same calendar month
in other years. The Year view therefore stays a set of monthly scores. `period=year` takes neither
`month` nor `grids`.

A grid record also has `grid_id`, its centre, `bbox`, `in_area_share` (the share of its activity
inside the selection) and `environmental_context`: the cell's main island group, province and
city/regency, its active 0.05° cells, the night share of its hotspots and its highest hotspot FRP. The
context sits beside the score and never changes it. Forest cover and wind are not available yet;
they are `null` and listed in `unavailable`.

## Evaluation

`python -m app anomaly-eval --unit province|regency|grid [--hotspots vegetation|all]` scores every
complete month of every year
against all other years (leave one year out), for every unit active in that calendar month in any
year. With 24 reference years and no ties, `elevated` or higher would fire 20 % of the time and
`anomalous` 8 %.

Result on the record up to 14 November 2026:

| Unit | Unit-months | Indicator | `elevated` or higher | `anomalous` |
|---|---|---|---|---|
| Province | 9,836 | Activity | 16.9 % | 8.1 % |
| | | FRP | 17.2 % | 8.3 % |
| City/regency | 136,806 | Activity | 15.0 % | 7.3 % |
| | | FRP | 15.9 % | 8.0 % |
| 0.25° grid | 714,088 | Activity | 13.2 % | 6.9 % |
| | | FRP | 14.2 % | 7.6 % |

Province rates match the expected rates. Smaller units come out lower because many of their months
tie at zero. Among grid-months with any activity, 38 % of cells are `elevated` or higher, which is
the sparse-place effect above. No calendar month goes above 20 % `elevated` or higher for any unit.

### Known fire seasons

`area` labels for August to October, 2002–2025 (A: anomalous, E: elevated, every other month
`normal`):

| Area | Elevated or higher |
|---|---|
| Indonesia | 2002 (Aug A, Oct E), 2004 (Aug A, Oct E), 2006 (A all three), 2009 (Aug, Sep E), 2015 (Sep, Oct A), Sep 2019 (E) |
| Riau | 2002, 2004, 2005, 2006, 2007, 2008, 2010, 2011, 2013, 2015, 2019 |
| South Sumatra | 2002, 2004, 2006, 2009, 2011, 2012, 2014, 2015, 2019 |
| Central Kalimantan | 2002, 2004, 2006, 2009, 2015, 2019 |
| West Kalimantan | 2002, 2004, 2006, 2009, 2012, 2013, 2014, 2015, 2019 |

These include the El Niño fire years of 2002, 2004, 2006, 2009, 2015 and 2019, and the Riau haze
episodes of 2005 and 2013. The years after 2015 are `normal` except 2019. The 2023 El Niño season is
`normal` everywhere: it was an active season, but not one of the five largest of 25.

The alert rates and these seasons give no reason to move the thresholds. Lowering `elevated` to
catch 2023 would tune the method to one event.

## Limits

- The thresholds are uncalibrated. The checks above cover alert rates and documented seasons, not a
  systematic comparison with fire event records.
- The labels of grid cells and cities/regencies partly depend on which sensor saw which year (see
  "How far down the harmonised record holds").
- Coverage is counted per day for the whole country. Cloud cover over a single place is unknown and
  can hide fires.
- The record's VIIRS satellite changes on S-NPP outage days, without adjustment between satellites.
- Twenty-four reference years cannot resolve the 97 % class.
- Agricultural burning and other non-wildfire vegetation fires count as fires.

## Sources

- Jolly, W. M. et al. (2019). Severe Fire Danger Index: a forecastable metric to inform firefighter
  and community wildfire risk management. Percentile normalisation against local climatology; 60,
  80, 90 and 97 percentile classes.
- Su et al. (2025). Convective potential and fuel availability complement near-surface weather in
  regulating global wildfire activity. Daily fire count and FRP per 0.25° cell.
- O, S. et al. (2020). Observational evidence of wildfire-promoting soil moisture anomalies.
  Anomalies against the same calendar month.
- Zhang et al. (2021). Spatiotemporal analysis of active fires in the Arctic region during
  2001–2019. Seasonality of active fire occurrence.
- Sofan, P. et al. (2022). Characteristics of false-positive active fires for biomass burning
  monitoring in Indonesia from VIIRS data and local geo-features. Screening of non-biomass thermal
  sources.
- Sofiev, M. and Kouznetsov, R. (2026). Observation operator and detection limits for MODIS and
  VIIRS fire radiative power products. Sensor detection limits.
