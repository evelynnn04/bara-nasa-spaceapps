"""Bring the data up to date in one step: `python -m app update`.

1. **Download** the FIRMS windows that are new or not settled yet (`download`). A file whose
   content did not change is left untouched.
2. **Decide.** When no raw file, no completed day and no code changed since the release being
   served, the round ends here: nothing is rebuilt and nothing is announced.
3. **Rebuild** the processed tables into a new release folder, `data/releases/<id>/`, with the
   same stages as a first build (`normalise`, `build`, `cache`; never `fit`). Products whose raw
   files did not change are copied from the release being served instead of being normalised again.
4. **Check** the new release against the one being served (`check`).
5. **Publish** it by replacing `data/current.json`, the pointer to the release being served, in one
   step. The API opens each release on its own, so a request sees either the old tables or the
   new ones, never a mix. The previous release is kept for requests still using it; older ones are
   removed.

Nothing the API serves changes before step 5. A failed download leaves the raw files as they were
and the update carries on with what it has; a failure in steps 3 or 4 removes the unfinished
release. Either way the last valid data stays in place.

With `--every N`, the update repeats every N minutes and survives failed rounds.
"""

from __future__ import annotations

import datetime as dt
import errno
import hashlib
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

#: Stages of `python -m app` run after `normalise` on every rebuild, in order.
STAGES = ("build", "cache")
#: Tables a release must hold.
REQUIRED = ("celldays", "days", "cells", "region_daily", "events")
#: A release is rejected when it holds fewer detections than this share of the data being served,
#: or when its record ends more than `MAX_DAYS_BACK` days earlier. Detections only accumulate, apart
#: from the few that change when the standard product replaces near-real-time data.
MIN_DETECTION_SHARE = 0.98
MAX_DAYS_BACK = 2
#: Releases kept on disk: the one being served and the one before it.
KEEP_RELEASES = 2
APP_DIR = Path(__file__).resolve().parents[1]


class UpdateRejected(RuntimeError):
    """The rebuilt tables failed the checks and were not published."""


def pointer_path() -> Path:
    return config.pointer_path()


def _now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def new_release(now: dt.datetime) -> Path:
    """Folder for a new release, named after its time to the microsecond, so names never repeat and
    sort in the order releases were made."""
    path = config.releases_dir() / now.strftime("%Y%m%dT%H%M%S%fZ")
    while path.exists():
        now += dt.timedelta(microseconds=1)
        path = config.releases_dir() / now.strftime("%Y%m%dT%H%M%S%fZ")
    return path


def load_version() -> dict | None:
    """The version record of the release being served, or None for data built by hand."""
    path = pointer_path()
    try:
        return json.loads(path.read_text(encoding="utf-8")) if path.is_file() else None
    except ValueError:
        return None


def _hash(lines) -> str:
    h = hashlib.sha256()
    for line in lines:
        h.update(f"{line}\n".encode())
    return h.hexdigest()[:16]


def _files_hash(paths) -> str:
    return _hash(f"{p.name}:{p.stat().st_size}:{p.stat().st_mtime_ns}" for p in sorted(paths) if p.is_file())


def code_hash(paths) -> str:
    """Hash of the content of source files, so new code triggers a rebuild."""
    return _hash(hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(paths) if p.is_file())


def stream_inputs(stream: config.Stream) -> list[Path]:
    """The raw files one product is normalised from."""
    raw = config.raw_dir()
    files = list((raw / "archive").glob(f"{stream.key}_*.csv"))
    for source in (stream.api_sp, stream.api_nrt):
        files += list((raw / "api" / source).glob("*.csv"))
    return files


def fingerprint() -> dict:
    """What a release is built from: the raw files of every product, the last complete day of
    every platform, and the code. Two rounds with the same fingerprint build the same tables."""
    normalise_code = code_hash([APP_DIR / "pipeline" / "normalise.py", APP_DIR / "config.py", APP_DIR / "geo.py",
                                config.boundaries_path()])
    return {
        "inputs": {key: _files_hash(stream_inputs(s)) for key, s in config.STREAMS.items()},
        "complete_through": {p: d.isoformat() for p, d in sorted(download.complete_through().items())},
        "normalise_code": normalise_code,
        "code": code_hash([*APP_DIR.rglob("*.py"), config.params_path()]),
    }


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


def check(new: dict | None, old: dict | None, release: Path) -> None:
    """Raises `UpdateRejected` unless the new release is complete and consistent with the data
    being served (`old`, None on a first build)."""
    missing = [t for t in REQUIRED if not (release / "derived" / f"{t}.parquet").is_file()]
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


def keep_extra_files(current: Path, release: Path) -> None:
    """Copies derived files of the release being served that the rebuild does not produce (layers
    built by other commands), so publishing does not drop them."""
    src = current / "derived"
    if not src.is_dir():
        return
    for path in src.iterdir():
        dest = release / "derived" / path.name
        if path.is_file() and not dest.exists() and not path.name.startswith("."):
            shutil.copy2(path, dest)


