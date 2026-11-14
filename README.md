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
