# Fire spread simulation (experimental)

The backend estimates where a fire starting at one point could spread over the following days,
as a chance per 0.05° cell (about 5.5 km) per day, for a typical fire and for a fire that becomes
large. Every number comes from how fires actually spread in the satellite record; no wind, fuel,
slope or rain data, and no rule of how fire moves, are assumed. The code is
`src/backend/app/spread.py`, served by `GET /api/spread`; the hindcast is
`src/backend/app/spread_validation.py`.

## What it answers

- **Start:** a point (`lon`, `lat`) and a day, or a fire event from `/api/events`. An event starts
  at its first active cell on its first day, the one nearest its weighted centre.
- **Period:** 1 to 30 days after the start day.
- **Answer, per day:** the chance that each cell within 10 cells (about 55 km) has been reached,
  and the expected footprint in cells and km², for two scenarios:
  - **typical:** what past fires of that month did;
  - **large fire:** what past fires that reached 5 or more cells within 14 days did, with how often
    a fire of that month became one.
- **Check:** when the period lies in the record and the start cell was burning on the start day,
  the cells the fire actually reached, and when.

## How fire spreads in the record

Before choosing a model, the day-to-day behaviour of active cells was measured on the VIIRS era of
the harmonised record (2012 to 2026; VIIRS sees much smaller fires than MODIS). An active cell is a
0.05° cell holding at least one vegetation-fire hotspot that day.

| Question | Finding |
|---|---|
| Does a burning cell burn again the next day? | In 25 % of cases (32 % within two days): fires flicker at this scale. |
| Are newly burning cells next to yesterday's fire? | 32 % touch it, 16 % are two cells away, **52 % are farther**: most new fire in Indonesia is new ignition, not spread. |
| Do several burning neighbours act independently? | Yes. The chance with k burning neighbours matches `1 - (1 - p)^k` (k = 2: 0.078 observed, 0.074 expected; k = 4: 0.159 and 0.142). |
| Is there a preferred direction? | No. North, south, east and west are equal (Kalimantan, July to October: 0.057, 0.055, 0.055, 0.054); diagonals are lower only because they are farther. |
| Does the season matter? | Strongly: a burning neighbour ignites a cell about 1.7 (Sumatra) to 3 (Kalimantan) times as often from July to October. |
| Does a cell's own fire history matter? | Most of all: from 0.000 for cells that never burned to 0.094 for cells active on 127 days or more since 2012. |
| How fast does the effect fade with distance? | Compared with cells far from any fire, August to October: 11 to 25 times as likely at one cell, 7 to 12 at two, 5 to 9 at three, about 2 at twelve. |

These figures come from the design exploration and are not repeated by `validate-spread`.

## From a cellular automaton to an analogue model

