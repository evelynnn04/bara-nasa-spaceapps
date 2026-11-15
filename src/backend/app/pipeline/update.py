"""Bring the data up to date in one step: `python -m app update`.

1. **Download** the FIRMS windows that are new or not settled yet (`download`).
2. **Rebuild** the processed tables with the same stages as a first build (`normalise`, `build`,
   `cache`; never `fit`), in a staging folder next to the tables being served.
3. **Check** the result against the tables being served (`check`).
4. **Swap** it in file by file and write `derived/_version.json`, which tells a running API to
   reopen the tables and drop its caches.

Nothing the API serves changes before step 4. A failed download leaves the raw files as they were
and the update carries on with what it has; a failure in steps 2 or 3 discards the staging folder.
Either way the last valid data stays in place.

With `--every N`, the update repeats every N minutes and survives failed rounds.
"""

from __future__ import annotations

import datetime as dt
import json
import logging
import os
import shutil
import time
from pathlib import Path

import duckdb

from .. import config
from ..db import quote
from . import download

log = logging.getLogger("app.update")

#: Stages of `python -m app` run on every update, in order.
STAGES = ("normalise", "build", "cache")
#: Tables an update must produce.
REQUIRED = ("celldays", "days", "cells", "region_daily", "events")
#: An update is rejected when it holds fewer detections than this share of the data being served,
#: or when its record ends more than `MAX_DAYS_BACK` days earlier. Detections only accumulate, apart
#: from the few that change when the standard product replaces near-real-time data.
MIN_DETECTION_SHARE = 0.98
MAX_DAYS_BACK = 2
#: A lock older than this is taken to be left over from a crashed run.
STALE_LOCK_SECONDS = 6 * 3600


class UpdateRejected(RuntimeError):
    """The rebuilt tables failed the checks and were not swapped in."""


def staging_dir() -> Path:
    return config.data_dir() / ".staging"


def version_path() -> Path:
    """Marker written last by every update; the API reloads when it changes."""
    return config.derived_dir() / "_version.json"


def load_version() -> dict | None:
    path = version_path()
    return json.loads(path.read_text(encoding="utf-8")) if path.is_file() else None


def summary(con: duckdb.DuckDBPyConnection, root: Path) -> dict | None:
    """Detection count and record span of the processed tables under `root`, or None when they
    are missing."""
    detections = root / "parquet" / "detections"
    days = root / "derived" / "days.parquet"
    if not days.is_file() or not any(detections.glob("*.parquet")):
        return None
    n = con.execute(f"SELECT count(*) FROM read_parquet({quote(str(detections / '*.parquet'))})").fetchone()[0]
    first, last, count = con.execute(f"""
        SELECT min(local_date), max(local_date), count(*) FROM read_parquet({quote(str(days))})
        WHERE record_platform IS NOT NULL""").fetchone()
    return {"detections": n, "record_start": first, "record_end": last, "record_days": count}


def check(new: dict | None, old: dict | None, stage: Path) -> None:
    """Raises `UpdateRejected` unless the staged tables are complete and consistent with the data
    being served (`old`, None on a first build)."""
    missing = [t for t in REQUIRED if not (stage / "derived" / f"{t}.parquet").is_file()]
    if new is None or missing:
        raise UpdateRejected(f"the rebuild is incomplete (missing: {', '.join(missing) or 'detections'})")
    if new["record_end"] is None:
        raise UpdateRejected("the rebuilt record has no observed day")
    if old is None or old["record_end"] is None:
        return
    if new["detections"] < MIN_DETECTION_SHARE * old["detections"]:
        raise UpdateRejected(f"the rebuild holds {new['detections']} detections, "
                             f"down from {old['detections']} in the data being served")
    if new["record_end"] < old["record_end"] - dt.timedelta(days=MAX_DAYS_BACK):
        raise UpdateRejected(f"the rebuilt record ends on {new['record_end']}, "
                             f"earlier than {old['record_end']} in the data being served")


def swap_in(stage: Path, version: dict) -> None:
    """Replaces the served tables with the staged ones: the detections folder as a whole, then
    every derived file (files the update did not rebuild are kept), then the version marker."""
    live_parquet, live_derived = config.parquet_dir(), config.derived_dir()
    new, live = stage / "parquet" / "detections", live_parquet / "detections"
    retired = live.with_name("detections.old")
    shutil.rmtree(retired, ignore_errors=True)
    live_parquet.mkdir(parents=True, exist_ok=True)
    if live.is_dir():
        live.rename(retired)
    new.rename(live)
    shutil.rmtree(retired, ignore_errors=True)
    live_derived.mkdir(parents=True, exist_ok=True)
    for path in sorted((stage / "derived").iterdir()):
        if path.is_file():
            os.replace(path, live_derived / path.name)
    tmp = version_path().with_suffix(".part")
    tmp.write_text(json.dumps(version, indent=1) + "\n", encoding="utf-8")
    os.replace(tmp, version_path())


class Lock:
    """Keeps two updates from running on the same data folder."""

    def __init__(self) -> None:
        self.path = config.data_dir() / ".update.lock"

    def __enter__(self) -> "Lock":
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if self.path.is_file() and time.time() - self.path.stat().st_mtime > STALE_LOCK_SECONDS:
            self.path.unlink(missing_ok=True)
        try:
            fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            raise RuntimeError(f"another update is running ({self.path} exists)") from None
        os.write(fd, str(os.getpid()).encode())
        os.close(fd)
        return self

    def __exit__(self, *exc) -> None:
        self.path.unlink(missing_ok=True)


def rebuild(stage: Path) -> None:
    """Runs the processing stages with the tables going to `stage`."""
    from .. import cli
    shutil.rmtree(stage, ignore_errors=True)
    with config.staged(stage):
        for name in STAGES:
            cli.main([name])


def run_once(fetch: bool = True) -> dict:
    """One update; returns the new version record. Raises when the data being served was kept:
    `UpdateRejected` when the rebuild failed its checks, any other error from a stage."""
    with Lock():
        stats = download.run() if fetch else {}
        if stats.get("failed"):
            log.warning("%d download(s) failed; carrying on with the files already on disk", stats["failed"])
        stage = staging_dir()
        try:
            rebuild(stage)
            con = duckdb.connect()
            new, old = summary(con, stage), summary(con, config.data_dir())
            check(new, old, stage)
            version = {
                "updated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
                "record_end": new["record_end"].isoformat(),
                "detections": new["detections"],
                "fetched": download.load_status().get("fetched", {}),
                "download": {k: stats[k] for k in ("downloaded", "failed") if k in stats},
            }
            swap_in(stage, version)
        finally:
            shutil.rmtree(stage, ignore_errors=True)
    added = new["detections"] - (old["detections"] if old else 0)
    log.info("data updated: record to %s, %d detections (%+d)", version["record_end"], new["detections"], added)
    return version


def run(every: float | None = None, fetch: bool = True) -> None:
    """Updates once, or with `every` (minutes) again and again. A failed round is logged and the
    data being served stays; the next round tries again."""
    if every is None:
        run_once(fetch)
        return
    while True:
        started = time.time()
        try:
            run_once(fetch)
        except Exception as exc:  # noqa: BLE001 - the loop must outlive any failed round
            log.error("update failed, keeping the data being served: %s", download.REDACT(str(exc)))
        time.sleep(max(0.0, every * 60 - (time.time() - started)))
