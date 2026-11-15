"""Keeping the data current: unfinished days, repeated downloads, the staged update and the API reload."""

from __future__ import annotations

import datetime as dt
import errno
import json
import subprocess
import sys
import threading

import duckdb
import pytest
from fastapi.testclient import TestClient

from app import api, config, store
from app.harmonise import weights
from app.main import app
from app.pipeline import aggregate, celldays, download, normalise, update

from .conftest import RIAU, day_row, write_dataset

UTC = dt.timezone.utc


def stamp(day: dt.date, hour: int, minute: int = 0) -> str:
    return dt.datetime(day.year, day.month, day.day, hour, minute, tzinfo=UTC).isoformat()


# --- unfinished days -------------------------------------------------------------------------------


def test_a_day_is_complete_only_once_fetched_after_its_last_overpass():
    d = dt.date(2026, 11, 15)
    status = {"fetched": {"modis": stamp(d, 12, 59), "viirs-snpp": stamp(d, 13), "retired-stream": stamp(d, 20)}}
    through = download.complete_through(status)
    assert through == {"Terra": d - dt.timedelta(days=1), "Aqua": d - dt.timedelta(days=1), "SNPP": d}
    assert download.complete_through({}) == {}


def test_a_platform_does_not_observe_days_it_is_still_delivering():
    first = dt.date(2026, 11, 10)
    days = [first + dt.timedelta(days=i) for i in range(4)]
    seen = {p: set(days) for p in ("Aqua", "SNPP", "NOAA20", "NOAA21")}
    through = {"Aqua": days[3], "SNPP": days[1], "NOAA20": days[2], "NOAA21": days[1]}
    status = {r["local_date"]: r for r in celldays.day_status(seen, first, days[3], through)}
    assert [status[d]["viirs_ref"] for d in days] == ["SNPP", "SNPP", "NOAA20", None]
    assert status[days[3]]["aqua"] and status[days[3]]["record_platform"] is None
    # Without limits every day with detections counts, as before.
    assert celldays.day_status(seen, first, days[3])[-1]["viirs_ref"] == "SNPP"


def test_the_day_table_ends_on_the_last_complete_day(tmp_path):
    con = duckdb.connect()
    path = tmp_path / "detections.parquet"
    con.execute(f"""COPY (SELECT 'SNPP' AS platform, CAST(d AS DATE) AS local_date, CAST(d AS DATE) AS acq_date
                          FROM range(DATE '2026-11-10', DATE '2026-11-16', INTERVAL 1 DAY) r(d))
                    TO '{path}' (FORMAT parquet)""")
    last = lambda dest: con.execute(f"SELECT max(local_date) FROM read_parquet('{dest}')").fetchone()[0]  # noqa: E731
    celldays.build_days(con, str(path), tmp_path / "all.parquet")
    assert last(tmp_path / "all.parquet") == dt.date(2026, 11, 15)
    celldays.build_days(con, str(path), tmp_path / "cut.parquet", {"SNPP": dt.date(2026, 11, 14), "Aqua": dt.date(2026, 11, 13)})
    assert last(tmp_path / "cut.parquet") == dt.date(2026, 11, 14)


# --- repeated downloads ----------------------------------------------------------------------------


@pytest.fixture
def firms(tmp_path, monkeypatch):
    """A fake FIRMS: every product has data, requests are recorded, and sources named in `down`
    fail. Yields (requested sources, down, availability)."""
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setattr(config, "map_key", lambda: "KEY")
    monkeypatch.setattr(download.time, "sleep", lambda s: None)
    avail = {}
    for s in config.STREAMS.values():
        avail[s.api_sp] = (dt.date(2026, 11, 1), dt.date(2026, 11, 5))
        avail[s.api_nrt] = (dt.date(2026, 11, 6), dt.date(2026, 11, 12))
    monkeypatch.setattr(download, "availability", lambda key: dict(avail))
    requested, down = [], set()

    def get(url, timeout=180, tries=4):
        source = url.split("/KEY/")[1].split("/")[0]
        requested.append(source)
        if source in down:
            raise RuntimeError("HTTP 500")
        bright = "brightness" if source.startswith("MODIS") else "bright_ti4"
        return f"latitude,longitude,acq_date,acq_time,satellite,confidence,frp,daynight,{bright}\n".encode()

    monkeypatch.setattr(download, "_get", get)
    monkeypatch.setattr(config, "AREA_URL", "https://firms/{key}/{source}/{bbox}/{days}/{date}")
    return requested, down, avail


