# Historically critical fire periods

The backend identifies the calendar months and weeks that, year after year, hold elevated fire
activity in an area. This document describes how those periods are found. The computation lives in
`src/backend/app/critical.py` and is served by `GET /api/critical`.

## Input

The harmonised daily record of the requested area (hotspots, Aqua MODIS-equivalent, see
[harmonisation.md](harmonisation.md)), for the requested detections (day and night, day only or
night only) and hotspot types (vegetation fires or all types). The record covers the whole archive,
so the endpoint takes no date range: the critical periods depend only on the area, the day/night
filter and the hotspot types.

Days the record's satellite did not observe have no value and are left out of every average below,
so an outage neither lowers nor raises a period.

## Periods and years

Two kinds of period are computed:

| Period | Values | Year it belongs to |
|---|---|---|
| Calendar month | 1 to 12 | calendar year |
| ISO week (Monday to Sunday) | 1 to 53 | ISO year |

Only years that the record covers completely are used. With the record starting on 4 July 2002,
the first complete calendar year is 2003; the year in progress is left out. ISO week 53 occurs in
some years only, and its statistics use those years.

## Intensity

For each year *y* and period *p*:

- the **period rate** is the period's total divided by its number of observed days;
- the **year rate** is the year's total divided by its number of observed days;
- the **intensity** is the period rate divided by the year rate.

An intensity of 2 means the period burned at twice the average daily rate of its own year. Comparing
each period with its own year, rather than with a long-term average in hotspots, keeps a single
extreme year (2015 in Indonesia) from deciding the season on its own: every year counts once, however
large it was. Years without any fire activity in the area have no intensity and are skipped.

