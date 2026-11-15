"""Cell lookup, fire events, polygon selection and the region cache."""

from __future__ import annotations

import datetime as dt
from pathlib import PurePosixPath

import pytest

from app import config, geo, queries, store
from app.pipeline import aggregate, download, events, normalise
from app.pipeline.cells import CellLocator

from .conftest import BALI, RIAU, day_row, reference_params, write_dataset


def square(x0: float, y0: float, size: float) -> tuple[list[tuple[float, float]], ...]:
    return ([(x0, y0), (x0 + size, y0), (x0 + size, y0 + size), (x0, y0 + size), (x0, y0)],)


def test_cell_locator_nearest_province_and_other():
    boundaries = [
        geo.Boundary("idn", "Indonesia", "country", None, square(100, 0, 2)),
        geo.Boundary("idn-riau", "Riau", "province", "idn", square(100, 0, 2)),
        geo.Boundary("idn-riau-a", "Kampar", "regency", "idn-riau", square(100, 0, 2)),
    ]
    loc = CellLocator(boundaries)
    assert loc.locate(2010, 10) == ("Sumatra", "idn-riau", "idn-riau-a")         # inside
    assert loc.locate(2043, 10) == ("Sumatra", "idn-riau", "idn-riau-a")         # 0.175° outside
    assert loc.locate(2070, 10) == ("Other", None, None)                         # 1.5° outside


def test_events_link_neighbours_within_one_day():
    d = dt.date(2019, 9, 1)
    rows = [(d, 0, 0), (d, 1, 1), (d, 5, 5),
            (d + dt.timedelta(days=1), 2, 2),       # touches (1, 1) a day later: same event
            (d + dt.timedelta(days=3), 2, 2)]       # two days after the last: a new event
    assert events.label(sorted(rows)) == [0, 0, 1, 0, 2]


def two_region_dataset(tmp_path):
    days = [dt.date(2015, 9, 1) + dt.timedelta(days=i) for i in range(5)]
    celldays = []
    for i, d in enumerate(days):
        celldays += [("modis", "Aqua", d, RIAU[0], RIAU[1], 1, i % 2, 1.0, 1.0),
                     ("viirs", "SNPP", d, RIAU[0], RIAU[1], 3 + i, 1, 1.0, 1.0),
                     ("viirs", "SNPP", d, BALI[0], BALI[1], 2, 2, 1.0, 1.0, i % 2, 1)]
    root = write_dataset(tmp_path, celldays, [day_row(d) for d in days], [RIAU, BALI])
    con = store.connect(reference_params(), root)
    aggregate.build(con, store.table_path("region_daily", root))
    return store.connect(reference_params(), root)


@pytest.mark.parametrize("hotspots", ["vegetation", "all"])
@pytest.mark.parametrize("daynight", ["all", "day", "night"])
@pytest.mark.parametrize("ids", [["idn-riau"], ["idn-riau-a", "idn-bali"], ["idn"]])
def test_region_cache_equals_general_path(tmp_path, daynight, ids, hotspots):
    con = two_region_dataset(tmp_path)
    fast = queries.daily_cached(con, daynight, ids, hotspots)
    general = queries.daily_general(con, daynight, queries.area_filter(ids), hotspots)
    assert fast.keys() == general.keys()
    for d in fast:
        assert fast[d] == pytest.approx(general[d], abs=1e-9)


def test_polygon_selects_cells_by_centre(tmp_path):
    con = two_region_dataset(tmp_path)
    ring = [(100.9, 0.4), (101.2, 0.4), (101.2, 0.7), (100.9, 0.7)]   # around the Riau cell centre
    assert queries.polygon_cells(con, ring, "sel") == 1
    general = queries.daily_general(con, "all", queries.area_filter(cells_table="sel"))
    cached = queries.daily_cached(con, "all", ["idn-riau"])
    assert general.keys() == cached.keys()
    for d in general:
        assert general[d] == pytest.approx(cached[d])


def split_regency_dataset(tmp_path):
    """Regency A with two cells and regency B with two cells, all burning on the same five days."""
    days = [dt.date(2019, 9, 1) + dt.timedelta(days=i) for i in range(5)]
    cells = [(2020, 10, "Sumatra", "idn-riau", "idn-riau-a"), (2021, 10, "Sumatra", "idn-riau", "idn-riau-a"),
             (2023, 10, "Sumatra", "idn-riau", "idn-riau-b"), (2024, 10, "Sumatra", "idn-riau", "idn-riau-b")]
    celldays = []
    for i, d in enumerate(days):
        for j, (cx, cy, *_) in enumerate(cells):
            celldays += [("modis", "Aqua", d, cx, cy, 1, i % 2, 1.0, 1.0),
                         ("viirs", "SNPP", d, cx, cy, 2 + i + j, j % 2, 1.0, 1.0)]
    root = write_dataset(tmp_path, celldays, [day_row(d) for d in days], cells)
    con = store.connect(reference_params(), root)
    aggregate.build(con, store.table_path("region_daily", root))
    return store.connect(reference_params(), root)


