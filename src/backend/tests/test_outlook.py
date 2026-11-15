"""Fire outlook per cell on a synthetic record."""

from __future__ import annotations

import datetime as dt

import pytest
from fastapi.testclient import TestClient

from app import api, outlook, outlook_validation as ov, store
from app.pipeline import aggregate
from app.main import app

from .conftest import day_row, reference_params, write_dataset

FIRE = (2000, 10)


def september_fires(tmp_path, monkeypatch):
    """Ten land cells in a row, observed every day from 2013 to 10 September 2016; the first cell
    burns every day of September, the others never."""
    cells = [(2000 + i, 10, "Sumatra", "idn-riau", "idn-riau-a") for i in range(10)]
    days, celldays = [], []
    d = dt.date(2013, 1, 1)
    while d <= dt.date(2016, 9, 10):
        days.append(day_row(d))
        if d.month == 9:
            celldays.append(("viirs", "SNPP", d, *FIRE, 2, 0, 5.0, 3.0))
        d += dt.timedelta(days=1)
    root = write_dataset(tmp_path, celldays, days, cells)
    monkeypatch.setattr(outlook, "path", lambda: root / "outlook.parquet")
    monkeypatch.setattr(outlook, "meta_path", lambda: root / "outlook.json")
    return root, store.connect(reference_params(), root)


def test_tables_learn_the_september_fire(tmp_path, monkeypatch):
    _, con = september_fires(tmp_path, monkeypatch)
    outlook.prepare(con)
    years = outlook.complete_years(con)
    assert years == [2013, 2014, 2015]
    counts = outlook.day_table(con, years, [1, 30])
    assert all(t >= h >= 0 for t, h in counts.values())
    p = outlook.chances(counts, len(outlook.DAY_NORMAL_EDGES) + 1, outlook.DAY_COMBOS)
    assert len(p) == 2 * (len(outlook.DAY_NORMAL_EDGES) + 1) * len(outlook.DAY_COMBOS)
    top = len(outlook.DAY_NORMAL_EDGES)
    assert p[(1, top, 1, 3, 0)] > 0.5 and p[(1, 0, 0, 0, 0)] < 0.01
    months = outlook.chances(outlook.month_table(con, years, [1, 12]), len(outlook.MONTH_NORMAL_EDGES) + 1,
                             outlook.MONTH_COMBOS)
    assert all(0 <= v <= 1 for v in months.values())


def test_build_writes_every_step(tmp_path, monkeypatch):
    root, con = september_fires(tmp_path, monkeypatch)
    meta = outlook.build(con)
    assert meta["issued"] == {"day": "2016-09-10", "month": "2016-08", "year": 2016}
    con = store.connect(reference_params(), root)
    rows = con.execute(f"SELECT step, count(DISTINCT lead), max(chance) FROM read_parquet('{outlook.path()}') "
                       f"GROUP BY step ORDER BY step").fetchall()
    assert [r[0] for r in rows] == ["day", "month", "year"]
    # Only September holds fire: day leads 1-20 (11 to 30 September) and month lead 1 are stored.
    assert rows[0][1] == 20 and rows[1][1] == 1
    year = dict(con.execute(f"SELECT cx, chance FROM read_parquet('{outlook.path()}') "
                            f"WHERE step = 'year' AND lead = 1").fetchall())
    # Burned in all 3 complete years, drawn towards the mean share (3 of 30 cell-years) by one pseudo-year.
    assert year[FIRE[0]] == pytest.approx((3 + 0.1) / 4)
    sept = dict(con.execute(f"SELECT cx, chance FROM read_parquet('{outlook.path()}') "
                            f"WHERE step = 'month' AND lead = 1").fetchall())
    assert sept[FIRE[0]] > 0.5 and max((v for c, v in sept.items() if c != FIRE[0]), default=0) < 0.1


def test_targets_and_labels():
    issued = {"day": "2026-11-14", "month": "2026-10", "year": 2025}
    assert outlook.target("day", issued, 1) == "2026-11-15"
    assert outlook.target("month", issued, 3) == "2027-01"
    assert outlook.target("year", issued, 5) == "2030"
    assert [outlook.LABELS["day"][k] for k in (3, 4, 10, 11)] == ["forecast", "weak forecast", "weak forecast", "seasonal"]
    assert [outlook.LABELS["month"][k] for k in (1, 2, 3)] == ["forecast", "weak forecast", "seasonal"]
    assert set(outlook.LABELS["year"].values()) == {"baseline"}


def test_auc_from_histogram():
    assert ov.auc({0.9: [0, 2], 0.1: [2, 0]}) == 1.0
    assert ov.auc({0.5: [1, 1]}) == 0.5
    assert ov.auc({0.5: [3, 0]}) is None


def test_endpoints(tmp_path, monkeypatch):
    root, con = september_fires(tmp_path, monkeypatch)
    outlook.build(con)
    con = store.connect(reference_params(), root)
    aggregate.build(con, store.table_path("region_daily", root))
    api.configure(store.connect(reference_params(), root), reference_params())
    client = TestClient(app)
    timeline = client.get("/api/outlook?step=month").json()
    assert timeline["issued"] == "2016-08" and len(timeline["leads"]) == outlook.MONTH_LEADS
    assert timeline["leads"][0] == {"lead": 1, "target": "2016-09", "label": "forecast"}
    cells = client.get("/api/outlook/cells?step=month&lead=1&area=idn-riau").json()
    assert cells["target"] == "2016-09" and cells["count"] >= 1 and max(cells["cells"]["chance"]) > 0.5
    day = client.get("/api/outlook/cells?step=day&lead=3").json()
    assert day["target"] == "2016-09-13" and max(day["cells"]["chance"]) > 0.5
    # The expected count sums every cell of the area, also those left out of the map.
    few = client.get("/api/outlook/cells?step=month&lead=1&min_chance=1").json()
    every = client.get("/api/outlook/cells?step=month&lead=1&min_chance=0").json()
    assert few["count"] <= every["count"] and few["expected_cells"] == every["expected_cells"] == cells["expected_cells"]
    assert every["expected_cells"] == pytest.approx(sum(every["cells"]["chance"]), abs=0.01)
    assert client.get("/api/outlook/cells?step=year&lead=6").status_code == 400
    assert client.get("/api/outlook/cells?step=week").status_code == 422
    api.configure(None, None)
