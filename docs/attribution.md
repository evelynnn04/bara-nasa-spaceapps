# Fire cause attribution

This document describes how the backend suggests a likely cause for each fire event, which data and
rules it uses, how confident each suggestion is, and how the dashboard can show it.

The question answered is: **given where and when a fire event burned, which cause does the
surrounding environmental evidence point to?** The answer is one of four categories: land
clearing, agricultural burning, wildfire, or unknown.

> **Disclaimer.** The attribution gives possible related evidence, not definitive causal evidence.
> Satellite data show where and when fire burned and what the land looked like; they do not show
> who lit a fire or why. Most fires in Indonesia are lit by people, and a fire set to clear land can
> escape and become a wildfire. Confirm with field reports before acting on an attribution. The API
> returns this text as `attribution_disclaimer` (`/api/events`) and `disclaimer` (`/api/attribution`);
> the dashboard must show it wherever it shows a cause.

## The method

### 1. Fire events

Attribution works on the fire events of `/api/events` (see `app/pipeline/events.py`): active
0.05° cells of the harmonised record that touch and burn within a day of each other. Each event's
cells are kept in `event_cells.parquet` with their harmonised hotspots `w`, summed over the event.
Every piece of evidence below is a **hotspot-weighted mean over the event's cells**, so the cells
where most fire was seen count most.

The reference dates of an event are its **peak day**, the **peak year** `Y` and the **peak month**.

### 2. Context layers

| Layer | Dataset | Resolution | Account | Evidence per event |
|---|---|---|---|---|
| Tree cover 2000, yearly forest loss | Hansen et al. Global Forest Change v1.12 (Landsat, 2001-2024) | 30 m | none | `forest_cover_2000`: share of the burned cells with at least 30 % canopy cover in 2000. `forest_loss`: share of the burned cells where such forest was lost in years `Y-1` to `Y+1`; `expected_share`: the loss those cells usually have in as many years (their mean yearly loss over the other years of 2001-2024); `excess_share`: the difference, at least 0 |
| Land cover | NASA MODIS MCD12Q1 v061 (IGBP classes, 2001 onward) | 500 m | Earthdata | `landcover`: share of each class group in year `Y-1` (the land before the fire), or the nearest available year |
| Peatland | CIFOR tropical peatland map v2.1 (Gumbricht et al. 2017) | 231 m, on a 0.0011° grid | none | `peat`: share of the burned cells on peat |
| Rainfall | NASA GPM IMERG Final monthly V07 | 0.1° | Earthdata | `rainfall`: mean rate over the three months ending in the peak month, and its 2001-2020 normal for the same calendar months |
| El Niño, Indian Ocean Dipole | NOAA CPC ONI (ERSSTv5), NOAA PSL DMI (HadISST1) | monthly index | none | `climate`: ONI and DMI of the peak month |

Each dataset is reduced to the 0.05° grid once (`python -m app context`, see "Running it" and
"How the context data is reduced") and stored under `data/context/`. Cells or periods a dataset does not cover leave that evidence `null`,
and the indicators that need it are marked unavailable (`met: null`), never false.

Coverage limits worth knowing:

- Forest loss ends in 2024, so events from 2026 on have no forest-loss evidence, and 2025 events
  only use 2024.
- MODIS land cover starts in 2001; for a year past the last published one the latest year is used,
  and the year used is returned (`landcover.year`).
- IMERG Final is published with a delay of several months (in November 2026 the latest month is
  September 2025), so the most recent events have no rainfall evidence yet.
- DMI from HadISST lags by a few months; ONI is current.

MODIS IGBP classes are grouped as follows:

| Group | IGBP classes |
|---|---|
| `forest` | 1-5 (evergreen and deciduous needleleaf and broadleaf, mixed forest) |
| `shrub_savanna` | 6-9 (closed and open shrubland, woody savanna, savanna) |
| `grassland` | 10 |
| `wetland` | 11 (permanent wetland) |
| `cropland` | 12 |
| `urban` | 13 |
| `mosaic` | 14 (cropland and natural vegetation mosaic) |
| `other` | 15-17 (snow and ice, barren, water) |

