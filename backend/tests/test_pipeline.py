"""Cell lookup, fire events, polygon selection and the region cache."""

from __future__ import annotations

import datetime as dt

import pytest

from app import geo, queries, store
from app.pipeline import aggregate, events
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
                     ("viirs", "SNPP", d, BALI[0], BALI[1], 2, 2, 1.0, 1.0)]
    root = write_dataset(tmp_path, celldays, [day_row(d) for d in days], [RIAU, BALI])
    con = store.connect(reference_params(), root)
    aggregate.build(con, store.table_path("region_daily", root))
    return store.connect(reference_params(), root)


@pytest.mark.parametrize("daynight", ["all", "day", "night"])
@pytest.mark.parametrize("ids", [["idn-riau"], ["idn-riau-a", "idn-bali"], ["idn"]])
def test_region_cache_equals_general_path(tmp_path, daynight, ids):
    con = two_region_dataset(tmp_path)
    fast = queries.daily_cached(con, daynight, ids)
    general = queries.daily_general(con, daynight, queries.area_filter(ids))
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
