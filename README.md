# Space Apps
## SOLVE REAL-WORLD CHALLENGES ON EARTH & IN SPACE
The NASA Space Apps Challenge is a hackathon for coders, scientists, designers, storytellers, makers, technologists, and innovators around the world to come together and use open data from NASA and its Space Agency Partners to create solutions to challenges we face on Earth and in space.

## TERMS & CONDITIONS
By participating in [Discussions](https://github.com/nasa/spaceapps/discussions) within this repository, you are confirming that you have [registered](https://www.spaceappschallenge.org/) for the 2026 NASA Space Apps Hackathon and have agreed to and signed the [Terms & Conditions](https://www.spaceappschallenge.org/legal/).

## IF YOU SEE SOMETHING, SAY SOMETHING
If you experience or witness discrimination, harassment, or any form of bullying during the Space Apps Challenge, or have any other concerns, please contact your Local Lead and/or the Space Apps Global Organizing (GO) Team at [conduct@spaceappschallenge.org](mailto:conduct@spaceappschallenge.org)

## Running with Docker
Requires Docker with Compose v2.

```bash
docker compose up --build
```

The website and the API run as one service on `http://localhost:8000`: the landing page at `/`, the dashboard at `/dashboard/`, the API under `/api`. Check it with `curl http://localhost:8000/health`, which returns `{"status":"ok"}`. Interactive API docs are at `http://localhost:8000/docs`. Stop it with `docker compose down`. The data must be in place first (see "Fire data").

### Local development without Docker
Dependencies are managed with [uv](https://docs.astral.sh/uv/) and pinned in `src/backend/uv.lock`.

```bash
cd src/backend
uv sync
uv run uvicorn app.main:app --reload
```

Add a dependency with `uv add <package>`, which updates `pyproject.toml` and `uv.lock`.

## Fire data
The backend serves NASA FIRMS active fire data for Indonesia, harmonised across MODIS and VIIRS
into one record (see [docs/harmonisation.md](docs/harmonisation.md)). The data lives in `data/`,
which is not committed, so after cloning you either unzip a copy from a teammate (option A, a few
minutes) or build it yourself (option B, up to three hours).

You need [uv](https://docs.astral.sh/uv/) for the backend and Node.js 20.19+ or 22.12+ for the
dashboard.

### Option A: unzip the shared data
Ask a teammate for the data zip, for example `spaceapps-fire-data-2026-11-14.zip` (about 340 MB
zipped, 915 MB unzipped; the date is the last day it covers). It holds every stage of the data:

- `data/raw/`: the FIRMS downloads as received (country archive per sensor and year, and the 5-day
  API windows);
- `data/parquet/`: the cleaned detections, which the raw detections CSV reads;
- `data/derived/`: the tables the backend serves (cell-days, day status, cell lookup, region cache
  and fire events).

Unzip it at the repository root:

```bash
cd spaceapps
unzip ~/Downloads/spaceapps-fire-data-2026-11-14.zip
```

On Windows, run `tar -xf spaceapps-fire-data-2026-11-14.zip` in the repository folder instead.
Double-clicking the zip usually unpacks it into a new folder; in that case move the `data` folder
inside it to the repository root.

You should now have `spaceapps/data/raw/`, `spaceapps/data/parquet/` and `spaceapps/data/derived/`.
The backend and dashboard work straight away, with no FIRMS key and no `fit` (the fitted factors
are committed in `src/backend/app/harmonise/params.json`). To check the data, run the backend tests;
the tests on real data run only when the data is present:

```bash
cd src/backend
uv sync
uv run pytest
```

Because the raw downloads are included, you can also rerun any stage to experiment, for example
changing the cleaning rules and running `normalise`, `build` and `cache` again (about 45 seconds
in all), without a FIRMS key. Only fetching newer days needs a key (see "Updating and sharing the
data").

### Option B: build the data yourself
1. Get a free FIRMS map key at https://firms.modaps.eosdis.nasa.gov/api/map_key/ and put it in
   `.env` as `FIRMS_MAP_KEY=...` (see `.env.example`).
2. Download and build the data:

```bash
cd src/backend
uv run python -m app download
uv run python -m app normalise
uv run python -m app build
uv run python -m app cache
```

| Download | Time | Disk | Covers |
|---|---|---|---|
| Archive only (`download --no-api`, no key needed) | about 17 minutes | about 650 MB | 2000 to December 2025, without NOAA-21 |
| Archive and API (with the key) | about 3 hours | about 870 MB | up to yesterday, with NOAA-21 |

The API part is slow because FIRMS takes over a minute to answer each 5-day request, and most
requests are for NOAA-21, which the country archive does not include. The download can be stopped
and run again; it only fetches what is missing or still provisional.

`python -m app all` runs every stage including `fit`, which refits the factors and rewrites the
committed `params.json`. Run it only when you mean to change the fitted method.

### Updating and sharing the data
To bring the data up to date, add a FIRMS key to `.env` and run one command:

```bash
cd src/backend
uv run python -m app update              # once
uv run python -m app update --every 60   # again every hour, until stopped
```

It downloads the windows that are new or were still provisional and, when anything changed,
builds the tables into a new release folder (`data/releases/`) with the same stages as a first
build (`normalise`, `build`, `cache`), checks them and only then publishes them by updating
`data/current.json`. A round without new data rebuilds nothing. A running backend switches to the
new release within seconds, without a restart; an open dashboard says that newer data has arrived.
If a download or a stage fails, the data being served stays as it was. With Docker,
`docker compose --profile refresh up` runs the hourly update next to the app. The rules (which days count as finished, how overlapping downloads
are resolved, what a failed update leaves behind) are in [docs/recent-data.md](docs/recent-data.md).

To share the data, zip the whole `data` folder from the repository root:

```bash
zip -r spaceapps-fire-data-YYYY-MM-DD.zip data
```

With the data in place, `docker compose up --build` mounts `data/` into the backend. The API is
documented at `http://localhost:8000/docs`; the main endpoints are `/api/meta`, `/api/series`,
`/api/cells`, `/api/agreement`, `/api/events`, `/api/anomalies`, `/api/critical`, `/api/outlook`
and `/api/detections.csv`. The anomaly method is described in [docs/anomaly.md](docs/anomaly.md). How
`/api/critical` finds historically critical fire periods is described in
[docs/critical-periods.md](docs/critical-periods.md); `uv run python -m app validate-critical` (in
`src/backend`) reproduces its validation on the local data. The fire outlook per cell behind the
forecast timeline (30 days, 12 months, 5 years), how it is counted and its evaluation on held-out
years are described in [docs/fire-outlook.md](docs/fire-outlook.md); `uv run python -m app
validate-outlook` reproduces the evaluation. The outlook is built by `cache`, so data cached before
it needs `uv run python -m app cache` once.

Values are in hotspots (Aqua MODIS-equivalent); every endpoint takes `hotspots=vegetation` (the
default) or `hotspots=all`. Data unzipped from a zip made before the hotspot unit lacks the counts of
the other hotspot types, and the API answers 503 until `uv run python -m app build` and
`uv run python -m app cache` are run once (about 30 seconds, no FIRMS key needed).

## Running the dashboard
The dashboard in `src/frontend/` reads everything from the backend. Start the backend first (with
the data built), then:

```bash
cd src/frontend
npm ci
npm run dev
```

The landing page opens at `http://localhost:5173/` and the dashboard at
`http://localhost:5173/dashboard/`. The dev server proxies `/api` to `http://localhost:8000` (set `API_PROXY` to use another address).
A production build (`npm run build`) expects the API on the same origin, or at `VITE_API_BASE`.
Frontend tests run with `npm test`.

Run the backend tests with:

```bash
cd src/backend
uv run pytest
```

## Deploying to Cloud Run
The dashboard and the API deploy as one Cloud Run service from the `Dockerfile` at the repository
root: it builds the landing page and the dashboard and serves them at `/` and `/dashboard/`, next to the
API under `/api`.

The data is not committed, so the service reads it from a Cloud Storage bucket mounted read-only.
It needs `data/derived/` and `data/parquet/` (about 220 MB); the region outlines are part of the
image. Upload them, here into a `data/` folder of the bucket:

```bash
gcloud storage cp -r data/derived data/parquet gs://BUCKET/data/
```

Then deploy with the bucket mounted and `DATA_DIR` pointing at that folder:

```bash
gcloud run deploy SERVICE --source . --region REGION --allow-unauthenticated \
  --execution-environment gen2 --memory 2Gi \
  --add-volume name=bucket,type=cloud-storage,bucket=BUCKET,readonly=true \
  --add-volume-mount volume=bucket,mount-path=/mnt/bucket \
  --set-env-vars DATA_DIR=/mnt/bucket/data
```

To deploy on every push instead, connect the service to the repository in the Cloud Run console
with build type Dockerfile and source location `/Dockerfile`, and set the same volume, mount and
`DATA_DIR` under the container settings. `https://SERVICE_URL/api/meta` returns the record dates
once the data is found.

After `python -m app update`, send the releases to the bucket, then `current.json`, so the service
switches only once the new release is complete:

```bash
gcloud storage rsync -r --delete-unmatched-destination-objects data/releases gs://BUCKET/data/releases
gcloud storage cp data/current.json gs://BUCKET/data/
```

The service looks at `current.json` every few seconds and opens the new release when it has
changed, so no redeploy is needed (the bucket mount may take a minute or so longer to show it).
