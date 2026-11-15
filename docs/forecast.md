# Fire activity forecast

The backend forecasts the monthly fire activity of any area one to three months ahead, with an
interval and the probability that the month is unusually high. This document gives the target,
the predictors, the horizon, how the forecast was evaluated on held-out years, and its limits. The
code is `backend/app/forecast.py`, served by `GET /api/forecast`; the evaluation is
`backend/app/forecast_validation.py`.

## Target

The **fire activity of an area in one calendar month**, in MODIS-equivalent active fire cell-days
(the harmonised unit of [harmonisation.md](harmonisation.md)), for the detections chosen (day and
night, day only or night only).

The model works on `z = ln(1 + activity)`. Monthly activity ranges from zero to over 50,000 fire
cell-days for the country, and on the log scale a quiet and a busy area can share one model.

A second, yes-or-no target is whether the month is **elevated**: it scores at least 0.80 against
the same calendar month in every earlier year, the lowest alert label of the anomaly method
([anomaly.md](anomaly.md)).

## Predictors

A forecast is issued at the end of the area's last complete month, the **issue month** t. It uses
only what is known then:

| Predictor | What it is | Why |
|---|---|---|
| **Normal** | Mean of z for the target calendar month over the complete years (2003 to the last complete year) | The seasonal cycle is the strongest signal (see [critical-periods.md](critical-periods.md)) |
| **Current anomaly** | z in month t minus the normal of month t's calendar month | Dry spells and burning episodes persist for weeks to months |
| **Oceanic Nino Index** (leads 1 and 2 only) | NOAA CPC's three-month Nino 3.4 anomaly, the season ending in month t - 1 | El Nino brings drought and severe fire seasons to Indonesia ([Field et al. 2016](https://www.pnas.org/doi/10.1073/pnas.1524888113)) and drives the published seasonal fire forecasts for Indonesia ([Spessa et al. 2015](https://nhess.copernicus.org/articles/15/429/2015/); [Shawki et al. 2017](https://agupubs.onlinelibrary.wiley.com/doi/full/10.1002/2017GL073660)); the ONI itself has forecast fire season severity months ahead ([Chen et al. 2011](https://escholarship.org/content/qt669030f9/qt669030f9.pdf)) |

The ONI season ending in month t - 1 is used, not month t, because CPC publishes each season early
in the following month. The table is fetched by `python -m app indices` (also part of
`download`); without it the forecast leaves the index out and says so under `predictors`.

The Indian Ocean Dipole (NOAA PSL's DMI) was also tried, with a three-month publication delay (the
PSL file currently trails by about six months). For provinces it changed the MAE by under 2 % at
every lead and did not raise the share of elevated months caught, so it is not used. This trial
was part of the design exploration and is not repeated by `validate-forecast`.

## Model

For each lead h (months after t) and target calendar month c:

```
z(t + h) = normal(c) + b0 + b1 * anomaly(t)  [+ b2 * ONI(t - 1) for h = 1, 2]
```

The coefficients are fitted by least squares on every province and city/regency with at least 2
fire cell-days a year, pooled, so they describe how anomalies and El Nino carry forward in general.
Any named area or drawn polygon is then forecast from its own normal and anomaly. There are 36 fits
(3 leads by 12 calendar months), each on several thousand area-years.

The median forecast is `exp(z) - 1`. It is the middle of the forecast distribution, not its mean.

## Horizon

**Time: one to three months after the issue month.** The skill over the normal falls with lead
time and is near zero beyond three months (see the evaluation). The ONI helps only one and two
months ahead: a forecast issued in April to June cannot yet see the El Nino state of the late dry
season, the so-called spring predictability barrier, and adding the index at longer leads made
the forecast worse.

**Space: any area of the dashboard,** from the country to a city/regency or a drawn polygon, at
the harmonised 0.05° grid underneath. Skill depends on how much fire the area has:

| Mean annual activity | Confidence | What is given |
|---|---|---|
| 200 fire cell-days or more | `high` | median, interval, probability of an elevated month, outlook |
| 20 to 200 | `moderate` | the same; the probability is only slightly better than a constant guess |
| under 20 | `low` | median and interval only; the probability is withheld because it scored worse than a constant guess |