def publish(release: Path, version: dict) -> None:
    """Points `current.json` at `release` in one atomic replace, then removes releases older than
    the previous one. The hand-built tables the first release replaces are removed one release
    later, once a running service has had time to switch away from them."""
    pointer = pointer_path()
    switched = pointer.is_file()
    tmp = pointer.with_suffix(".part")
    tmp.write_text(json.dumps(version, indent=1) + "\n", encoding="utf-8")
    os.replace(tmp, pointer)
    older = sorted(p.name for p in config.releases_dir().iterdir() if p.is_dir() and p.name < release.name)
    keep = {release.name, *older[-(KEEP_RELEASES - 1):]}
    releases = [p for p in config.releases_dir().iterdir() if p.is_dir()]
    for path in releases:
        if path.name not in keep:
            shutil.rmtree(path, ignore_errors=True)
    for legacy in (config.data_dir() / "derived", config.data_dir() / "parquet"):
        if switched and legacy.is_dir():
            shutil.rmtree(legacy, ignore_errors=True)
            log.info("removed %s: the data is now served from %s", legacy, config.releases_dir())


class Lock:
    """Keeps two updates from running on the same data folder. The operating system releases the
    lock when the process ends, however it ends, so a crashed run never blocks the next one and a
    slow run is never mistaken for a crashed one.

    The lock file lives in the data folder, or in `UPDATE_LOCK_DIR` when set. A file system without
    locks (a Cloud Storage mount) cannot hold it: there the lock is skipped with a warning, and the
    scheduler must keep runs apart (see docs/recent-data.md)."""

    def __init__(self) -> None:
        folder = Path(os.environ.get("UPDATE_LOCK_DIR") or config.data_dir())
        self.path = folder / ".update.lock"
        self.fd: int | None = None

    def __enter__(self) -> "Lock":
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.fd = os.open(self.path, os.O_CREAT | os.O_RDWR)
        try:
            _lock_file(self.fd)
        except OSError as exc:
            os.close(self.fd)
            self.fd = None
            if exc.errno not in HELD:
                log.warning("%s cannot be locked (%s); relying on the scheduler to keep updates apart",
                            self.path, exc.strerror)
                return self
            raise RuntimeError(f"another update is running on {config.data_dir()}") from None
        os.ftruncate(self.fd, 0)
        os.write(self.fd, str(os.getpid()).encode())
        return self

    def __exit__(self, *exc) -> None:
        if self.fd is not None:
            _unlock_file(self.fd)
            os.close(self.fd)
            self.fd = None


#: Errors that mean the lock is held by another process (any other error: locks unsupported).
HELD = {errno.EAGAIN, errno.EWOULDBLOCK, errno.EACCES}

try:
    import fcntl

    def _lock_file(fd: int) -> None:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)

    def _unlock_file(fd: int) -> None:
        fcntl.flock(fd, fcntl.LOCK_UN)
except ImportError:  # Windows
    import msvcrt

    def _lock_file(fd: int) -> None:
        msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)

    def _unlock_file(fd: int) -> None:
        os.lseek(fd, 0, os.SEEK_SET)
        msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)


def rebuild(release: Path, reuse: tuple[str, ...] = (), reuse_from: Path | None = None) -> None:
    """Runs the processing stages with the tables going to `release`, copying the normalised
    detections of the products in `reuse` from the folder `reuse_from`."""
    from .. import cli
    from . import normalise
    shutil.rmtree(release, ignore_errors=True)
    with config.staged(release):
        normalise.run(reuse=reuse, reuse_from=reuse_from)
        for name in STAGES:
            cli.main([name])


def run_once(fetch: bool = True) -> dict | None:
    """One update; returns the new version record, or None when nothing changed. Raises when the
    data being served was kept: `UpdateRejected` when the rebuild failed its checks, any other
    error from a stage."""
    with Lock():
        stats = download.run() if fetch else {}
        if stats.get("failed"):
            log.warning("%d download(s) failed; carrying on with the files already on disk", stats["failed"])
        current, served = config.release_root(), load_version()
        prints = fingerprint()
        if served is not None and all(served.get(k) == v for k, v in prints.items()):
            log.info("no new data since release %s; nothing to rebuild", served.get("release"))
            return None
        same_code = served is not None and served.get("normalise_code") == prints["normalise_code"]
        reuse = tuple(k for k, fp in prints["inputs"].items()
                      if same_code and served.get("inputs", {}).get(k) == fp)
        now = _now()
        release = new_release(now)
        try:
            rebuild(release, reuse, current / "parquet" / "detections")
            keep_extra_files(current, release)
            con = duckdb.connect()
            new, old = summary(con, release), summary(con, current)
            check(new, old, release)
        except BaseException:
            shutil.rmtree(release, ignore_errors=True)
            raise
        version = {
            "release": release.name,
            "updated": now.isoformat(timespec="seconds"),
            "record_end": new["record_end"].isoformat(),
            "detections": new["detections"],
            "fetched": download.load_status().get("fetched", {}),
            "download": {k: stats[k] for k in ("downloaded", "failed") if k in stats},
            "reused": list(reuse),
            **prints,
        }
        publish(release, version)
    added = new["detections"] - (old["detections"] if old else 0)
    log.info("published release %s: record to %s, %d detections (%+d)", release.name, version["record_end"],
             new["detections"], added)
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