def test_standard_product_windows_wait_for_the_product_to_advance(firms):
    requested, _, avail = firms
    download.download_api(2025)
    assert {s for s in requested if s.endswith("_SP")} == {"MODIS_SP", "VIIRS_SNPP_SP", "VIIRS_NOAA20_SP", "VIIRS_NOAA21_SP"}
    requested.clear()
    download.download_api(2025)
    # Unsettled near-real-time windows are asked for again; the unchanged standard product is not.
    assert requested and not [s for s in requested if s.endswith("_SP")]
    avail["MODIS_SP"] = (dt.date(2026, 11, 1), dt.date(2026, 11, 6))
    requested.clear()
    download.download_api(2025)
    assert {s for s in requested if s.endswith("_SP")} == {"MODIS_SP"}


def test_a_product_that_stopped_delivering_is_not_fetched_again(firms):
    requested, _, avail = firms
    today = dt.datetime.now(UTC).date()
    for s in config.STREAMS.values():
        avail[s.api_nrt] = (today - dt.timedelta(days=20), today)
    avail["VIIRS_SNPP_NRT"] = (today - dt.timedelta(days=20), today - dt.timedelta(days=10))
    download.download_api(today.year - 1)
    requested.clear()
    download.download_api(today.year - 1)
    assert "MODIS_NRT" in requested and "VIIRS_SNPP_NRT" not in requested


def test_a_failed_stream_keeps_its_earlier_fetch_time_and_files(firms):
    _, down, _ = firms
    download.download_api(2025)
    before = download.load_status()["fetched"]
    kept = sorted((config.raw_dir() / "api" / "VIIRS_SNPP_NRT").glob("*.csv"))
    marks = [p.stat().st_mtime_ns for p in kept]
    down.add("VIIRS_SNPP_NRT")
    stats = download.download_api(2025)
    after = download.load_status()
    assert stats["failed"] > 0 and after["last_run"]["failed"] == stats["failed"]
    assert after["fetched"]["viirs-snpp"] == before["viirs-snpp"]
    assert after["fetched"]["modis"] >= before["modis"]
    assert [p.stat().st_mtime_ns for p in kept] == marks


def test_days_already_held_by_a_settled_file_are_not_fetched_again(firms):
    requested, _, avail = firms
    for s in config.STREAMS.values():
        avail[s.api_nrt] = (dt.date(2026, 11, 6), dt.date(2026, 11, 20))
    download.download_api(2025)
    folder = config.raw_dir() / "api" / "MODIS_NRT"
    assert sorted(p.name for p in folder.glob("*.csv")) == [
        "2026-11-06_1.csv", "2026-11-07_5.csv", "2026-11-12_5.csv", "2026-11-17_4.csv"]
    # FIRMS drops its two oldest near-real-time days, so the plan now starts with a window named
    # 2026-11-08_4. Its days are in the settled 2026-11-07_5 file, so only the unsettled last
    # window is asked for.
    for s in config.STREAMS.values():
        avail[s.api_nrt] = (dt.date(2026, 11, 8), dt.date(2026, 11, 20))
    requested.clear()
    download.download_api(2025)
    assert requested.count("MODIS_NRT") == 1
    assert not (folder / "2026-11-08_4.csv").exists()