### 3. Indicators

Each indicator is a yes/no test on the evidence that gives points to one cause.

Forest loss is scored as **excess** loss: the loss around the fire minus the loss the same cells
usually have over as many years. A 0.05° cell (about 30 km²) in forested Indonesia often loses 1 %
or more of its forest in any three years, fire or not; only the loss above that background ties
clearing to this fire. On the 2026-11-14 data this keeps the median event at no excess loss, and a
quarter of events above 1.4 %. Thresholds come from
the cited literature where it gives one; where it does not, the threshold is a stated convention
(marked below) and can be tuned in `app/attribution.py`.

| Indicator | Cause | Points | Test | Basis |
|---|---|---|---|---|
| `forest_loss_strong` (key) | land clearing | 2 | excess forest loss `>= 5 %` | Forest loss that coincides with fire marks clearing by fire (Tyukavina et al. 2022; Curtis et al. 2018); loss from Hansen et al. 2013. 5 % is a convention |
| `forest_loss_some` (key) | land clearing | 1 | `1 % <=` excess forest loss `< 5 %` | Same; weaker step of the indicator above |
| `tree_cover_before` | land clearing | 1 | `forest_cover_2000 >= 50 %` and excess forest loss `>= 1 %` | Clearing needs forest to clear (Hansen et al. 2013; Curtis et al. 2018) |
| `cropland_dominant` (key) | agricultural burning | 2 | `cropland + mosaic >= 50 %` | Agricultural fires are fires on cropland (Korontzi et al. 2006); land cover from MCD12Q1 |
| `cropland_present` (key) | agricultural burning | 1 | `25 % <= cropland + mosaic < 50 %` | Same; weaker step of the indicator above |
| `small_short` | agricultural burning | 1 | at most 4 cells and 3 days | Crop residue fires are small and short-lived (Korontzi et al. 2006). The size limits are a convention |
| `no_clearing` | agricultural burning | 1 | excess forest loss `< 1 %` | No forest was cleared beyond the usual (Hansen et al. 2013) |
| `dry_months` (key) | wildfire | 1 | three-month rainfall `< 4 mm/day`, Sumatra and Kalimantan only | Fire activity in Sumatra and Borneo rises sharply when dry-season rainfall drops below about 4 mm/day (Field et al. 2009). Elsewhere, for example in Nusa Tenggara where the normal dry season is already below that, the indicator is unavailable and only `rain_deficit` measures drought |
| `rain_deficit` (key) | wildfire | 1 | three-month rainfall `<= 60 %` of its 2001-2020 normal | Drought, not the season alone, drives large fire years (Field et al. 2009; 2016). 60 % is a convention |
| `climate_driver` (key) | wildfire | 1 | ONI `>= +0.5` or DMI `>= +0.4` in the peak month | El Niño (NOAA CPC threshold) and positive Indian Ocean Dipole (Saji et al. 1999; Bureau of Meteorology threshold) bring drought to Indonesia and the large fire years (Field et al. 2016) |
| `peatland` | wildfire | 1 | `peat >= 30 %` | Peat fires smoulder underground and are very hard to put out (Page et al. 2002; Field et al. 2016) |
| `natural_vegetation` | wildfire | 1 | `forest + shrub_savanna + grassland + wetland >= 50 %` | Wildfire burns in natural vegetation (MCD12Q1) |
| `large_long` | wildfire | 1 | at least 20 cells or 7 days | Uncontrolled fires spread and last (Field et al. 2016). The limits are a convention |

### 4. Decision

1. Add the points of every indicator that holds, per cause. The most points per cause are land
   clearing 3, agricultural burning 4 and wildfire 6 (a weaker step never holds together with its
   stronger indicator).
