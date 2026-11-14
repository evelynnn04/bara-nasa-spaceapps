from fastapi import FastAPI

app = FastAPI(title="Space Apps API")


@app.get("/health")
def health() -> dict[str, str]:
    """Report that the API process is up and able to serve requests."""
    return {"status": "ok"}
