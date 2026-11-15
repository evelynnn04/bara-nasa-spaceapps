# Keeping the fire data current

The record is not frozen at the day it was first built. One command brings it up to date, and can
repeat on a schedule:

```bash
cd src/backend
uv run python -m app update              # once
uv run python -m app update --every 60   # again every hour, until stopped
```

It needs a FIRMS key in `.env` (`FIRMS_MAP_KEY`). `--no-download` rebuilds from the files already
on disk, without a key. The code is `src/backend/app/pipeline/update.py`.

## What an update does

1. **Download.** The FIRMS windows that are new or not settled yet are fetched into `data/raw`.
2. **Rebuild.** The processed tables are rebuilt in a staging folder (`data/.staging`) by the same
   stages as a first build: `normalise` (cleaning, overlaps, static-source mask), `build`
   (cell-days, day status, cell lookup) and `cache` (region cache, fire events and whatever else
   `cache` builds). The factors are not refitted: new data is harmonised with the committed
   `params.json`.
3. **Check.** The rebuilt tables must be complete, hold at least 98 % of the detections being
   served and end no more than two days earlier.
4. **Swap.** The tables are replaced file by file, and `data/derived/_version.json` is written
   last.

Nothing the API serves changes before step 4.

## Which days are in the record

A local day is added only once it has been fully delivered. Otherwise a day whose afternoon
overpass has not arrived yet would read as a quiet day.

When the satellites of the record pass over Indonesia, in hours after 00:00 UTC of the local date
(2026 detections):

| Overpass | Acquired |
|---|---|
| VIIRS, night | the evening before, 15:10 to 19:30 UTC |
| VIIRS, day | 03:20 to 07:40 UTC |
| Aqua MODIS, day (the latest pass, in the west) | up to 09:10 UTC |

FIRMS publishes near-real-time data within about three hours of the overpass. So:

- **A local day counts as finished for a satellite once its data was fetched at or after 13:00 UTC
  of that date** (`COMPLETE_HOUR_UTC` in `download.py`). `data/raw/api/_status.json` keeps the time
  each stream (MODIS, S-NPP, NOAA-20, NOAA-21) was last fetched in full.
- Until then the satellite does not count as having observed that day. The day's VIIRS reference
  falls to the next satellite that has finished it (S-NPP, else NOAA-20, else NOAA-21), and with
  none the day is not part of the record yet. It is never shown as zero.
- The record ends on the last day at least one satellite has finished.

With an hourly update, each day therefore joins the record in the early afternoon UTC (the evening
in Indonesia), and the updates before that only refresh the days already there.

**Late and corrected data.** A window is fetched again on every update until it ends at least three
days before the product's latest date, so detections FIRMS adds or corrects in the days after an
overpass are picked up.

## Overlapping downloads

The same detection can arrive several times: from the yearly archive, from the standard product,
from near-real-time data, and from windows that overlap in time. `normalise` resolves this on
every update:

- **One source per satellite and UTC day:** the archive where it exists, else the standard
  product, else near-real-time data. When the standard product catches up with a day, it replaces
  that day's near-real-time detections.
- **Exact duplicate rows** are removed.

The download keeps the raw folder tidy as well:

- The last window of a product grows from one to five days; the shorter files it replaces are
  deleted.
- A standard-product window is fetched again only when that product's latest date has moved. It
  does not change in between, unlike near-real-time data, which grows during a day. The same goes
  for a near-real-time product whose latest date is more than three days old (a satellite that has
  stopped delivering, as S-NPP did on 2 November 2026).
- FIRMS drops its oldest near-real-time day each day, which renames the first window of the plan.
  Days already held by a settled file are not asked for again.

## What is refreshed

- **Tables:** normalised detections, the static-source mask, cell-days, day status, cell lookup,
  the region cache and the fire events, and so every figure computed from them: series, map cells,
  sensor agreement, anomaly scores and critical periods.
- **The running API.** It looks at `_version.json` every 30 seconds. When an update has replaced the
  tables it reopens them and drops its cached answers, without a restart. `GET /api/meta` reports
  the new record end and, under `data`, when the tables were replaced (`updated`) and when each
  stream was last fetched (`fetched`).
- **An open dashboard** asks `/api/meta` every five minutes while its tab is visible, and says when
  newer data has arrived. Reloading the page shows it; a page opened later starts from the new
  record end.

## When something fails

| Failure | What happens |
|---|---|
| FIRMS cannot be reached, or the key is missing | The update stops before touching anything |
| One request fails or returns something that is not a detection table | The file it would have replaced is kept, the update carries on, and that stream's newest days stay out of the record until a later fetch succeeds |
| A stage fails (for example rows that do not pass validation) | The staging folder is discarded |
| The rebuilt tables fail the checks | The staging folder is discarded |
| Two updates start on the same folder | The second stops at once (`data/.update.lock`; a lock older than six hours is taken to be left over) |

In every case the data being served stays as it was. With `--every`, the failure is logged and the
next round tries again.

## Running it on a schedule

- **A terminal or a server:** `uv run python -m app update --every 60`.
- **Docker Compose:** `docker compose --profile refresh up` starts the app and an `updater`
  service that runs the hourly update on the shared `./data` folder. It reads `FIRMS_MAP_KEY` from
  `.env`.
- **Cron:** call `python -m app update` once per run; overlapping runs are refused by the lock.
- **Cloud Run:** the service reads the bucket read-only, so run the update where the data folder
  lives and copy the tables to the bucket, the version marker last (see "Deploying to Cloud Run" in
  the README).

## What one update costs

One update asks FIRMS for the unsettled near-real-time windows of the streams still delivering,
plus the standard product when it has advanced. Measured on 15 November 2026, on a laptop:

| Run | FIRMS requests | Download | Whole update |
|---|---|---|---|
| First update after the 14 November build | 87 (the near-real-time windows once more, under their fixed names) | 1 min 45 s | 3 min 34 s |
| Repeat update | 4 | 6 s | about 1 min |

The first update added 15 November (1,333 detections, fetched at 14:28 UTC) and left every earlier
day of the national record unchanged. No detection was counted twice, and no satellite and day
mixed two sources. A server running throughout showed the new record end right after each swap.