A week's intensity is measured over a centred window of **3 weeks** (the week and its neighbours in
the same ISO year; two weeks at the year's edges): the window's rate divided by the year rate.
Single weeks hold too few fires to repeat from one half of the record to the other (see
[Validation](#validation)). A month is measured on its own.

## Critical periods

Over the years with fire activity, a period is **critical** when all three hold:

1. its mean intensity is at least **1.5**: it typically burns at one and a half times its year's
   average rate or more;
2. its intensity was above 1 (more active than its year's average) in at least **half** of those
   years, so the elevation recurs and does not come from a single year;
3. at least **3** years support it.

The thresholds are `RATIO_MIN`, `RECURRENCE_MIN`, `MIN_YEARS` and `WEEK_WINDOW` in
`src/backend/app/critical.py`, and the API returns them under `method`.

## Confidence

An area with little fire gives unstable results: a handful of detections decides each flag. The
response rates the result from the area's **mean annual activity** (hotspots per complete calendar
year, vegetation fires, day and night):

| Mean annual activity | Confidence | Even and odd years agree on the critical months (Jaccard) |
|---|---|---|
| under 2 | `low` | 0.24 to 0.36 |
| 2 to 20 | `moderate` | 0.64 to 0.66 |
| 20 or more | `high` | 0.74 to 0.81 |

The thresholds are `CONFIDENCE_FROM` in `src/backend/app/critical.py`. In the record of 14 November
2026, 112 of the 538 provinces and cities/regencies with any fire are `low`.

### Example

With the same daily value on every day of a year, every month has intensity 1 and nothing is
critical. If September instead holds five times the daily value of the other months, its intensity
is about 3.8 in every year and it is critical. If March is a hundred times higher in one year only,
its mean intensity passes 1.5, but it was above average in one year out of six, so it is not
critical.

## API

`GET /api/critical?area=...&daynight=...&hotspots=...` (or `poly=...` for a drawn polygon) returns `method` (the
thresholds), `activity` (`mean_annual` and `confidence`) and, for `months` and for `weeks`:

- `years`: the complete years used;
- `periods`: one entry per month (1 to 12) or week (1 to 53) with
  - `critical`: whether the period is critical;
  - `ratio`: mean intensity (over the 3-week window for weeks);
  - `years_above`, `n_years`, `recurrence`: in how many of the active years the period was above its
    year's average, out of how many, and the share;
  - `median`: median total of the period over `years`;
  - `values`: the period's own total in each year of `years` (without the window);
  - `expected`: what the period would hold at its year's average rate over the same observed days.
    `values` against `expected` per year is the historical evidence behind the flag.

## Validation

The definition was checked against the literature and on the record of 14 November 2026 (complete
years 2003 to 2025), for Indonesia, its 34 provinces and 504 cities/regencies, counting vegetation
fires by day and night. Every number below is printed by

```bash
cd src/backend
uv run python -m app validate-critical
```

which takes about a minute once the cache is built (`src/backend/app/critical_validation.py`). The
permutation test uses a fixed seed, so the output is the same on every run over the same data.

### Against known fire seasons

- **Indonesia** comes out as August, September and October, peaking in September at 3.3 times the
  year's average rate. This matches the reported dry-season peak of fire activity in Sumatra and
  Kalimantan ([Field et al. 2016](https://pmc.ncbi.nlm.nih.gov/articles/PMC4995960);
  [NASA Earth Observatory](https://earthobservatory.nasa.gov/images/145614/smoke-blankets-borneo)).
- **Central, South and East Kalimantan, South Sumatra and Lampung** come out as August to October
  (West and North Kalimantan August and September); **North Sumatra, West Sumatra and Aceh**
  earlier, June to August, and **Riau** July and August; most of **Sulawesi** later, September and
  October, reaching November in Southeast Sulawesi and Maluku.
- **Riau Islands** comes out as February and March, in line with the second, February-March dry
  season reported for this part of Sumatra
  ([Mongabay 2024](https://news.mongabay.com/2024/03/sumatra-firefighters-on-alert-as-burning-heralds-start-of-riau-dry-season/)).
  In Riau and Aceh that second season is visible but weaker than the main one: Riau's February is
  1.51 times its year's average and above average in 13 of 23 years, so it is just critical, but
  p = 0.030 is not significant once corrected for the twelve months. Aceh's February stays under
  the threshold. The looser 10 % rule below includes February and March in both provinces.

### Against other definitions

There is no single standard definition of a fire season. Two published ones, applied to the same
monthly record of the 35 areas (country and provinces):

| Definition | Mean Jaccard with ours |
|---|---|
| Months whose mean count is at least 10 % of the mean annual count ([Giglio et al. 2006](https://agupubs.onlinelibrary.wiley.com/doi/10.1029/2005JG000142)) | 0.79 |
| Shortest run of consecutive months holding over 80 % of the fires, the "critical fire period" of an Amazon study ([Environ. Res. Lett.](https://iopscience.iop.org/article/10.1088/1748-9326/ac3aa3)) | 0.62 |

Both rely on the mean count over years, so large years such as 2015 weigh more. The 10 % rule is
close to ours (10 % of the year is an intensity of about 1.2) but adds shoulder months; the 80 % run
is a different question (where most fires are, not when burning is elevated) and gives seasons of
up to eight months.

### Is the elevation real? Permutation test

For each area and month, the months of each year were shuffled 4,000 times and the mean intensity
recomputed, giving a p-value under the hypothesis of no seasonality; p-values were corrected for the
12 months with Benjamini-Hochberg (q = 0.05).

| Mean annual activity | Areas | Critical months that are significant | Significant months not called critical, per area |
|---|---|---|---|
| under 5 | 159 | 61 % | 0.05 |
| 5 to 50 | 209 | 81 % | 0.02 |
| 50 to 500 | 137 | 89 % | 0.03 |
| 500 or more | 33 | 85 % | 0.00 |

Most critical months in an area with real fire activity are statistically significant, and almost
no significant month is missed: the 1.5 threshold sits where the elevation becomes significant. In
areas with very little fire about two in five critical months could be chance, which the `low` and
`moderate` confidence levels report.

### Sensitivity and stability

Each variant was scored, by mean annual activity, on two measures: the agreement (Jaccard) between
the critical months found in even years and in odd years, which should be high if the result
reflects a recurring season; and the share of flags that change when any one year is left out.

| Variant (months) | Even/odd agreement, 5-50 / 50-500 / 500+ per year | Flags changed by leaving out one year |
|---|---|---|
| **Chosen: mean intensity >= 1.5, above average in >= half the years** | **0.69 / 0.81 / 0.83** | **0.3 to 1.3 %** |
| Intensity >= 1.25 | 0.70 / 0.80 / 0.83 | 0.6 to 1.4 % |
| Intensity >= 2.0 | 0.63 / 0.73 / 0.81 | 0.4 to 1.2 % |
| Above average in >= two thirds of the years | 0.59 / 0.74 / 0.82 | 0.5 to 0.7 % |
| Median instead of mean intensity | 0.64 / 0.76 / 0.76 | 0.9 to 1.3 % |
| Leave out years under 5 hotspots | 0.72 / 0.81 / 0.83 | 0.3 to 1.0 % |
| Leave out years under a quarter of the median year | 0.71 / 0.82 / 0.82 | 0.3 to 1.2 % |

- The chosen thresholds are as stable as any variant; leaving out any one year changes on average
  about 1 % of the flags or fewer.
- A lower threshold (1.25) is about as stable but adds shoulder months and splits more seasons in
  two (7 % against 5 % of areas with 50 to 500 per year); stricter thresholds lose stability.
- Using the median does not improve the result. Leaving out years under 5 hotspots helps areas with
  5 to 50 per year slightly (0.72 against 0.69) but loses agreement in areas with less (0.31 against
  0.41): the recurrence condition already keeps a few small years from making a season. Neither was
  adopted.
- Weekly flags were much less stable than monthly ones (even/odd agreement 0.44 to 0.72, with 24 to
  48 % of areas showing broken-up seasons). A centred 3-week window raises the agreement to 0.64 to
  0.80 and cuts the broken-up seasons to 21 to 29 % while keeping the national season almost
  unchanged (weeks 30 to 42 instead of 30 to 43); a 5-week window adds little more and blurs the edges, so 3 weeks was adopted.

### Limitations

- **Clouds.** Satellites do not see fires under cloud, so wet-season activity is undercounted and the
  dry season stands out more than it may on the ground.
- **Thresholds are a choice.** 1.5 and one half are not taken from a standard; the tests above show
  that they agree with significance and are stable, not that they are unique.
- **Neighbouring weeks are not independent.** Thirteen critical weeks are about three months of
  evidence, not thirteen separate findings.
- **Small areas.** Results rated `low` should be read as indicative only.