2. A cause can be named only when at least one of its **key** indicators holds. Wildfire also needs
   burnable land: `peatland` or `natural_vegetation` must hold.
3. Among the causes that can be named, the one with the most points wins if it has at least 2 points
   and more points than every other cause (named or not).
4. Otherwise the event is `unknown`, with `confidence: null`. This includes ties, for example a
   large El Niño fire on peat forest that was also lost that year: clearing and an escaped wildfire
   fit equally well, and the evidence cannot tell them apart.

### 5. Result on the 2026-11-14 data

Of the 724,101 events of the vegetation record:

| Cause | Events | Share |
|---|---|---|
| Land clearing | 110,370 | 15 % |
| Agricultural burning | 92,327 | 13 % |
| Wildfire | 168,966 | 23 % |
| Unknown | 352,438 | 49 % |

The split follows the known geography of burning: agricultural burning is the most common named
cause in Java, Bali and Nusa Tenggara, land clearing in Sumatra, and wildfire in Kalimantan. The
largest events of 2015 and 2019, peat-forest fires during El Niño and positive Indian Ocean Dipole
droughts, are attributed to wildfire with high confidence. Unknown remains the largest group. Most
unknown events have no key evidence for any cause: typically a fire in normal weather on natural
vegetation or mixed land, with no forest loss beyond the usual. About 12 % of them are ties between
land clearing and wildfire, and 7 % have fewer than 2 points. Event size does not set the groups
apart: in every group the median event is one cell burning for one day.

### 6. Confidence

| Level | Rule |
|---|---|
| `high` | at least 75 % of the cause's most points, and at least 2 points ahead of every other cause |
| `medium` | at least 50 % of the cause's most points, and at least 1 point ahead |
| `low` | named, but with less support than medium |

Confidence says how consistently the available evidence points to one cause. It is not a
probability that the cause is right; no labelled cause data were used to calibrate it.

## Using it in the dashboard

### `GET /api/events`

Unchanged parameters, plus an optional `cause` (`land_clearing`, `agricultural_burning`, `wildfire`
or `unknown`) that keeps only events attributed to that cause. Every event gains an `attribution`
object, `null` when the attribution has not been built; the response gains
`attribution_disclaimer` (`null` when not built).

```jsonc
{
  "unit": "hotspots (Aqua MODIS-equivalent)",
  "hotspots": "vegetation",
  "attribution_disclaimer": "Possible cause from related environmental evidence, not definitive ...",
  "events": [
    {
      "event": 338908, "start": "2015-08-10", "end": "2015-11-17", "peak_day": "2015-10-03",
      "province_id": "idn-south-sumatra", "...": "the other event fields as before",
      "attribution": {
        "category": "unknown",          // land_clearing | agricultural_burning | wildfire | unknown
        "label": "Unknown",             // display name of the category
        "confidence": null,             // high | medium | low, null when unknown
        "scores": {"land_clearing": 3, "agricultural_burning": 0, "wildfire": 3},
        "indicators": [
          {"id": "forest_loss_strong", "category": "land_clearing", "points": 2, "met": true,
           "text": "Tree cover was lost on at least 5% of the burned area within a year of the fire",
           "sources": ["hansen2013", "tyukavina2022", "curtis2018"]},
          {"id": "dry_months", "category": "wildfire", "points": 1, "met": null,
           "text": "Rainfall over the three months up to the peak averaged under 4 mm/day",
           "sources": ["imerg", "field2009"]}
          // ... one entry per indicator, in the order of the table above
        ],
        "evidence": {
          "forest_cover_2000": {"share": 0.867, "canopy_min_percent": 30, "source": "hansen2013"},
          "forest_loss": {"share": 0.1952, "expected_share": 0.0566, "excess_share": 0.1386,
                          "years": [2014, 2016], "source": "hansen2013"},
          "landcover": {"year": 2014, "source": "mcd12q1",
                        "shares": {"forest": 0.61, "shrub_savanna": 0.2, "grassland": 0.0, "wetland": 0.12,
                                   "cropland": 0.0, "urban": 0.0, "mosaic": 0.07, "other": 0.0}},
          "peat": {"share": 0.476, "source": "gumbricht2017"},
          "rainfall": {"mm_per_day": 2.1, "normal_mm_per_day": 5.8, "share_of_normal": 0.362,
                       "months": ["2015-08", "2015-10"], "normal_years": [2001, 2020], "source": "imerg"},
          "climate": {"month": "2015-10", "oni": 2.28, "dmi": 0.48, "sources": ["oni", "saji1999"]}
        }
      }
    }
  ]
}
```

