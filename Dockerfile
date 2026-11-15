# One service for the website and the API. Build context: the repository root.
#
# The landing page and the dashboard are built with Node, then served by the API: the landing page
# at `/`, the dashboard at `/dashboard/`, next to `/api`. The fire data is
# not part of the image: mount it at /data (`derived/` and `parquet/`), from a Cloud Storage volume
# on Cloud Run or a bind mount with Compose, or point DATA_DIR at it. Cloud Run sets PORT; locally
# the service listens on 8000.

FROM node:22-alpine AS frontend

WORKDIR /frontend

COPY src/frontend/package.json src/frontend/package-lock.json ./
RUN npm ci

COPY src/frontend/ ./
RUN npm run build

FROM python:3.12-slim

COPY --from=ghcr.io/astral-sh/uv:0.13.5 /uv /bin/uv

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    PATH="/app/.venv/bin:$PATH"

WORKDIR /app

COPY src/backend/pyproject.toml src/backend/uv.lock ./
RUN uv sync --locked --no-dev

COPY src/backend/app ./app
COPY --from=frontend /frontend/dist ./static

# A fixed user id, so a Cloud Storage volume can be mounted writable for it (mount option uid=10001).
RUN useradd --system --uid 10001 --no-create-home api
USER api

# The region outlines ship with the dashboard, so the API reads the same file the browser does.
ENV DATA_DIR=/data \
    BOUNDARIES_PATH=/app/static/boundaries.geojson \
    PORT=8000

EXPOSE 8000

# Cloud Run terminates HTTPS in front of the container; trust its forwarded scheme so redirects stay on https.
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT} --forwarded-allow-ips '*'"]