The partly observed current month is not used, and the forecast does not go below a month.

## Uncertainty

- **Interval.** Each fit keeps its residuals, divided by each area's spread of z in the target
  calendar month. An area's 80 % interval is the 10th to 90th percentile of those residuals,
  multiplied by its own spread: a steady area gets a narrow range, an erratic one a wide range.
- **Probability of an elevated month.** The share of those scaled residuals that would carry the
  forecast above the area's elevated threshold.
- **Outlook.** `elevated likely` from a probability of 0.5, `elevated possible` from 0.3, otherwise
  `near or below normal`. For provinces in the July to November fire season, two in three
  `elevated likely` calls were right, and from 0.3 about half of the elevated months were caught
  (table below).
- **Confidence,** from the area's mean annual activity (see Horizon).
- **Limitations,** returned with every forecast for the interface to show (see Limits).

## Evaluation

```bash
cd backend
uv run python -m app indices
uv run python -m app validate-forecast
```

It takes about a minute and prints every number below for the record of 14 November 2026.

**Design.** Rolling origin: for every test year from 2008 to 2025, every model is refitted on the
complete years before it only. The normals, coefficients, residuals and elevated thresholds are
all refitted, and nothing from the test year or after is used. Each month of the test year is then
forecast at leads 1 to 6. The ONI used is the season that had been published at the issue date.

**Models.** `normal` (climatology), `last year` (the same month a year earlier), `anomaly`
(normal and current anomaly), the model in use (`+ ONI 1-2`), and `+ ONI all` (the index at every
lead).

**Metrics.**
- MAE and RMSE in fire cell-days per month.
- MAE skill: 1 minus the model's MAE over the normal's.
- Coverage of the 80 % interval, which should be near 0.80.
- Brier skill of the probability of an elevated month against the constant probability 0.2.
- Precision and recall of an elevated month when its probability is at least 0.5 or 0.3.

### One month ahead, all months

| Areas | Forecast months | MAE (normal / last year / model) | RMSE (normal / model) | MAE skill | 80 % coverage | Brier skill |
|---|---|---|---|---|---|---|
| Country | 216 | 1,291 / 1,496 / **792** | 2,406 / **1,509** | **+39 %** | 0.75 | 0.33 |
| Provinces | 7,344 | 42.5 / 52.4 / **31.2** | 168.7 / **144.1** | **+26 %** | 0.79 | 0.15 |
| Cities/regencies, 200+ a year | 9,996 | 20.3 / 25.6 / **16.3** | 63.6 / **55.6** | **+20 %** | 0.76 | 0.13 |
| Cities/regencies, 20 to 200 a year | 33,444 | 3.4 / 4.1 / **2.7** | 10.6 / **9.0** | **+20 %** | 0.81 | 0.06 |
| Cities/regencies, 2 to 20 a year | 40,380 | 0.6 / 0.8 / **0.6** | 1.9 / **1.7** | **+11 %** | 0.82 | -0.23 |

The same month last year is worse than the normal everywhere (-16 to -26 %), so a naive copy of
last year is not a useful forecast.

### Skill by lead (MAE skill over the normal)

| Areas | Lead 1 | Lead 2 | Lead 3 | Lead 4 | Lead 5 | Lead 6 |
|---|---|---|---|---|---|---|
| Country | +39 % | +25 % | +14 % | +9 % | +6 % | +4 % |
| Provinces | +26 % | +17 % | +8 % | +5 % | +2 % | +2 % |
| Cities/regencies, 200+ a year | +20 % | +11 % | +5 % | +3 % | +2 % | +1 % |
| Provinces, ONI at every lead | +26 % | +17 % | +5 % | -3 % | -7 % | -8 % |

From lead 4 the gain is under 10 % for the country and 5 % or less elsewhere, so the forecast
stops at three months. The last row is why the ONI is used at leads 1 and 2 only.

### What the ONI adds (provinces, one month ahead)