The forest, peat and climate values are those of the 2015 South Sumatra peat-forest event on the
2026-11-14 data; the land cover and rainfall values are illustrative, since those layers need the
Earthdata download. Event ids change whenever the events are rebuilt. Notes for the frontend:

- Every `evidence` entry is either an object or `null` (dataset missing or not covering the event).
  Shares are fractions from 0 to 1.
- `met` is `true`, `false` or `null` (data unavailable). Show unavailable indicators as such, not as
  "no".
- `sources` and `source` are keys into the `sources` map of `/api/attribution`, which holds the full
  citation and a link for each.
- `forest_loss.years` is the inclusive range of loss years counted. `rainfall.months` is the
  inclusive range of months averaged.

### `GET /api/attribution`

The method in machine-readable form, for a legend, a "how is this decided" panel or citations:

| Field | Content |
|---|---|
| `disclaimer` | the disclaimer text |
| `categories` | `[{id, label, max_points}]`, including `unknown` |
| `min_points` | fewest points for a cause to be named (2) |
| `confidence` | the rule of each confidence level, as text |
| `indicators` | `[{id, category, points, key, text, sources}]` |
| `wildfire_also_needs` | the burnable-land condition of wildfire |
| `sources` | `{key: {citation, url}}` for every dataset and paper |
| `available` | whether the attribution is built |
| `layers` | when built, which evidence the build had: `forest2000`, `forest_loss`, `landcover_year`, `peat`, `rain3`, `oni`, `dmi` |

## How the context data is reduced

The attribution only ever asks one question of a dataset: what it says about a 0.05° cell where fire
burned (or, for rainfall, the 0.1° cell holding it). Everything else in the downloads is dropped once,
when they are reduced, by four steps.

### 1. Only the context cells

Every layer is kept only on the **context cells**: cells with any part inside an Indonesian province
outline (the `boundaries.geojson` the dashboard uses, rasterised at 0.01°, so a cell is 5 x 5 raster
pixels), the ring of 8 cells around them for the coast, and every cell of the fire record
(`cells.parquet`) that falls outside both. That is 77,452 of the 339,701 cells of the
94.5-141.5° E, 11.5° S-6.5° N box (23 %), and all 50,460 cells that have ever had fire. Open sea and
the parts of Malaysia, Brunei, Timor-Leste and Papua New Guinea inside the box are dropped. Land
cells that have not burned yet are kept, so new fire data does not need a new reduction. Code:
`app/context/grid.py` (`kept`, `keep`).

### 2. Pixels to cells

Each pixel goes to the cell holding its centre, and is counted:

| Layer | Pixel | Pixels per cell | What is counted per cell |
|---|---|---|---|
| Hansen | 0.00025° (about 30 m), aligned with the cells | exactly 200 x 200 = 40,000 | forest pixels (canopy >= 30 % in 2000), and forest pixels lost in each year 2001-2024 |
| MODIS MCD12Q1 | 463 m sinusoidal; each centre is converted to longitude and latitude with the MODIS grid formulas | about 145 | classified pixels `n`, and pixels in each of the 8 class groups |
| CIFOR peat | 0.0011° | about 2,000 | mapped pixels `n`, and peat pixels |
| IMERG | 0.1°, aligned with the cells (one 0.1° cell = 2 x 2 cells) | n/a | the 0.1° value is kept as is, for 0.1° cells holding a context cell |

