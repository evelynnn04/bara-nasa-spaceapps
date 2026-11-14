"""Parity between the fit and the query layer, and API smoke tests on a synthetic dataset."""

from __future__ import annotations

import datetime as dt

import pytest
from fastapi.testclient import TestClient

from app import api, config, queries, store
from app.harmonise import fit, weights
from app.harmonise.regions import GROUPS
from app.main import app
from app.pipeline import aggregate, events

from .conftest import BALI, RIAU, day_row, write_dataset


def synthetic(tmp_path):
    """Three months of Aqua and S-NPP cell-days in Riau and Bali, with one VIIRS outage day."""
    start = dt.date(2015, 8, 1)
    days, celldays = [], []
    for i in range(92):
        d = start + dt.timedelta(days=i)
        outage = d == dt.date(2015, 9, 15)
        days.append(day_row(d, snpp=not outage))
        for cell, base in ((RIAU, 3), (BALI, 1)):
            if i % 3 == 0:
                celldays.append(("modis", "Aqua", d, cell[0], cell[1], 1, i % 2, 20.0, 20.0))
            if not outage:
                celldays.append(("viirs", "SNPP", d, cell[0], cell[1], base + i % 5, i % 3, 9.0, 4.0))
    root = write_dataset(tmp_path, celldays, days, [RIAU, BALI])
    return root


def fitted(root):
    """Fits factors on the synthetic paired days and returns (model, params, table)."""
    con = store.connect(None, root)
    table = fit.stratum_table(con, dt.date(2015, 8, 1), dt.date(2015, 10, 31))
    model = fit.ipf(table, n0=0.0)
    params = {"k_table": [{"region": g, "month": m, "k": fit.k_of(model, g, m)} for g in GROUPS for m in range(1, 13)]}
    return model, params, table


def test_query_layer_reproduces_fit_series(tmp_path):
    root = synthetic(tmp_path)
    model, params, table = fitted(root)
    con = store.connect(params, root)
    aggregate.build(con, store.table_path("region_daily", root))
    con = store.connect(params, root)
    flags = queries.day_flags(con)
    expected = fit.series(table, model, [(2015, 8), (2015, 9), (2015, 10)])
    for daily in (queries.daily_cached(con, "all", ["idn"]), queries.daily_general(con, "all", "TRUE")):
        monthly = queries.monthly_paired(daily, flags, dt.date(2015, 8, 1), dt.date(2015, 10, 31))
        for y, m, a, b in expected:
            assert monthly[(y, m)][0] == pytest.approx(a, abs=1e-6)
            assert monthly[(y, m)][2] == pytest.approx(b, abs=1e-6)


real = pytest.mark.skipif(not all(store.table_path(n).is_file() for n in ("celldays", "days", "cells", "region_daily"))
                          or not config.params_path().is_file(), reason="real derived tables not built")


@real
def test_real_query_layer_reproduces_params_series():
    params = weights.load_params()
    con = store.connect(params)
    flags = queries.day_flags(con)
    monthly = queries.monthly_paired(queries.daily_cached(con, "all", ["idn"]), flags, config.FIT_START, config.FIT_END)
    assert len(params["series_national"]) == len(monthly)
    for y, m, a, b in params["series_national"]:
        assert monthly[(y, m)][0] == pytest.approx(a, abs=1e-6)
        assert monthly[(y, m)][2] == pytest.approx(b, abs=1e-6)