| Targets | Model | MAE skill | Brier skill | Precision / recall, p >= 0.5 | Precision / recall, p >= 0.3 |
|---|---|---|---|---|---|
| All months | anomaly | +24 % | 0.15 | 0.47 / 0.08 | 0.41 / 0.25 |
| All months | **+ ONI** | **+26 %** | 0.15 | **0.50 / 0.13** | **0.42 / 0.33** |
| July to November | anomaly | +27 % | 0.22 | 0.62 / 0.10 | 0.53 / 0.39 |
| July to November | **+ ONI** | **+30 %** | **0.26** | **0.67 / 0.22** | **0.51 / 0.52** |

In the fire season the index doubles the share of elevated months caught at p >= 0.5, at a
slightly higher precision.

### Reading the results

- The forecast beats the normal and last year's value at every lead and in every group of areas.
  Most of the gain is in the first two months.
- Elevated months are hard to call: at a probability of 0.5 most of them are missed, and even in
  the fire season a threshold of 0.3 catches about half at about even odds. The outlook should be
  read as a warning sign, not a prediction.
- The intervals cover 75 to 82 % of outcomes against 80 % nominal, a little narrow for the country
  and the busiest areas.
- For areas with under 20 fire cell-days a year, the probability is worse than a constant guess,
  which is why it is withheld there.

## Endpoint

`GET /api/forecast?area=...&daynight=...` (or `poly=...`) returns:

- `method`: leads, ONI leads, interval quantiles, elevated score and the years the coefficients
  were fitted on;
- `issued_after`: the issue month (the area's last complete month);
- `predictors` used, and `oni`: the season and value used;
- `activity`: the area's `mean_annual` activity and `confidence`;
- `forecasts`: per target month its `lead`, `median`, `low` and `high` (80 % interval), `normal`,
  `elevated_from` (the activity above which the month is elevated), `p_elevated`, `outlook` and
  `uses_oni`;
- `recent`: the last twelve complete months against their normal;
- `limitations`: sentences for the interface to show next to the forecast.

The coefficients are fitted on the first request (under a second) and cached.

## Limits

- **Only fire history and El Nino.** Rainfall, fuel, land use, fire bans and suppression are not
  modelled; a forecast cannot foresee a change in any of them.
- **Clouds and smoke** hide fires from the satellites, so actual burning can exceed the counts, and
  the record the model learns from has the same gaps.
- **A changing regime.** Coefficients are fitted on 2003 to the last complete year; a fire season
  unlike any in that period, in either direction, is not foreseen.
- **Pooled coefficients.** Every area shares how anomalies and El Nino carry forward; areas whose
  fires respond differently to dry spells or El Nino are forecast less well.
- **Small areas.** Their forecasts are rated `low` and should be read as indicative only.

## Sources

- Field, R. D. et al. (2016). Indonesian fire activity and smoke pollution in 2015 show persistent
  nonlinear sensitivity to El Nino-induced drought. *PNAS* 113(33), 9204-9209.
  https://www.pnas.org/doi/10.1073/pnas.1524888113
- Spessa, A. C. et al. (2015). Seasonal forecasting of fire over Kalimantan, Indonesia. *Natural
  Hazards and Earth System Sciences* 15. https://nhess.copernicus.org/articles/15/429/2015/
- Shawki, D. et al. (2017). Long-lead prediction of the 2015 fire and haze episode in Indonesia.
  *Geophysical Research Letters* 44, 9996-10005. https://agupubs.onlinelibrary.wiley.com/doi/full/10.1002/2017GL073660
- Chen, Y. et al. (2011). Forecasting fire season severity in South America using sea surface
  temperature anomalies. *Science* 334, 787-791.
  https://escholarship.org/content/qt669030f9/qt669030f9.pdf
- Hyndman, R. J. and Athanasopoulos, G. *Forecasting: Principles and Practice* (3rd ed.), on
  evaluating forecasts on a rolling origin. https://otexts.com/fpp3/
- NOAA CPC, Oceanic Nino Index. https://www.cpc.ncep.noaa.gov/data/indices/oni.ascii.txt