The sinusoidal grid of MODIS is equal-area and the Hansen and peat pixels within one 0.05° cell have
the same area, so counts give area shares directly. Shares are only computed when the data is read
(`app/context/__init__.py`, `layer_sql`), so the stored values are exact integers.

### 3. Only what is not zero

Cells without forest, years without loss and cells without peat are not written. A missing cell
reads as 0 (no forest, no loss, no peat), which is what it means. Land cover and rainfall are dense
and stored for every context cell.

### 4. Small types, sorted rows, strong compression

- Pixel counts are `USMALLINT` (2 bytes; a cell holds at most 40,000 Hansen pixels). Cell indices
  are `SMALLINT`.
- Rainfall is stored in hundredths of mm/day as `USMALLINT`. That keeps two decimals of a monthly
  mean rate; IMERG's own uncertainty is far larger.
- ONI and DMI are 4-byte floats (they have two decimals).
- Rows are sorted by latitude then longitude, so neighbouring rows hold similar values, and every file
  is written as Parquet with zstd at level 19.

### Result

| Layer | Downloaded (kept in `data/raw/context/`) | Reduced (`data/context/`) | Rows |
|---|---|---|---|
| Hansen forest and loss (12 tiles) | about 3 GB | 2.6 MB in 12 files | 69,122 forest cells, 1,244,125 cell-years of loss |
| MODIS land cover (2001-2025) | 1.45 GB, 425 files | 5.2 MB in 25 files | 1,936,300 cell-years |
| CIFOR peat | 40.5 MB | 0.1 MB | 45,042 cells |
| IMERG rainfall (1998-01 to 2025-09) | 6.23 GB, 333 files | 13.5 MB in 333 files | 6,931,062 cell-months |
| ONI and DMI | 0.1 MB | 0.01 MB | 1,881 months |
| Total | about 10.7 GB | 21.4 MB | |

(The Hansen tiles of the 2026-11-14 build were reduced before downloads were kept, so they are not
in `data/raw/context/hansen/`; deleting `data/context/hansen/` and rerunning
`python -m app context hansen` downloads and keeps them.)

The reduced files are what the attribution reads, and all a teammate needs: copying `data/context/`
with the rest of `data/` (excluding `data/raw/context/` if size matters) lets `python -m app attribute`
run without any download or Earthdata account.

## Running it

The readers need a few extra libraries (rasterio, pyhdf, py7zr, numpy) in the `context` dependency
group. They are not installed in the Docker image, which only serves the result.

```bash
cd src/backend
uv sync --group context
uv run --group context python -m app context
uv run python -m app attribute
```

`context` fetches every layer; name some to fetch only those, for example
`python -m app context hansen peat climate`. MODIS land cover and IMERG rainfall need a NASA
Earthdata token: create an account at https://urs.earthdata.nasa.gov, choose "Generate Token" and
put it in `.env` as `EARTHDATA_TOKEN=...` (it expires after 60 days). IMERG also needs the GES DISC
data agreement accepted once on the account: if the download answers "EULA Acceptance Failure",
open the `resolution_url` it gives while logged in and approve "NASA GESDISC DATA ARCHIVE". The
other layers need no account.

Downloads are kept as published in `data/raw/context/<source>/`, next to the FIRMS downloads, and
reduced into `data/context/` (see "How the context data is reduced"). A rerun skips every piece
already reduced and every file already downloaded, so an interrupted run resumes, and deleting a
reduced piece re-reduces it from the kept download without fetching it again.

| Layer | Download | Time (approx.) |
|---|---|---|
| `hansen` | 12 tile pairs, about 3 GB | 20 min |
| `peat` | 40 MB | 5 min (most of it reading the global map) |
| `modis` | 17 tiles per year, about 54 MB per year | depends on the connection |
| `imerg` | 18 MB per month since January 1998 | depends on the connection |
| `climate` | two small text files | seconds |