def test_shorter_windows_are_removed_once_a_longer_one_replaces_them(tmp_path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    folder = config.raw_dir() / "api" / "MODIS_NRT"
    folder.mkdir(parents=True)
    for name in ("2026-11-10_1.csv", "2026-11-10_3.csv", "2026-11-05_5.csv"):
        (folder / name).write_text("x")
    settled = {"MODIS_NRT/2026-11-10_1.csv": False, "MODIS_NRT/2026-11-05_5.csv": True}
    assert download.prune_superseded(settled) == 1
    assert sorted(p.name for p in folder.iterdir()) == ["2026-11-05_5.csv", "2026-11-10_3.csv"]
    assert settled == {"MODIS_NRT/2026-11-05_5.csv": True}


# --- the staged update ----------------------------------------------------------------------------


def write_tables(root, days: int, detections: int, extra: bytes | None = None) -> None:
    """Minimal processed tables under `root`: `detections` rows and a record of `days` days."""
    (root / "parquet" / "detections").mkdir(parents=True, exist_ok=True)
    (root / "derived").mkdir(parents=True, exist_ok=True)
    con = duckdb.connect()
    con.execute(f"COPY (SELECT i FROM range({detections}) r(i)) TO '{root}/parquet/detections/modis_2026.parquet' (FORMAT parquet)")
    con.execute(f"""COPY (SELECT CAST(DATE '2026-11-01' + CAST(i AS INTEGER) AS DATE) AS local_date, 'SNPP' AS record_platform
                          FROM range({days}) r(i)) TO '{root}/derived/days.parquet' (FORMAT parquet)""")
    for name in ("celldays", "cells", "region_daily", "events"):
        (root / "derived" / f"{name}.parquet").write_bytes(extra or f"{name} {days}".encode())


@pytest.fixture
def served(tmp_path, monkeypatch):
    """A data folder with hand-built tables being served (10 days, 1000 detections), one raw file
    and no downloads."""
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setattr(download, "run", lambda: {"downloaded": 3, "failed": 0})
    write_tables(tmp_path, days=10, detections=1000)
    (tmp_path / "derived" / "context_layer.parquet").write_bytes(b"kept")
    raw = tmp_path / "raw" / "api" / "MODIS_NRT"
    raw.mkdir(parents=True)
    (raw / "2026-11-10_5.csv").write_text("a")
    return tmp_path


def grow(days: int, detections: int):
    """A fake rebuild writing tables of the given size and recording what it was asked to reuse."""
    calls = []

    def rebuild(release, reuse=(), reuse_from=None):
        calls.append(reuse)
        write_tables(release, days=days, detections=detections)

    return rebuild, calls


def test_update_publishes_a_good_rebuild_as_a_new_release(served, monkeypatch):
    rebuild, _ = grow(11, 1040)
    monkeypatch.setattr(update, "rebuild", rebuild)
    version = update.run_once()
    release = config.releases_dir() / version["release"]
    assert version["record_end"] == "2026-11-11" and version["detections"] == 1040
    assert update.load_version() == version and config.release_root() == release
    assert (config.derived_dir() / "celldays.parquet").read_bytes() == b"celldays 11"
    assert (config.derived_dir() / "context_layer.parquet").read_bytes() == b"kept"
    # The hand-built tables stay until the next release, so a running service can switch first.
    assert (served / "derived").is_dir()
    (served / "raw" / "api" / "MODIS_NRT" / "2026-11-10_5.csv").write_text("new")
    update.run_once()
    assert not (served / "derived").exists() and not (served / "parquet").exists()
    assert (served / "raw" / "api" / "MODIS_NRT" / "2026-11-10_5.csv").is_file()


def test_a_round_without_new_data_rebuilds_and_announces_nothing(served, monkeypatch):
    rebuild, calls = grow(11, 1040)
    monkeypatch.setattr(update, "rebuild", rebuild)
    first = update.run_once()
    marker = config.pointer_path().stat().st_mtime_ns
    assert update.run_once() is None
    assert len(calls) == 1 and config.pointer_path().stat().st_mtime_ns == marker
    # A changed raw file, or a newly completed day, makes the next round rebuild.
    (served / "raw" / "api" / "MODIS_NRT" / "2026-11-10_5.csv").write_text("ab")
    second = update.run_once()
    assert second["release"] != first["release"] and len(calls) == 2
    status = {"fetched": {k: stamp(dt.date(2026, 11, 20), 14) for k in config.STREAMS}}
    download.status_path().parent.mkdir(parents=True, exist_ok=True)
    download.status_path().write_text(json.dumps(status))
    assert update.run_once() is not None and len(calls) == 3


def test_products_with_unchanged_raw_files_are_reused(served, monkeypatch):
    rebuild, calls = grow(11, 1040)
    monkeypatch.setattr(update, "rebuild", rebuild)
    update.run_once()
    assert calls[-1] == ()
    (served / "raw" / "api" / "MODIS_NRT" / "2026-11-10_5.csv").write_text("changed")
    update.run_once()
    assert "modis" not in calls[-1] and set(calls[-1]) == set(config.STREAMS) - {"modis"}


def test_normalise_copies_reused_products_instead_of_reading_their_raw_files(tmp_path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setattr(normalise, "_load_clip", lambda con: None)
    monkeypatch.setattr(normalise, "build_static_mask", lambda con, glob=None: 0)
    old = tmp_path / "old"
    old.mkdir()
    duckdb.connect().execute(f"COPY (SELECT 1 AS x UNION ALL SELECT 2) TO '{old}/viirs-snpp_2026.parquet' (FORMAT parquet)")
    seen = []
    monkeypatch.setattr(normalise, "normalise_stream", lambda con, stream, out: seen.append(stream.key) or 0)
    with config.staged(tmp_path / "release"):
        normalise.run(reuse=("viirs-snpp",), reuse_from=old)
        assert sorted(p.name for p in normalise.detections_dir().iterdir()) == ["viirs-snpp_2026.parquet"]
    assert "viirs-snpp" not in seen and set(seen) == set(config.STREAMS) - {"viirs-snpp"}


@pytest.mark.parametrize("days,detections,reason", [(11, 900, "detections"), (7, 1040, "ends on")])
def test_update_keeps_the_served_data_when_the_rebuild_fails_its_checks(served, monkeypatch, days, detections, reason):
    monkeypatch.setattr(update, "rebuild", grow(days, detections)[0])
    with pytest.raises(update.UpdateRejected, match=reason):
        update.run_once()
    assert (served / "derived" / "celldays.parquet").read_bytes() == b"celldays 10"
    assert update.load_version() is None and not any(config.releases_dir().glob("*"))


def test_update_keeps_the_served_data_when_a_stage_or_the_download_fails(served, monkeypatch):
    def broken(release, reuse=(), reuse_from=None):
        write_tables(release, days=11, detections=1040)
        raise ValueError("rows failing validation")

    monkeypatch.setattr(update, "rebuild", broken)
    with pytest.raises(ValueError):
        update.run_once()
    monkeypatch.setattr(download, "run", lambda: (_ for _ in ()).throw(RuntimeError("FIRMS is down")))
    with pytest.raises(RuntimeError, match="FIRMS is down"):
        update.run_once()
    assert (served / "derived" / "events.parquet").read_bytes() == b"events 10"
    assert update.load_version() is None and not any(config.releases_dir().glob("*"))


def test_only_the_current_and_previous_release_are_kept(served, monkeypatch):
    names = []
    for i in range(4):
        rebuild, _ = grow(11 + i, 1040 + i)
        monkeypatch.setattr(update, "rebuild", rebuild)
        (served / "raw" / "api" / "MODIS_NRT" / "2026-11-10_5.csv").write_text("x" * (i + 2))
        names.append(update.run_once()["release"])
    assert len(set(names)) == 4
    assert sorted(p.name for p in config.releases_dir().iterdir()) == sorted(names[-2:])
    assert config.release_root().name == names[-1]


def test_a_running_update_blocks_a_second_one_until_it_ends(served):
    with update.Lock():
        with pytest.raises(RuntimeError, match="another update"):
            update.run_once()
    with update.Lock():
        pass


def test_the_lock_is_released_when_its_process_dies_however_old_it_is(served):
    # A process that takes the lock and is then killed: the next update starts without waiting for
    # any timeout, and a lock held by a live process is never taken over, however old.
    code = ("import os, sys, time; sys.path.insert(0, '.'); os.environ['DATA_DIR'] = sys.argv[1]; "
            "from app.pipeline import update; lock = update.Lock().__enter__(); print('locked', flush=True); time.sleep(60)")
    holder = subprocess.Popen([sys.executable, "-c", code, str(served)], stdout=subprocess.PIPE, text=True)
    try:
        assert holder.stdout.readline().strip() == "locked"
        old = dt.datetime(2026, 1, 1).timestamp()
        import os
        os.utime(served / ".update.lock", (old, old))
        with pytest.raises(RuntimeError, match="another update"):
            update.Lock().__enter__()
    finally:
        holder.kill()
        holder.wait()
    with update.Lock():
        pass


def test_the_lock_can_live_elsewhere_and_is_skipped_where_files_cannot_be_locked(served, monkeypatch, tmp_path, caplog):
    monkeypatch.setenv("UPDATE_LOCK_DIR", str(tmp_path / "local"))
    with update.Lock() as lock:
        assert lock.path == tmp_path / "local" / ".update.lock"
        with pytest.raises(RuntimeError, match="another update"):
            update.Lock().__enter__()

    def unsupported(fd):
        raise OSError(errno.ENOTSUP, "Operation not supported")

    monkeypatch.setattr(update, "_lock_file", unsupported)
    with update.Lock():
        assert "relying on the scheduler" in caplog.text


def test_rebuild_runs_the_usual_stages_into_the_release_folder(tmp_path, monkeypatch):
    from app import cli
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    seen = []
    monkeypatch.setattr(normalise, "run", lambda reuse=(), reuse_from=None: seen.append(("normalise", config.derived_dir(), reuse)))
    monkeypatch.setattr(cli, "main", lambda argv: seen.append((argv[0], config.derived_dir(), None)))
    release = tmp_path / "releases" / "r1"
    update.rebuild(release, ("modis",), tmp_path / "old")
    assert [s[0] for s in seen] == ["normalise", "build", "cache"] and seen[0][2] == ("modis",)
    assert {s[1] for s in seen} == {release / "derived"}
    assert config.derived_dir() == tmp_path / "derived"


# --- the API picks the new tables up ---------------------------------------------------------------


def synthetic_tables(root, last: dt.date) -> None:
    """Derived tables under `root` with one S-NPP cell-day in Riau per day from 1 November 2026, and
    a fire outlook issued on the last day."""
    days = [dt.date(2026, 11, 1) + dt.timedelta(days=i) for i in range((last - dt.date(2026, 11, 1)).days + 1)]
    rows = [("viirs", "SNPP", d, RIAU[0], RIAU[1], 6, 0, 9.0, 4.0) for d in days]
    write_dataset(root, rows, [day_row(d) for d in days], [RIAU])
    aggregate.build(store.connect(weights.load_params(), root), store.table_path("region_daily", root))
    duckdb.connect().execute(f"COPY (SELECT 'day' AS step, 1 AS lead, {RIAU[0]} AS cx, {RIAU[1]} AS cy, 0.5 AS chance) "
                             f"TO '{root}/outlook.parquet' (FORMAT parquet)")
    labels = {step: {str(k): "seasonal" for k in range(1, 31)} for step in ("day", "month", "year")}
    (root / "outlook.json").write_text(json.dumps({"years": [2013, 2025], "labels": labels, "issued": {
        "day": str(last), "month": "2026-10", "year": 2026}}))


def release(last: dt.date, name: str) -> None:
    """Writes release `name` with data to `last` and points `current.json` at it."""
    synthetic_tables(config.releases_dir() / name / "derived", last)
    update.publish(config.releases_dir() / name, {"release": name, "updated": f"{last}T13:05:00+00:00",
                                                    "fetched": {"modis": "x"}})


@pytest.fixture
def live(tmp_path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setattr(api, "RELOAD_CHECK_SECONDS", 0)
    release(dt.date(2026, 11, 14), "r1")
    api.configure(None, None)
    yield TestClient(app)
    api.configure(None, None)


def positive_days(client) -> int:
    return sum(v is not None and v > 0 for v in client.get("/api/series").json()["values"])


def test_the_api_serves_a_new_release_as_soon_as_it_is_published(live):
    before = live.get("/api/meta").json()
    assert before["record"]["end"] == "2026-11-14" and before["data"]["updated"] == "2026-11-14T13:05:00+00:00"
    assert live.get("/api/outlook").json()["issued"] == "2026-11-14"
    n_before = positive_days(live)
    release(dt.date(2026, 11, 15), "r2")
    after = live.get("/api/meta").json()
    assert after["record"]["end"] == "2026-11-15" and after["data"] == {"updated": "2026-11-15T13:05:00+00:00",
                                                                          "fetched": {"modis": "x"}}
    assert positive_days(live) == n_before + 1
    assert live.get("/api/outlook").json()["issued"] == "2026-11-15"


def test_a_request_keeps_its_own_release_while_a_new_one_is_opened(live):
    old = api._current()
    old_outlook = api._outlook_meta_for(old)["issued"]["day"]
    release(dt.date(2026, 11, 15), "r2")
    new = api._current()
    assert new is not old
    # The old opening still answers, from its own release, and its late answers are stored under
    # its own key, never served for the new one.
    old_flags = api._flags_for(old)
    assert old_flags[-1][0] == dt.date(2026, 11, 14) and old_outlook == "2026-11-14"
    assert api._flags_for(new)[-1][0] == dt.date(2026, 11, 15)
    token = api._pinned.set(new)
    try:
        assert api._flags()[-1][0] == dt.date(2026, 11, 15)
        assert api._outlook_meta()["issued"]["day"] == "2026-11-15"
    finally:
        api._pinned.reset(token)


def test_requests_during_a_reload_never_fail(live):
    errors, stop = [], threading.Event()

    def hammer():
        while not stop.is_set():
            for url in ("/api/series", "/api/meta", "/api/agreement", "/api/outlook"):
                r = live.get(url)
                if r.status_code != 200:
                    errors.append((url, r.status_code, r.text[:200]))

    workers = [threading.Thread(target=hammer) for _ in range(6)]
    for w in workers:
        w.start()
    try:
        for i in range(6):
            release(dt.date(2026, 11, 15 + i % 2), f"r{i + 2}")
    finally:
        stop.set()
        for w in workers:
            w.join()
    assert errors == []
