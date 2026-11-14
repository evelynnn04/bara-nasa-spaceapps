from fastapi import FastAPI

from .api import router

app = FastAPI(title="Space Apps API")
app.include_router(router)


@app.get("/health")
def health() -> dict[str, str]:
    """Report that the API process is up and able to serve requests."""
    return {"status": "ok"}