`attribute` writes `data/derived/event_attribution.parquet` from the events and whatever context
layers exist; missing layers make their indicators unavailable. `python -m app cache` reruns it
automatically when any context layer exists, because rebuilding the events renumbers them.

## Limitations

- **Evidence, not cause.** The categories describe what the land and weather looked like around a
  fire. A land-clearing fire that escapes during a drought is both; the rules then name the cause
  with more support, or `unknown` on a tie.
- **Plantations.** MODIS IGBP has no plantation class. Oil palm and pulpwood plantations mostly map
  as evergreen broadleaf forest or woody savanna, so burning inside plantations tends to count as
  natural vegetation. A plantation layer would sharpen land clearing versus wildfire.
- **Fire-caused forest loss.** Hansen forest loss records loss from any cause, including the fire
  itself. A wildfire that kills forest therefore also scores land-clearing points, which is one
  reason ties stay `unknown`.
- **Coarse cells.** Evidence is summed on 0.05° cells (about 30 km²), much larger than most fires.
  A small fire in a mixed cell gets the cell's mix, not the land under the fire.
- **Peat map.** The peat layer is a modelled map at 231 m; local peat boundaries differ.
- **No calibration.** The thresholds come from the literature or are stated conventions. They have
  not been tuned or validated against field-verified fire causes, for which no national dataset is
  public.

## References

- Curtis, P. G. et al. (2018). Classifying drivers of global forest loss. *Science* 361, 1108-1111.
  https://doi.org/10.1126/science.aau3445
- Field, R. D., van der Werf, G. R., Shen, S. S. P. (2009). Human amplification of drought-induced
  biomass burning in Indonesia since 1960. *Nature Geoscience* 2, 185-188.
  https://doi.org/10.1038/ngeo443
- Field, R. D. et al. (2016). Indonesian fire activity and smoke pollution in 2015 show persistent
  nonlinear sensitivity to El Niño-induced drought. *PNAS* 113, 9204-9209.
  https://doi.org/10.1073/pnas.1524888113
- Friedl, M., Sulla-Menashe, D. (2022). MODIS/Terra+Aqua Land Cover Type Yearly L3 Global 500m SIN
  Grid V061. NASA LP DAAC. https://doi.org/10.5067/MODIS/MCD12Q1.061
- Gumbricht, T. et al. (2017). An expert system model for mapping tropical wetlands and peatlands
  reveals South America as the largest contributor. *Global Change Biology* 23, 3581-3599. Data:
  https://doi.org/10.17528/CIFOR/DATA.00058
- Hansen, M. C. et al. (2013). High-resolution global maps of 21st-century forest cover change.
  *Science* 342, 850-853. https://doi.org/10.1126/science.1244693
- Huffman, G. J. et al. (2023). GPM IMERG Final Precipitation L3 1 month 0.1 degree x 0.1 degree V07.
  NASA GES DISC. https://doi.org/10.5067/GPM/IMERG/3B-MONTH/07
- Korontzi, S. et al. (2006). Global distribution of agricultural fires in croplands from 3 years of
  MODIS data. *Global Biogeochemical Cycles* 20, GB2021. https://doi.org/10.1029/2005GB002529
- NOAA Climate Prediction Center. Oceanic Niño Index (ONI).
  https://www.cpc.ncep.noaa.gov/products/analysis_monitoring/ensostuff/ONI_v5.php
- Page, S. E. et al. (2002). The amount of carbon released from peat and forest fires in Indonesia
  during 1997. *Nature* 420, 61-65. https://doi.org/10.1038/nature01131
- Saji, N. H. et al. (1999). A dipole mode in the tropical Indian Ocean. *Nature* 401, 360-363.
  https://doi.org/10.1038/43854
- Tyukavina, A. et al. (2022). Global trends of forest loss due to fire from 2001 to 2019.
  *Frontiers in Remote Sensing* 3, 825190. https://doi.org/10.3389/frsen.2022.825190
