"""Fire spread simulation on a synthetic record."""

from __future__ import annotations

import datetime as dt

from app import spread, spread_validation as sv, store

from .conftest import day_row, reference_params, write_dataset


def moving_fire(tmp_path):
    """A row of 30 land cells; in 2013 and 2014 a fire enters at the west end on the 1st of every
    month and moves one cell east per day for 10 days. Cell 25 never burns."""
    cells = [(2000 + i, 10, "Sumatra", "idn-riau", "idn-riau-a") for i in range(30)]
    days, celldays = [], []
    d = dt.date(2013, 1, 1)
    while d <= dt.date(2014, 12, 31):
        days.append(day_row(d))
        k = d.day - 1
        if k < 10:
            celldays.append(("viirs", "SNPP", d, 2000 + k, 10, 2, 0, 5.0, 3.0))
        d += dt.timedelta(days=1)
    root = write_dataset(tmp_path, celldays, days, cells)
    return store.connect(reference_params(), root)


def test_history_class():
    assert [spread.history_class(n) for n in (0, 1, 3, 7, 24, 1000)] == [0, 1, 2, 3, 4, 7]


def test_events_and_reach_shares_follow_the_moving_fire(tmp_path):
    con = moving_fire(tmp_path)
    evts = spread.year_events(con, 2013)
    assert len(evts) == 12 and evts[0]["first"] == (2000, 10)
    assert evts[0]["reached"] == {(2000 + k, 10): k for k in range(10)}
    m = spread.estimate(con, [2013, 2014])
    assert m.history[(2000, 10)] == 24 and m.history[(2025, 10)] == 0
    b = spread.history_class(24)
    for scenario in spread.SCENARIOS:
        reach = m.reach[scenario]
        for month in range(12):
            for d in range(1, 10):
                assert reach[month][b][d - 1][d] == 1.0 and reach[month][b][d - 1][d - 1] == 0.0
        assert all(v == 0 for row in reach[0][0] for v in row)
        assert m.sizes[scenario][0][5] == [6, 6]
    assert spread.is_large(evts[0]) and m.share_large == [1.0] * 12


def test_simulation_gives_chances_and_footprint(tmp_path):
    con = moving_fire(tmp_path)
    m = spread.estimate(con, [2013, 2014])
    ch = spread.chances(m, (2000, 10), dt.date(2015, 3, 1), 5)
    assert ch[(2000, 10)] == [1.0] * 5
    assert ch[(2003, 10)] == [0.0, 0.0, 1.0, 1.0, 1.0]
    assert ch[(2010, 10)] == [0.0] * 5
    out = spread.simulate(m, (2000, 10), dt.date(2015, 3, 1), 5)
    assert out["origin"]["land"] and out["footprint"][4]["expected_cells"] == 6
    assert out["footprint"][4]["past_fires_cells_p50"] == 6 and out["assumptions"]
    assert len(out["cells"]["chance"]) == 6 and all(0 <= p <= 1 for row in out["cells"]["chance"] for p in row)
    assert spread.chances(m, (1, 1), dt.date(2015, 3, 1), 3) == {}
    assert out["large_fire"]["share_of_past_fires"] == 1.0 and out["large_fire"]["footprint"][4]["expected_cells"] == 6


def test_observed_progression_and_event_origin(tmp_path):
    con = moving_fire(tmp_path)
    seen = spread.observed(con, (2000, 10), dt.date(2014, 6, 1), 4)
    assert seen == {(2000 + k, 10): k for k in range(5)}
    assert spread.observed(con, (2005, 10), dt.date(2014, 6, 1), 4) is None
    assert spread.observed(con, (2000, 10), dt.date(2014, 12, 30), 5) is None


def test_build_and_load_round_trip(tmp_path):
    con = moving_fire(tmp_path)
    path = tmp_path / "spread_model.json"
    built = spread.build(con, path)
    loaded = spread.load(con, path)
    assert loaded.reach == built.reach and loaded.history == built.history and loaded.years == [2013, 2014]


def test_hindcast_helpers():
    assert sv.auc([(0.9, True), (0.1, False), (0.5, True), (0.4, False)]) == 1.0
    assert sv.auc([(0.5, True), (0.5, False)]) == 0.5
    assert sv.auc([(0.5, False)]) is None
    a = {"first": (0, 0), "reached": {(0, 0): 0, (1, 0): 2}}
    b = {"first": (5, 5), "reached": {(5, 5): 0}}
    typical = sv.shape([a, b])
    assert typical[1].get((1, 0), 0) == 0 and typical[3][(1, 0)] == 0.5 and typical[3][(0, 0)] == 1.0
