"""Download FIRMS active-fire data for Indonesia into `data/raw`.

Two sources:

- the country archive (one CSV per product and year, no key needed), which ends at the last
  complete year and has no NOAA-21;
- the keyed area API, for NOAA-21 and the current year. It takes a bounding box and at most five
  days per request. The standard product (`*_SP`, with the `type` attribute) is used wherever it
  is published, near-real-time (`*_NRT`) after that.

Re-running is safe: complete files are skipped, and API windows are fetched again until they are
settled (end at least `SETTLE_DAYS` before the product's latest date). A failed request leaves the
file it would have replaced in place.

`_status.json` records, per stream, when its windows were last all fetched. A local day counts as
finished for a stream only when that fetch happened late enough to have received the day's last
overpass (`complete_through`); until then the day is left out of the record, so a half-delivered
day never reads as a quiet one.
"""

from __future__ import annotations

import csv
import datetime as dt
import io
import json
import logging
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path

from .. import config

log = logging.getLogger("app.download")

SETTLE_DAYS = 3
WORKERS = 4
#: Hour (UTC) of a local date from which a fetch holds the whole day. The last overpass of the
#: record's satellites over Indonesia (Aqua's daytime pass in the west) is acquired by about 09:00
#: UTC of the local date, and FIRMS delivers near-real-time data within about three hours.
COMPLETE_HOUR_UTC = 13
USER_AGENT = "spaceapps-fire-calendar/0.1"


class Redactor:
    """Replaces registered secrets in any text that may reach a log or an exception."""

    def __init__(self) -> None:
        self.secrets: list[str] = []

    def add(self, secret: str) -> None:
        if secret:
            self.secrets.append(secret)

    def __call__(self, text: str) -> str:
        for s in self.secrets:
            text = text.replace(s, "***")
        return text


REDACT = Redactor()


def _get(url: str, timeout: float = 180, tries: int = 4) -> bytes:
    """GET with retries. Errors carry the redacted URL only."""
    last = ""
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read()
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                raise FileNotFoundError(REDACT(url)) from None
            last = f"HTTP {exc.code}"
        except (urllib.error.URLError, TimeoutError, ConnectionError) as exc:
            last = type(exc).__name__
        time.sleep(3 * (attempt + 1))
    raise RuntimeError(f"{REDACT(url)}: {last} after {tries} tries")


def _write_atomic(dest: Path, data: bytes) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    tmp.write_bytes(data)
    tmp.replace(dest)


def _check_csv(data: bytes, sensor: str) -> int:
    """Rejects anything that is not a FIRMS detection table; returns the row count."""
    text = data.decode("utf-8", errors="replace")
    header = text.split("\n", 1)[0].strip().split(",")
    needed = {"latitude", "longitude", "acq_date", "acq_time", "satellite", "confidence", "frp", "daynight"}
    needed.add("brightness" if sensor == "modis" else "bright_ti4")
    if not needed <= set(header):
        raise ValueError(f"unexpected payload: {text[:120]!r}")
    return max(0, text.count("\n") - 1)


def archive_path(stream: config.Stream, year: int) -> Path:
    return config.raw_dir() / "archive" / f"{stream.key}_{year}.csv"


def download_archive(last_year: int) -> dict[str, int]:
    """Fetches every country archive file up to `last_year` that is not cached yet."""
    jobs = [(s, y) for s in config.STREAMS.values() if s.archive_name
            for y in range(s.first_year, last_year + 1) if not archive_path(s, y).is_file()]
    log.info("archive: %d files to fetch", len(jobs))
    stats = {"downloaded": 0, "missing": 0, "failed": 0}

    def fetch(stream: config.Stream, year: int) -> str:
        url = config.ARCHIVE_URL.format(name=stream.archive_name, year=year)
        try:
            data = _get(url, timeout=600)
            rows = _check_csv(data, stream.sensor)
        except FileNotFoundError:
            return "missing"
        except (RuntimeError, ValueError) as exc:
            log.error("%s %d: %s", stream.key, year, exc)
            return "failed"
        _write_atomic(archive_path(stream, year), data)
        log.info("archive %-13s %d  %9d rows", stream.key, year, rows)
        return "downloaded"

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        for fut in as_completed([pool.submit(fetch, s, y) for s, y in jobs]):
            stats[fut.result()] += 1
    return stats


@dataclass(frozen=True)
class Window:
    """One area-API request: a product and up to five consecutive days."""

    stream: str
    sensor: str
    source: str
    start: dt.date
    days: int

    @property
    def end(self) -> dt.date:
        return self.start + dt.timedelta(days=self.days - 1)

    @property
    def rel(self) -> str:
        return f"{self.source}/{self.start.isoformat()}_{self.days}.csv"

    @property
    def path(self) -> Path:
        return config.raw_dir() / "api" / self.rel


