# Space Apps
## SOLVE REAL-WORLD CHALLENGES ON EARTH & IN SPACE
The NASA Space Apps Challenge is a hackathon for coders, scientists, designers, storytellers, makers, technologists, and innovators around the world to come together and use open data from NASA and its Space Agency Partners to create solutions to challenges we face on Earth and in space.

## TERMS & CONDITIONS
By participating in [Discussions](https://github.com/nasa/spaceapps/discussions) within this repository, you are confirming that you have [registered](https://www.spaceappschallenge.org/) for the 2026 NASA Space Apps Hackathon and have agreed to and signed the [Terms & Conditions](https://www.spaceappschallenge.org/legal/).

## IF YOU SEE SOMETHING, SAY SOMETHING
If you experience or witness discrimination, harassment, or any form of bullying during the Space Apps Challenge, or have any other concerns, please contact your Local Lead and/or the Space Apps Global Organizing (GO) Team at [conduct@spaceappschallenge.org](mailto:conduct@spaceappschallenge.org)

## Running the backend
Requires Docker with Compose v2.

```bash
docker compose up --build
```

The API listens on `http://localhost:8000`. Check it with `curl http://localhost:8000/health`, which returns `{"status":"ok"}`. Interactive API docs are at `http://localhost:8000/docs`. Stop it with `docker compose down`.

### Local development without Docker
Dependencies are managed with [uv](https://docs.astral.sh/uv/) and pinned in `backend/uv.lock`.

```bash
cd backend
uv sync
uv run uvicorn app.main:app --reload
```

Add a dependency with `uv add <package>`, which updates `pyproject.toml` and `uv.lock`.

## Fire data
The backend serves NASA FIRMS active fire data for Indonesia, harmonised across MODIS and VIIRS
into one record (see [docs/harmonisation.md](docs/harmonisation.md)). The data lives in `data/`,
which is not committed.

1. Get a free FIRMS map key at https://firms.modaps.eosdis.nasa.gov/api/map_key/ and put it in
   `.env` as `FIRMS_MAP_KEY=...` (see `.env.example`). The archive alone needs no key.
2. Build the data (the first download takes a few hours, mostly the FIRMS API rate limit):

```bash
cd backend
uv run python -m app all
```

Each stage can also run alone: `download` (add `--no-api` to skip the key), `normalise`, `build`,
`fit` and `cache`. Re-running `download` only fetches what is missing or still provisional.
`fit` rewrites `backend/app/harmonise/params.json`, which is committed.

With the data in place, `docker compose up --build` mounts `data/` into the backend. The API is
documented at `http://localhost:8000/docs`; the main endpoints are `/api/meta`, `/api/series`,
`/api/cells`, `/api/agreement`, `/api/events` and `/api/detections.csv`.

## Running the dashboard
The dashboard in `src/frontend/` reads everything from the backend. Start the backend first (with
the data built), then:

```bash
cd src/frontend
npm ci
npm run dev
```

The dev server proxies `/api` to `http://localhost:8000` (set `API_PROXY` to use another address).
A production build (`npm run build`) expects the API on the same origin, or at `VITE_API_BASE`.
Frontend tests run with `npm test`.

Run the backend tests with:

```bash
cd backend
uv run pytest
```
