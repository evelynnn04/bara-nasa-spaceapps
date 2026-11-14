from fastapi import FastAPI
from fastapi.middleware.gzip import GZipMiddleware

from .api import router

app = FastAPI(title="Space Apps API")
# Map cells and series run to hundreds of kilobytes; compressed they are about a third of that.
app.add_middleware(GZipMiddleware, minimum_size=1000)
app.include_router(router)


@app.get("/health")
def health() -> dict[str, str]:
    """Report that the API process is up and able to serve requests."""
    return {"status": "ok"}
