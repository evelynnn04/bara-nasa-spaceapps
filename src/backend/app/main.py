import os
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles

from .api import router

#: Built dashboard (`npm run build` output), served at `/` when present, as in the container image.
DASHBOARD_DIR = Path(os.environ.get("DASHBOARD_DIR") or Path(__file__).resolve().parents[1] / "static")


def create_app(dashboard_dir: Path | None = DASHBOARD_DIR) -> FastAPI:
    """The API under `/api` and `/health`, plus the built dashboard at `/` when `dashboard_dir`
    exists. In development the dashboard runs on the Vite dev server instead."""
    app = FastAPI(title="Space Apps API")
    # Map cells and series run to hundreds of kilobytes; compressed they are about a third of that.
    app.add_middleware(GZipMiddleware, minimum_size=1000)
    app.include_router(router)

    @app.get("/health")
    def health() -> dict[str, str]:
        """Report that the API process is up and able to serve requests."""
        return {"status": "ok"}

    if dashboard_dir is not None and dashboard_dir.is_dir():
        app.mount("/", StaticFiles(directory=dashboard_dir, html=True), name="dashboard")
    return app


app = create_app()