@pytest.fixture
def client(tmp_path):
    root = synthetic(tmp_path)
    _, params, _ = fitted(root)
    con = store.connect(params, root)
    aggregate.build(con, store.table_path("region_daily", root))
    events.build(con, store.table_path("events", root))
    con = store.connect({**params, "verdict": "insufficient data", "evaluation": {}}, root)
    con.execute("""CREATE TABLE detections AS SELECT * FROM (VALUES
        ('viirs', 'SNPP', TIMESTAMP '2015-08-31 18:00:00', DATE '2015-09-01', 'N', 101.03, 0.53, 4.0::FLOAT,
         'nominal', 0::TINYINT, '2', 'archive'),
        ('viirs', 'SNPP', TIMESTAMP '2015-09-01 06:00:00', DATE '2015-09-01', 'D', 115.17, -8.38, 2.0::FLOAT,
         'low', 2::TINYINT, '2', 'archive'))
        AS t(sensor, platform, acq_utc, local_date, daynight, lon, lat, frp, confidence, type, version, source)""")
    con.execute("CREATE TABLE static_mask (mx INTEGER, my INTEGER)")
    api.configure(con, {**params, "verdict": "insufficient data", "evaluation": {}})
    yield TestClient(app)
    api.configure(None, None)


def test_series_keeps_unobserved_days_null(client):
    body = client.get("/api/series").json()
    assert body["start"] == "2015-08-01" and body["end"] == "2015-10-31"
    values = body["values"]
    outage = (dt.date(2015, 9, 15) - dt.date(2015, 8, 1)).days
    assert values[outage] is None
    assert all(v is not None for i, v in enumerate(values) if i != outage)


def test_named_area_and_polygon_series_agree(client):
    named = client.get("/api/series?area=idn-riau").json()["values"]
    drawn = client.get("/api/series?poly=100.9,0.4;101.2,0.4;101.2,0.7;100.9,0.7").json()["values"]
    assert named == drawn
    both = client.get("/api/series?area=idn-riau,idn-riau-a,idn-bali").json()["values"]
    whole = client.get("/api/series").json()["values"]
    assert both == pytest.approx(whole)


def test_day_night_split_adds_up_for_viirs(client):
    full = client.get("/api/series?area=idn-riau").json()["values"]
    day = client.get("/api/series?area=idn-riau&daynight=day").json()["values"]
    assert sum(v or 0 for v in day) < sum(v or 0 for v in full)


def test_cells_agreement_events_and_csv(client):
    cells = client.get("/api/cells?from=2015-09-01&to=2015-09-30").json()
    assert cells["count"] == 2
    values = cells["cells"]["value"]
    hottest = values.index(max(values))
    assert cells["top"]["region_id"] == ("idn-riau-a" if cells["cells"]["lon"][hottest] > 100 and cells["cells"]["lat"][hottest] > 0
                                         else "idn-bali-a")
    assert cells["total"] == pytest.approx(sum(cells["cells"]["value"]), abs=1e-2)
    agreement = client.get("/api/agreement").json()
    assert [m["month"] for m in agreement["months"]] == [8, 9, 10]
    assert agreement["months"][1]["paired_days"] == 29
    assert agreement["harmonised"]["verdict"] == "insufficient data"
    found = client.get("/api/events?from=2015-08-01&to=2015-10-31&area=idn-bali").json()["events"]
    # The VIIRS outage on 15 Sep leaves a two-day gap, which splits the Bali fire in two.
    assert [(e["start"], e["end"]) for e in sorted(found, key=lambda e: e["start"])] == [
        ("2015-08-01", "2015-09-14"), ("2015-09-16", "2015-10-31")]
    assert {e["province_id"] for e in found} == {"idn-bali"}
    csv = client.get("/api/detections.csv?from=2015-09-01&to=2015-09-01&area=idn-riau")
    lines = csv.text.strip().splitlines()
    assert lines[0].startswith("acq_utc,") and len(lines) == 2 and csv.headers["x-total-rows"] == "1"
    assert lines[1].split(",")[12] == "true"


@pytest.mark.parametrize("url", ["/api/series?area=nope", "/api/series?poly=1,2;3,4",
                                 "/api/cells?from=2015-09-02&to=2015-09-01",
                                 "/api/detections.csv?from=2015-01-01&to=2016-06-01"])
def test_bad_requests_are_rejected(client, url):
    assert client.get(url).status_code == 400
