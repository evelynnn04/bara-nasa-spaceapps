# Fire outlook per cell (forecast timeline)

The backend gives, for every 0.05° cell (about 5.5 km), the chance that the cell holds fire at each
step after the last data, for the dashboard's forecast timeline. There are three step sizes:

| Step | Leads | Chance of |
|---|---|---|
| day | 1 to 30 days after the last data day | at least one fire hotspot in the cell on that day |
| month | 1 to 12 months after the last complete month | at least one fire hotspot in the cell in that month |
| year | 1 to 5 years after the year of the last data day | at least one fire hotspot in the cell in that year |

Each lead carries a label that says how much it can be trusted (see [Labels](#labels)). The code
is `src/backend/app/outlook.py`, served by `GET /api/outlook` and `GET /api/outlook/cells`; the
evaluation is `src/backend/app/outlook_validation.py`.

## What it predicts

A cell **holds fire** when the record satellite saw at least one presumed vegetation-fire hotspot
in it. Only the VIIRS era (from February 2012) is used, because MODIS sees far fewer small fires,
and the chance of "any fire" is not harmonised across the sensor change.

The chance is a probability between 0 and 1. It is not the fire cell-days the rest of the dashboard
shows, so the timeline needs its own legend. Summed over an area, the chances give the **expected
number of cells with fire** (`expected_cells`).

## How the chances are made

Every chance is a **frequency counted in the record**, with no fitted curve, so the chances are
calibrated by construction (see the calibration results below). Past cell-days and cell-months are
grouped by what was known at the issue date, and the share of each group that burned at the lead
is the chance.

**Grouped by, day step:**

- the cell's **normal**: its daily fire frequency in the target's calendar month over the complete
  years, in 8 classes (from under 0.05 % to 5 % of days or more);
- whether it **burns on the issue day**;
- on **how many of the last 7 days** it burned (0, 1, 2-3, 4-7);
- how many of its **8 neighbours burn** on the issue day (0, 1, 2 or more).

**Grouped by, month step:**

- the cell's **normal**: its share of complete years with fire in the target calendar month, in 8
  classes;
- whether it **burned in the issue month**;
- how many **neighbours burned** in the issue month (0, 1, 2 or more).

**Year step:** the cell's share of complete years with fire (the year's normal). No other predictor
did better on held-out years (see below).

Three safeguards:

1. **No learning from the answer.** While the tables are counted, the normal of each past case
   leaves out the case's own year. Otherwise a cell would look "fire-prone" partly because of the
   very fire being predicted. An early experiment without this guard was overconfident.
2. **Smoothing.** A combination seen in few cases is drawn towards the chance of its normal class
   (50 pseudo-cases), and a combination never seen takes that chance outright. A normal is drawn
   towards the month's mean over all cells, so one fire in a quiet cell does not make it
   fire-prone.
3. **Every cell gets a chance.** Combinations that never occurred in the training years still
   receive their class's chance, so no cell drops out of the map.

The tables and the outlook for the latest data are built by `python -m app cache` (about 14 seconds
of its run) into `data/derived/outlook.parquet` and `data/derived/outlook.json`.

## Labels

Each lead is labelled from the held-out evaluation by what recent fire adds over the **calibrated
normal**, the chance of the cell's normal class alone:

| Label | Rule | Leads |
|---|---|---|
| `forecast` | improves on the calibrated normal by at least 4 % (Brier skill) | days 1-3, month 1 |
| `weak forecast` | by at least 2 % | days 4-10, month 2 |
| `seasonal` | by less | days 11-30, months 3-12 |
| `baseline` | the year's normal, no predictor | years 1-5 |

A `seasonal` frame still shows where fire is usual in that season; it does not foresee that day or
month in particular. The interface should say so.

## Evaluation

```bash
cd src/backend
uv run python -m app validate-outlook
```

It takes about a minute and a half and prints every number below for the record of 14 November
2026.

**Design.** Rolling origin: for each test year from 2016 to 2025, the tables and normals are counted
on the complete years before it only, and the outlook is scored on targets inside the test year.
- **Day step:** issue days every 7 days, at leads 1, 2, 3, 5, 7, 10, 14, 21 and 30.
- **Month step:** every issue month, at leads 1 to 12.
- **Year step:** every issue year with at least 3 complete years before it, at leads 1 to 5.

All land cells are scored: about 26 million cell-days per day lead and 6 million cell-months per
month lead.

**Baselines.**
- **normal:** the cell's long-term frequency (the same normal the tables use);
- **recent normal:** the same over the last 3 years only;
- **calibrated normal:** the table's chance for the cell's normal class, ignoring recent fire. The
  gain over it is what recent fire adds.

**Scores.**
- **Brier skill:** 1 minus the outlook's Brier score over the baseline's; positive is better.
- **Area under the ROC curve:** how well the chances rank the cells that burned.
- **Calibration:** chance given against the share that burned.

### Day step

| Lead (days) | vs normal | vs calibrated normal | vs calibrated, fire-prone cells | AUC outlook / normal |
|---|---|---|---|---|
| 1 | +8.6 % | **+7.5 %** | +10.9 % | 0.892 / 0.864 |
| 2 | +6.3 % | **+5.3 %** | +7.9 % | 0.885 / 0.865 |
| 3 | +5.3 % | **+4.1 %** | +6.3 % | 0.880 / 0.864 |
| 5 | +5.0 % | +3.8 % | +6.1 % | 0.881 / 0.865 |
| 7 | +4.1 % | +2.8 % | +4.5 % | 0.875 / 0.864 |
| 10 | +3.8 % | +2.6 % | +4.2 % | 0.875 / 0.864 |
| 14 | +3.1 % | +1.9 % | +3.1 % | 0.871 / 0.864 |
| 21 | +2.9 % | +1.6 % | +2.5 % | 0.870 / 0.864 |
| 30 | +2.3 % | +1.2 % | +1.8 % | 0.867 / 0.865 |

Fire-prone cells are those with at least 5 fire days a year. The recent normal was 0.3 to 0.5 %
worse than the long-term normal at every lead.

**Calibration, day 1:**

| Chance given | 0.018 | 0.073 | 0.140 | 0.248 | 0.389 | 0.594 |
|---|---|---|---|---|---|---|
| Share that burned | 0.013 | 0.061 | 0.123 | 0.225 | 0.355 | 0.548 |

### Month step

| Lead (months) | vs normal | vs calibrated normal | vs calibrated, fire-prone cells | AUC outlook / normal |
|---|---|---|---|---|
| 1 | +7.3 % | **+7.4 %** | +7.4 % | 0.862 / 0.836 |
| 2 | +2.8 % | +2.8 % | +2.1 % | 0.847 / 0.836 |
| 3 | +1.3 % | +1.3 % | +0.4 % | 0.841 / 0.836 |
| 4 to 12 | +0.1 to +0.9 % | +0.1 to +0.9 % | -0.3 to +0.7 % | 0.834 to 0.843 / 0.836 |

Fire-prone cells are those with fire in at least 2 months a year. The recent normal was 3.5 %
worse than the long-term normal.

**Calibration, month 1:**

| Chance given | 0.071 | 0.148 | 0.250 | 0.382 | 0.584 | 0.779 |
|---|---|---|---|---|---|---|
| Share that burned | 0.051 | 0.103 | 0.183 | 0.276 | 0.477 | 0.707 |

The month chances run about a quarter too high in the middle range: the test years were quieter
than the years the tables were counted on.

### Year step

The year's normal ranks the cells that burned with an AUC of 0.81 to 0.83. The last 3 years' share
was better in some lead years and worse in others (from -4.7 to +4.0 %), so the long-term normal
is kept.

### Reading the results

- **Days 1 to 3 and month 1 are real forecasts.** Recent fire improves on the normal by 4 to 8 %
  (11 % for fire-prone cells on day 1), and the day chances are well calibrated.
- **The gain fades smoothly.** It halves by about day 7 and is near zero after month 2, as expected
  without weather data.
- **Beyond that, the outlook is the season.** That is still useful to show, labelled as such.
- **The month step is somewhat overconfident** in the middle of the range; see Limits.

## Endpoints

`GET /api/outlook?step=day|month|year` returns the timeline of a step:
- `issued`: the last data day, the last complete month, or the year of the last data day;
- `unit`;
- `estimated_on`: the years the tables were counted on;
- `leads`: per lead, its `target` (day `YYYY-MM-DD`, month `YYYY-MM` or year) and its `label`.

`GET /api/outlook/cells?step=...&lead=...&area=...` (or `poly=...`) returns the map of one lead:
- `target`, `label`, `issued`, `grid_deg`;
- `expected_cells`: the sum of the chances over the area;
- `count`;
- `cells`: `lon`, `lat` and `chance` of every cell with at least `min_chance` (default 0.01).

A frame of the whole country is up to about 1 MB before compression (the API compresses
responses), so the dashboard should fetch one lead at a time as the timeline plays.

## Limits

- **Only as fresh as the data.** The day step starts from the last downloaded day. For a live
  timeline the pipeline must run daily (`download` with a FIRMS key, then `normalise`, `build`,
  `cache`).
- **No weather.** Rain, wind and drought are not inputs, which is why skill fades after a few days
  and after one month.
- **El Nino is not used yet.** The Oceanic Nino Index of the activity forecast (on its own branch)
  is a candidate for months 1 and 2 once that work is merged. Exploration suggested it may help
  there; it must be validated here first.
- **Drift.** Fire activity in the recent test years was lower than in the years the tables were
  counted on, so month chances run high. A weighting towards recent years could correct this, but
  the last-3-years normal alone did worse.
- **Clouds and smoke** hide fires from the satellites, so the record, and every chance counted from
  it, misses some fire.
- **Coarse grid.** A 5.5 km cell holds many separate fires; "fire in the cell" says nothing about
  where inside it.
