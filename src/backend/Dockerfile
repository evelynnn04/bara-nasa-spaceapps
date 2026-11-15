# API service. Build context: this folder (src/backend).
#
# The data is not part of the image: mount it at /data (`derived/`, `parquet/` and
# `boundaries.geojson`), from a Cloud Storage volume on Cloud Run or a bind mount with Compose.
# Cloud Run sets PORT; locally the API listens on 8000.

FROM python:3.12-slim

COPY --from=ghcr.io/astral-sh/uv:0.13.5 /uv /bin/uv

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    PATH="/app/.venv/bin:$PATH"

WORKDIR /app

COPY pyproject.toml uv.lock ./
RUN uv sync --locked --no-dev

COPY app ./app

RUN useradd --system --no-create-home api
USER api

ENV DATA_DIR=/data \
    BOUNDARIES_PATH=/data/boundaries.geojson \
    PORT=8000

EXPOSE 8000

CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT}"]