@pytest.mark.parametrize("daynight", ["all", "day", "night"])
def test_polygon_reuses_cache_only_for_whole_regencies(tmp_path, monkeypatch, daynight):
    con = split_regency_dataset(tmp_path)
    # Covers both cells of regency A and the first cell of regency B (centres at x = 101.025 ... 101.175).
    ring = [(100.9, 0.4), (101.19, 0.4), (101.19, 0.6), (100.9, 0.6)]
    n = queries.polygon_cells(con, ring, "sel")
    assert n == 3
    assert queries.contained_regencies(con, "sel") == (["idn-riau-a"], 2)
    monkeypatch.setattr(queries, "REUSE_MIN_CELLS", 0)
    reused = queries.daily_polygon(con, daynight, "sel", n)
    direct = queries.daily_general(con, daynight, queries.area_filter(cells_table="sel"))
    assert reused.keys() == direct.keys()
    for d in direct:
        assert reused[d] == pytest.approx(direct[d], abs=1e-9)


def test_event_ties_resolve_to_earliest_day_and_first_area(tmp_path):
    d1, d2 = dt.date(2019, 9, 1), dt.date(2019, 9, 2)
    cells = [(2020, 10, "Sumatra", "idn-riau", "idn-riau-b"), (2021, 10, "Sumatra", "idn-riau", "idn-riau-a")]
    celldays = [("viirs", "SNPP", d, cx, cy, 4, 0, 1.0, 1.0) for d in (d2, d1) for cx, cy, *_ in cells]
    root = write_dataset(tmp_path, celldays, [day_row(d1), day_row(d2)], cells)
    con = store.connect(reference_params(), root)
    dest = store.table_path("events", root)
    for _ in range(3):
        assert events.build(con, dest) == {"vegetation": 1, "all": 1}
        rows = con.execute(f"SELECT hotspots, peak_day, regency_id FROM read_parquet('{dest}') ORDER BY 1").fetchall()
        assert rows == [("all", d1, "idn-riau-a"), ("vegetation", d1, "idn-riau-a")]


def test_normalise_ids_drops_areas_under_a_selected_parent():
    parents = {"idn": None, "idn-riau": "idn", "idn-riau-a": "idn-riau", "idn-bali-a": "idn-bali"}
    assert queries.normalise_ids(["idn-riau-a", "idn-riau", "idn-bali-a"], parents) == ["idn-bali-a", "idn-riau"]
    assert queries.normalise_ids(["idn-riau", "idn"], parents) == ["idn"]


def test_nrt_windows_keep_their_names_as_the_standard_product_advances():
    stream = config.STREAMS["modis"]
    nrt = (dt.date(2025, 11, 1), dt.date(2026, 11, 14))

    def names(sp_last):
        avail = {stream.api_sp: (dt.date(2000, 11, 1), sp_last), stream.api_nrt: nrt}
        return {w.rel for w in download.plan_api(avail, 2025) if w.source == stream.api_nrt}

    before, after = names(dt.date(2026, 8, 31)), names(dt.date(2026, 9, 30))
    assert after < before
    assert min(after).startswith(f"{stream.api_nrt}/2026-09-2")


def test_nrt_windows_start_no_earlier_than_the_product():
    stream = config.STREAMS["modis"]
    avail = {stream.api_nrt: (dt.date(2026, 3, 3), dt.date(2026, 3, 20))}
    nrt = [w for w in download.plan_api(avail, 2025) if w.source == stream.api_nrt]
    assert nrt[0].start == dt.date(2026, 3, 3) and nrt[0].end == dt.date(2026, 3, 6)
    assert nrt[-1].end == dt.date(2026, 3, 20)


def test_failed_normalise_leaves_previous_detections(tmp_path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    old = normalise.detections_dir() / "modis_2015.parquet"
    old.parent.mkdir(parents=True)
    old.write_bytes(b"previous")
    monkeypatch.setattr(normalise, "_load_clip", lambda con: None)

    def fail(con, stream, out):
        out.mkdir(parents=True, exist_ok=True)
        (out / "partial.parquet").write_bytes(b"partial")
        raise ValueError("rows failing validation")

    monkeypatch.setattr(normalise, "normalise_stream", fail)
    with pytest.raises(ValueError):
        normalise.run()
    assert [p.name for p in old.parent.iterdir()] == ["modis_2015.parquet"]
    assert old.read_bytes() == b"previous"
    assert not old.parent.with_name("detections.new").exists()


def test_repo_dir_in_a_checkout_and_in_the_docker_image():
    assert config.repo_dir(PurePosixPath("/home/me/spaceapps/src/backend")) == PurePosixPath("/home/me/spaceapps")
    assert config.repo_dir(PurePosixPath("/app")) == PurePosixPath("/")
