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

1. **Download.** The FIRMS windows that are new or not settled yet are fetched into `data/raw`. A
   file whose content has not changed is left untouched.
2. **Decide.** When no raw file, no completed day (see below) and no code has changed since the
   release being served, the round stops here: nothing is rebuilt, nothing is published and no
   dashboard is told about new data. Most hourly rounds end here.
3. **Rebuild.** The processed tables are built into a new release folder,
   `data/releases/<time>/parquet` and `.../derived`, by the same stages as a first build:
   `normalise` (cleaning, overlaps, static-source mask), `build` (cell-days, day status, cell
   lookup) and `cache` (region cache, fire events, the fire outlook and whatever else `cache`
   builds). A product (MODIS, S-NPP, NOAA-20, NOAA-21) whose raw files have not changed is copied
   from the release being served instead of being normalised again. `build` and `cache` always
   cover the whole record, because fire events and the outlook depend on every day. The factors are
   not refitted: new data is harmonised with the committed `params.json`.
4. **Check.** The new release must be complete, hold at least 98 % of the detections being served
   and end no more than two days earlier.
5. **Publish.** `data/current.json`, which names the release being served, is replaced in one
   step. The release before it is kept, for requests still reading it; older ones are removed.

Nothing the API serves changes before step 5. Tables built by hand (`data/derived` and
`data/parquet`, from a zip or from the individual commands) are served until the first update
publishes a release. They are deleted with the second release, once a running service has
switched away from them.

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

The fire cause attribution is rebuilt by `cache` only where the context layers (`data/context`,
from `python -m app context`) are present, so keep them next to the data, also in the bucket for
the Cloud Run job. Without them an update leaves the attribution out instead of carrying the old
one over: the events are rebuilt and may be renumbered, and an old attribution could then name the
cause of a different event.

- **Tables:** normalised detections, the static-source mask, cell-days, day status, cell lookup,
  the region cache, the fire events and the fire outlook (issued from the new last data day and
  month), and so every figure computed from them: series, map cells, sensor agreement, anomaly
  scores, critical periods and the forecast timeline.
- **The running API.** It looks at `current.json` every 5 seconds, and when a new release has been
  published it opens that release, without a restart. Each opening reads the files of one release
  only and keeps its own cached answers, and every request uses one opening from start to end. So a
  request sees either the old tables or the new ones, never a mix, and nothing computed on the old
  release is served once the new one is open. `GET /api/meta` reports the new record end and, under
  `data`, when the release was published (`updated`) and when each stream was last fetched
  (`fetched`).
- **An open dashboard** asks `/api/meta` every five minutes while its tab is visible. When newer
  data has arrived it shows a notice with a Reload button, on a line of its own that other messages
  do not replace, and keeps watching for the next update. A page opened later starts from the new
  record end.

## When something fails

| Failure | What happens |
|---|---|
| FIRMS cannot be reached, or the key is missing | The update stops before touching anything |
| One request fails or returns something that is not a detection table | The file it would have replaced is kept, the update carries on, and that stream's newest days stay out of the record until a later fetch succeeds |
| A stage fails (for example rows that do not pass validation) | The unfinished release is removed |
| The new release fails the checks | The unfinished release is removed |
| Two updates start on the same folder | The second stops at once. The lock on `data/.update.lock` is held by the operating system for as long as the first update's process runs, however long, and released when it ends, even if it crashes |

In every case the data being served stays as it was. With `--every`, the failure is logged and the
next round tries again.

## Running it on a schedule

- **A terminal or a server:** `uv run python -m app update --every 60`.
- **Docker Compose:** `docker compose --profile refresh up` starts the app and an `updater`
  service that runs the hourly update on the shared `./data` folder. It reads `FIRMS_MAP_KEY` from
  `.env` and runs as your own user, so the files it writes stay yours and the commands keep working
  on the host. If `id -u` and `id -g` are not 1000, add `HOST_UID` and `HOST_GID` to `.env`.
- **Cron:** call `python -m app update` once per run; overlapping runs are refused by the lock.
- **Google Cloud:** a separate Cloud Run job runs `python -m app update` on the bucket every hour,
  started by Cloud Scheduler; the website service only reads the bucket. The commands are in
  "Keeping the data current on Google Cloud" in the README. A Cloud Storage mount has no file
  locks and keeps the last write, so the lock file goes on the job's own disk
  (`UPDATE_LOCK_DIR=/tmp`) and runs are kept apart by the schedule instead: one task per run, and a
  50-minute timeout before the next hourly start. The service sees a new release within about a
  minute, because the mount caches file details for 60 seconds.

## What one update costs

One update asks FIRMS for the unsettled near-real-time windows of the streams still delivering,
plus the standard product when it has advanced. Measured on 15 November 2026, on a laptop:

| Run | FIRMS requests | Download | Whole update |
|---|---|---|---|
| First update after the 14 November build | 87 (the near-real-time windows once more, under their fixed names) | 1 min 45 s | 3 min 34 s |
| Repeat update | 4 | 6 s | about 1 min |

The first update added 15 November (1,333 detections, fetched at 14:28 UTC) and left every earlier
day of the national record unchanged. No detection was counted twice, and no satellite and day
mixed two sources. A server running throughout showed the new record end right after each update.
