"""Keeping the data current: unfinished days, repeated downloads, the staged update and the API reload."""

from __future__ import annotations

import datetime as dt
import json

import duckdb
import pytest
from fastapi.testclient import TestClient

from app import api, config, store
from app.harmonise import weights
from app.main import app
from app.pipeline import aggregate, celldays, download, update

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


# --- the staged update -----------------------------------------------------------------------------


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
    """A data folder with tables being served (10 days, 1000 detections) and no downloads."""
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setattr(download, "run", lambda: {"downloaded": 3, "failed": 0})
    write_tables(tmp_path, days=10, detections=1000)
    (tmp_path / "derived" / "outlook.parquet").write_bytes(b"kept")
    return tmp_path


def test_update_swaps_in_a_good_rebuild_and_marks_the_version(served, monkeypatch):
    monkeypatch.setattr(update, "rebuild", lambda stage: write_tables(stage, days=11, detections=1040))
    version = update.run_once()
    assert version["record_end"] == "2026-11-11" and version["detections"] == 1040
    assert update.load_version() == version
    assert (served / "derived" / "celldays.parquet").read_bytes() == b"celldays 11"
    assert (served / "derived" / "outlook.parquet").read_bytes() == b"kept"
    assert not update.staging_dir().exists() and not (served / ".update.lock").exists()
    assert not (served / "parquet" / "detections.old").exists()


@pytest.mark.parametrize("days,detections,reason", [(11, 900, "detections"), (7, 1040, "ends on")])
def test_update_keeps_the_served_data_when_the_rebuild_fails_its_checks(served, monkeypatch, days, detections, reason):
    monkeypatch.setattr(update, "rebuild", lambda stage: write_tables(stage, days=days, detections=detections))
    with pytest.raises(update.UpdateRejected, match=reason):
        update.run_once()
    assert (served / "derived" / "celldays.parquet").read_bytes() == b"celldays 10"
    assert update.load_version() is None and not update.staging_dir().exists()


def test_update_keeps_the_served_data_when_a_stage_or_the_download_fails(served, monkeypatch):
    def broken(stage):
        write_tables(stage, days=11, detections=1040)
        (stage / "derived" / "events.parquet").unlink()
        raise ValueError("rows failing validation")

    monkeypatch.setattr(update, "rebuild", broken)
    with pytest.raises(ValueError):
        update.run_once()
    monkeypatch.setattr(download, "run", lambda: (_ for _ in ()).throw(RuntimeError("FIRMS is down")))
    with pytest.raises(RuntimeError, match="FIRMS is down"):
        update.run_once()
    assert (served / "derived" / "events.parquet").read_bytes() == b"events 10"
    assert update.load_version() is None
    assert not update.staging_dir().exists() and not (served / ".update.lock").exists()


def test_a_running_update_blocks_a_second_one(served):
    with update.Lock():
        with pytest.raises(RuntimeError, match="another update"):
            update.run_once()


def test_rebuild_runs_the_usual_stages_into_the_staging_folder(tmp_path, monkeypatch):
    from app import cli
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    seen = []
    monkeypatch.setattr(cli, "main", lambda argv: seen.append((argv[0], config.derived_dir(), config.parquet_dir())))
    update.rebuild(tmp_path / ".staging")
    assert [s[0] for s in seen] == ["normalise", "build", "cache"]
    assert {s[1] for s in seen} == {tmp_path / ".staging" / "derived"} and {s[2] for s in seen} == {tmp_path / ".staging" / "parquet"}
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


def test_the_api_reloads_when_an_update_replaces_the_tables(tmp_path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setattr(api, "RELOAD_CHECK_SECONDS", 0)
    synthetic_tables(config.derived_dir(), dt.date(2026, 11, 14))
    api.configure(None, None)
    try:
        client = TestClient(app)
        before = client.get("/api/meta").json()
        assert before["record"]["end"] == "2026-11-14" and before["data"] is None
        n_before = sum(v is not None and v > 0 for v in client.get("/api/series").json()["values"])
        assert client.get("/api/outlook").json()["issued"] == "2026-11-14"

        synthetic_tables(config.derived_dir(), dt.date(2026, 11, 15))
        update.version_path().write_text(json.dumps({"updated": "2026-11-16T13:05:00+00:00", "fetched": {"modis": "x"}}))
        after = client.get("/api/meta").json()
        assert after["record"]["end"] == "2026-11-15"
        assert after["data"] == {"updated": "2026-11-16T13:05:00+00:00", "fetched": {"modis": "x"}}
        assert sum(v is not None and v > 0 for v in client.get("/api/series").json()["values"]) == n_before + 1
        assert client.get("/api/outlook").json()["issued"] == "2026-11-15"
    finally:
        api.configure(None, None)