def windows(stream: config.Stream, source: str, first: dt.date, last: dt.date) -> list[Window]:
    """Fixed windows anchored at `first`, so re-runs request the same files."""
    out, day = [], first
    while day <= last:
        n = min(config.API_MAX_DAYS, (last - day).days + 1)
        out.append(Window(stream.key, stream.sensor, source, day, n))
        day += dt.timedelta(days=n)
    return out


def availability(key: str) -> dict[str, tuple[dt.date, dt.date]]:
    """First and last date FIRMS holds for each API product."""
    text = _get(config.AVAILABILITY_URL.format(key=key)).decode("utf-8")
    rows = list(csv.DictReader(io.StringIO(text)))
    if not rows or "data_id" not in rows[0]:
        raise RuntimeError(f"data_availability returned no table: {REDACT(text[:120])!r}")
    return {r["data_id"]: (dt.date.fromisoformat(r["min_date"]), dt.date.fromisoformat(r["max_date"])) for r in rows}


def plan_api(avail: dict[str, tuple[dt.date, dt.date]], archive_last_year: int) -> list[Window]:
    """Windows for what the archive lacks: years after it, and all of NOAA-21.

    Near-real-time windows are anchored at the same fixed date as the stream's start, not at the
    end of the standard product, so they keep their names as the standard product advances; only
    windows reaching past the standard product are requested. Days that both cover are resolved
    by the source ranking in `normalise`."""
    todo: list[Window] = []
    for s in config.STREAMS.values():
        start = s.first_date if s.archive_name is None else dt.date(archive_last_year + 1, 1, 1)
        sp, nrt = avail.get(s.api_sp), avail.get(s.api_nrt)
        sp_last = start - dt.timedelta(days=1)
        if sp:
            sp_last = sp[1]
            todo += windows(s, s.api_sp, max(start, sp[0]), sp_last)
        if nrt:
            for w in windows(s, s.api_nrt, start, nrt[1]):
                if w.end <= sp_last or w.end < nrt[0]:
                    continue
                if w.start < nrt[0]:
                    w = Window(w.stream, w.sensor, w.source, nrt[0], (w.end - nrt[0]).days + 1)
                todo.append(w)
    return todo


def _state_path() -> Path:
    return config.raw_dir() / "api" / "_settled.json"


def status_path() -> Path:
    return config.raw_dir() / "api" / "_status.json"


def load_status() -> dict:
    """The download status: `fetched` (stream key -> UTC time its windows were last all fetched),
    `seen` (unsettled window -> its product's latest date when it was fetched) and the outcome of
    the last run. Empty before the first keyed download."""
    path = status_path()
    return json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {}


def complete_through(status: dict | None = None) -> dict[str, dt.date]:
    """Last local day each platform's data is complete for, from when its stream was last fetched.
    Platforms of streams without a recorded fetch are left out (no limit is known for them)."""
    status = load_status() if status is None else status
    out = {}
    for key, stamp in status.get("fetched", {}).items():
        stream = config.STREAMS.get(key)
        if stream is None:
            continue
        fetched = dt.datetime.fromisoformat(stamp).astimezone(dt.timezone.utc)
        day = (fetched - dt.timedelta(hours=COMPLETE_HOUR_UTC)).date()
        out.update({platform: day for platform in stream.platforms})
    return out


def _span(path: Path) -> tuple[dt.date, dt.date] | None:
    """First and last day of an API file named `<start>_<days>.csv`, or None for other files."""
    start, _, days = path.stem.partition("_")
    try:
        first = dt.date.fromisoformat(start)
        return first, first + dt.timedelta(days=int(days) - 1)
    except ValueError:
        return None


def _covered(w: Window, settled: dict[str, bool]) -> bool:
    """Whether a settled file already on disk holds every day of a window. FIRMS drops the oldest
    near-real-time day each day, which renames the first window of the plan; the days it asks for
    were fetched under their earlier name."""
    for path in w.path.parent.glob("*_*.csv") if w.path.parent.is_dir() else ():
        span = _span(path)
        if span and span[0] <= w.start and w.end <= span[1] and settled.get(f"{w.source}/{path.name}"):
            return True
    return False


def prune_superseded(settled: dict[str, bool]) -> int:
    """Deletes API files that a longer, newer window starting on the same day replaces (the last
    window of a product grows from one to five days as the days pass); returns how many were
    removed."""
    removed = 0
    root = config.raw_dir() / "api"
    for folder in (p for p in root.iterdir() if p.is_dir()) if root.is_dir() else ():
        longest: dict[str, int] = {}
        files = []
        for path in folder.glob("*_*.csv"):
            start, _, days = path.stem.partition("_")
            if days.isdigit():
                files.append((path, start, int(days)))
                longest[start] = max(longest.get(start, 0), int(days))
        newest = {start: (folder / f"{start}_{days}.csv").stat().st_mtime for start, days in longest.items()}
        for path, start, days in files:
            if days < longest[start] and path.stat().st_mtime <= newest[start]:
                path.unlink()
                settled.pop(f"{folder.name}/{path.name}", None)
                removed += 1
    return removed