The first design was a probabilistic cellular automaton, the classic structure of fire spread models
([Alexandridis et al. 2008](https://doi.org/10.1016/j.amc.2008.06.046)). Each burning cell
stays burning and ignites cells nearby with probabilities taken from the table above: month,
the target's fire history, and distance (radius 1, 2 or 3 cells). Only the part of ignition
explained by the nearby fire was kept. A recent model is built the same way, from FIRMS detections
([Random-forest-informed cellular automaton, 2026](https://arxiv.org/abs/2609.01675)).

On held-out years it **did not beat the simplest baseline**, the typical footprint shape of past
fires. Its Brier skill over that baseline was -3 to +1 % at every radius. It ranked the cells that
burned worse (area under the ROC curve 0.66 to 0.84, against 0.88 to 0.96 for the baseline). It
also under-predicted large fires seven-fold: 1.5 cells expected against 10.7 observed after seven
days. Large fires in the record grow mainly by nearby ignitions merging, which a one-source
automaton leaves out by design. It was therefore not adopted. This comparison was also part of the
design exploration.

The model in use is an **empirical analogue**. It directly counts, over past fires, how often a
cell at a given distance and with a given fire history was reached by each day. This is the
day-by-day spread record that the [Global Fire Atlas](https://doi.org/10.5194/essd-11-529-2019)
derives from MODIS burned area, applied here to FIRMS active fire. It needs no rule of how fire
moves, so it makes fewer assumptions than the automaton, and it beat the baseline on held-out
years. A variant that also used the start cell's own fire history gave the same scores and was
not kept.

## The model

**Fire events.** The active cells of each year are grouped into events by the dashboard's event
rule: cells that touch (the 8 neighbours) and are at most one day apart. Each event has a first day
and a first cell, and records the day it first reached each cell (up to 30 days).

**Counting.** For a sample of 40,000 past events (VIIRS era, complete years), every land cell within
10 cells of the first cell is one trial. Trials are classed by:

- **distance** d: Chebyshev distance from the first cell, 1 to 10;
- **fire history** b: `floor(log2(1 + n))`, capped at 7, where n is the number of days the cell was
  active over the same years. It stands in for fuel and land use, and a cell that never burned is
  never reached;
- **month** m of the event's first day.

The reach share `reach[m][b][d][k]` is the share of trials of that class that the event reached by
day k. The same is counted over up to 40,000 **large** events, those that reached 5 or more cells
within 14 days. `share_large[m]` records how often a sampled event of month m became one.

**Simulation.** For a start cell and day, every land cell within 10 cells gets its class's reach
share in each scenario; the start cell gets 1. The expected footprint is the sum, and the range is
the median and 90th percentile footprint of the sampled events of the month.

The model is counted by `python -m app cache` into `data/derived/spread_model.json` (about seven
seconds).

## Assumptions

The response carries these sentences under `assumptions` for the interface to show:

1. Fire moves on a 0.05° grid by day; spread inside a cell is not resolved.
2. The chance of reaching a cell is the share of past fires of the same month that reached a cell at
   the same distance with the same fire history: a typical fire (or a typical large fire), not this
   one.
3. No wind, fuel, slope or rain data are used, so a specific day's weather is not taken into
   account. Past fires showed no preferred direction at this scale (see above).
4. A cell that never burned in the record is never reached, and fire beyond 10 cells is not shown.
5. A fire event joins cells that touch and are at most one day apart, so nearby ignitions that merge
   with the fire count as its spread.
6. Satellites miss fire under cloud and smoke, so past footprints, and the chances drawn from them,
   are too small where clouds were frequent.

## Hindcast

```bash
cd src/backend
uv run python -m app validate-spread
```

It takes under two minutes and prints every number below for the record of 14 November
2026.

**Design.** For each complete VIIRS-era year from 2013 to 2025, the model is counted on the other
years only (reach shares and fire histories). Then 150 random events and 150 large events of the
held-out year are replayed from their first cell on their first day. On days 1, 3, 7 and 14, the
chance given to every land cell within 10 cells is compared with the cells the event actually
reached.

**Baselines,** counted on the same training years:
- **stays put:** the fire never leaves its first cell;
- **distance only:** each cell gets the share of past fires that reached a cell at its offset from
  the first cell (the typical footprint shape, ignoring month and fire history).

**Scores.**
- **Brier score** over the window cells; skill is 1 minus the model's score over the baseline's.
- **Area under the ROC curve (AUC):** how well the chances rank the cells that burned above those
  that did not.
- **Expected against observed footprint,** in cells.

### Random fires (1,950 events)

| Day | Model | Brier skill vs stays put | vs distance only | AUC | Cells expected / observed |
|---|---|---|---|---|---|
| 1 | distance only | +3 % | 0 | 0.93 | 1.5 / 1.5 |
| 1 | **typical** | **+4 %** | **+0.4 %** | **0.94** | 1.5 / 1.5 |
| 7 | distance only | +3 % | 0 | 0.88 | 1.6 / 1.7 |
| 7 | **typical** | **+4 %** | **+0.5 %** | **0.92** | 1.7 / 1.7 |
| 14 | distance only | +3 % | 0 | 0.88 | 1.7 / 1.8 |
| 14 | **typical** | **+4 %** | **+0.5 %** | **0.92** | 1.8 / 1.8 |

### Fires that became large (1,950 events)

| Day | Model | Brier skill vs stays put | vs distance only | AUC | Cells expected / observed |
|---|---|---|---|---|---|
| 1 | typical | +6 % | +2 % | 0.91 | 1.8 / 6.3 |
| 1 | **large fire** | **+16 %** | **+12 %** | **0.92** | **6.4 / 6.3** |
| 7 | typical | +7 % | +3 % | 0.89 | 2.1 / 10.3 |
| 7 | **large fire** | **+22 %** | **+19 %** | **0.90** | **11.1 / 10.3** |
| 14 | typical | +7 % | +3 % | 0.89 | 2.2 / 10.7 |
| 14 | **large fire** | **+22 %** | **+19 %** | **0.90** | **11.7 / 10.7** |

### Reading the results

- **Each scenario is calibrated for the fires it describes.** The typical scenario expects 1.8
  cells after 14 days for random fires, which reached 1.8. The large-fire scenario expects 11.7 for
  fires that became large, which reached 10.7.
- **Most of the skill is in where fire goes.** The chances rank the cells that burned well (AUC
  0.89 to 0.94), better than the typical footprint shape alone for random fires.
- **Whether a fire will become large is not predicted;** only how often it happened in the past is
  given. Used on all fires, the large-fire scenario over-predicts five-fold, as a bad-case scenario
  should.
- **Small Brier gains** for random fires reflect that most fires never leave their first cell or
  two, so there is little to predict.
- **The record's extremes lie beyond both scenarios.** The largest Riau event of 2019 reached 145
  cells in 14 days, against 12 expected in the large-fire scenario (90th percentile 22).

## Endpoint

`GET /api/spread?lon=...&lat=...&start=YYYY-MM-DD&days=7`, or `GET /api/spread?event=...&days=7`
(the event's first day unless `start` is given), returns:

- `origin`: the start cell's centre, whether it is a land cell, and its fire history (`history_days`,
  `history_class`);
- `start`, `days`, `grid_deg`, `window_cells`, `method` (the model, the large-fire rule, the years
  counted);
- `footprint` (typical scenario), per day: `expected_cells`, `expected_km2`, and the median and 90th
  percentile footprint of past fires of the month;
- `cells` (typical scenario): `lon`, `lat` and, per cell, `chance` of being reached by each day
  (cells under 1 % on every day are left out);
- `large_fire`: the same `footprint` and `cells` for the large-fire scenario, and
  `share_of_past_fires`, how often a fire of that month became large;
- `observed`: when available, `lon`, `lat` and `day_reached` of the cells the fire actually
  reached;
- `assumptions`: the sentences above.

The model covers vegetation fires only (the default hotspot type). A start point at sea or outside
Indonesia returns `land: false` and no cells.

## Limits

- **No weather.** A fire on a windy, dry day spreads differently from the typical fire of its month;
  that difference is not in the model.
- **Coarse grid.** At 5.5 km a cell holds many separate fires, and spread inside it is invisible.
- **Merged ignitions.** Because the event rule joins touching cells, separate fires lit next to
  each other (common in land clearing) count as spread.
- **Clouds and smoke** hide fires, most of all during the worst haze, so large fires are likely
  larger than their record.
- **No suppression or fire breaks.** Rivers, roads and firefighting are present only as far as they
  shaped past fires.

## Sources

- Alexandridis, A. et al. (2008). A cellular automata model for forest fire spread prediction: the
  case of the wildfire that swept through Spetses Island in 1990. *Applied Mathematics and
  Computation*. https://doi.org/10.1016/j.amc.2008.06.046
- Andela, N. et al. (2019). The Global Fire Atlas of individual fire size, duration, speed and
  direction. *Earth System Science Data* 11. https://doi.org/10.5194/essd-11-529-2019
- Random Forest-Informed Cellular Automaton for Large-Scale Wildfire Spread Modelling (2026
  preprint). https://arxiv.org/abs/2609.01675
- Duff, T. J. et al. (2016), and Filippi, J.-B. et al. (2014), on comparing simulated and observed
  burned areas with overlap scores. https://nhess.copernicus.org/preprints/2/3219/2014/nhessd-2-3219-2014.pdf
- NASA FIRMS active fire data (MODIS and VIIRS). https://firms.modaps.eosdis.nasa.gov/