def download_api(archive_last_year: int) -> dict[str, int]:
    """Fetches the area-API windows that are missing or not settled yet.

    A window is not fetched again while its product's latest date is the one it was last fetched
    under, when that product only changes by advancing: the standard product, and a near-real-time
    product whose latest date is more than `SETTLE_DAYS` old (a satellite that has stopped
    delivering). Windows of a live near-real-time product are fetched on every run until settled,
    since new overpasses keep arriving during a day."""
    key = config.map_key()
    REDACT.add(key)
    started = dt.datetime.now(dt.timezone.utc)
    avail = availability(key)
    settled: dict[str, bool] = json.loads(_state_path().read_text()) if _state_path().is_file() else {}
    status = load_status()
    seen: dict[str, str] = status.get("seen", {})
    sp_sources = {s.api_sp for s in config.STREAMS.values()}
    stopped = started.date() - dt.timedelta(days=SETTLE_DAYS)

    def due(w: Window) -> bool:
        if not w.path.is_file():
            return not _covered(w, settled)
        if settled.get(w.rel):
            return False
        latest = avail[w.source][1]
        closed = w.source in sp_sources or latest < stopped
        return not (closed and seen.get(w.rel) == latest.isoformat())

    plan = plan_api(avail, archive_last_year)
    todo = [w for w in plan if due(w)]
    log.info("api: %d windows planned, %d to fetch", len(plan), len(todo))
    bbox = ",".join(f"{v:g}" for v in config.INDONESIA_BBOX)
    stats = {"downloaded": 0, "failed": 0}
    failed_streams: set[str] = set()

    def fetch(w: Window) -> tuple[Window, int | None]:
        url = config.AREA_URL.format(key=key, source=w.source, bbox=bbox, days=w.days, date=w.start.isoformat())
        for _ in range(6):
            try:
                data = _get(url)
            except (RuntimeError, FileNotFoundError) as exc:
                log.error("%s: %s", w.path.name, REDACT(str(exc)))
                return w, None
            text = data[:200].decode("utf-8", errors="replace").lower()
            if "exceed" in text or "limit" in text:
                log.warning("transaction limit reached, waiting 90 s")
                time.sleep(90)
                continue
            try:
                rows = _check_csv(data, w.sensor)
            except ValueError as exc:
                log.error("%s %s: %s", w.source, w.start, REDACT(str(exc)))
                return w, None
            # An unchanged file is left as it is, so its modification time says it holds nothing new.
            if not (w.path.is_file() and w.path.read_bytes() == data):
                _write_atomic(w.path, data)
            return w, rows
        return w, None

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        for fut in as_completed([pool.submit(fetch, w) for w in todo]):
            w, rows = fut.result()
            if rows is None:
                stats["failed"] += 1
                failed_streams.add(w.stream)
                continue
            stats["downloaded"] += 1
            settled[w.rel] = w.end <= avail[w.source][1] - dt.timedelta(days=SETTLE_DAYS)
            seen[w.rel] = avail[w.source][1].isoformat()
            if stats["downloaded"] % 25 == 0:
                log.info("api: %d of %d windows", stats["downloaded"], len(todo))
    stats["pruned"] = prune_superseded(settled)
    _write_atomic(_state_path(), json.dumps(settled, indent=0).encode())
    # A stream counts as fetched at the start of this run only if none of its windows failed;
    # otherwise its earlier time stands and its newest days stay out of the record.
    fetched = status.get("fetched", {})
    fetched.update({key: started.isoformat(timespec="seconds") for key in config.STREAMS if key not in failed_streams})
    status = {"fetched": fetched, "seen": {rel: latest for rel, latest in seen.items() if settled.get(rel) is False},
              "last_run": {"at": started.isoformat(timespec="seconds"), **stats,
                           "latest": {source: last.isoformat() for source, (_, last) in sorted(avail.items())}}}
    _write_atomic(status_path(), json.dumps(status, indent=1).encode())
    return stats


def run(archive_last_year: int = config.FIT_END.year, api: bool = True) -> dict[str, int]:
    """Downloads the archive, then (with a key) the API windows; returns the API outcome."""
    log.info("archive done: %s", download_archive(archive_last_year))
    stats = download_api(archive_last_year) if api else {}
    if api:
        log.info("api done: %s", stats)
    return stats
