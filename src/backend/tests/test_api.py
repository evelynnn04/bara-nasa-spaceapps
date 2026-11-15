"""Parity between the fit and the query layer, and API smoke tests on a synthetic dataset."""

from __future__ import annotations

import datetime as dt

import pytest
from fastapi.testclient import TestClient

from app import api, config, geo, queries, store
from app.harmonise import fit, weights
from app.harmonise.regions import GROUPS
from app.main import app, create_app
from app.pipeline import aggregate, events

from .conftest import BALI, RIAU, day_row, write_dataset


def synthetic(tmp_path):
    """Three months of Aqua and S-NPP cell-days in Riau and Bali, with one VIIRS outage day. Every
    fourth day S-NPP also sees two non-vegetation hotspots in Bali by day."""
    start = dt.date(2015, 8, 1)
    days, celldays = [], []
    for i in range(92):
        d = start + dt.timedelta(days=i)
        outage = d == dt.date(2015, 9, 15)
        days.append(day_row(d, snpp=not outage))
        for cell, base in ((RIAU, 3), (BALI, 1)):
            if i % 3 == 0:
                celldays.append(("modis", "Aqua", d, cell[0], cell[1], 1 + i % 2, i % 2, 20.0, 20.0))
            if not outage:
                other = 2 if cell is BALI and i % 4 == 0 else 0
                celldays.append(("viirs", "SNPP", d, cell[0], cell[1], base + i % 5, i % 3, 9.0, 4.0, other, 0))
    root = write_dataset(tmp_path, celldays, days, [RIAU, BALI])
    return root


WINDOW = (dt.date(2015, 8, 1), dt.date(2015, 10, 31))
MONTHS = [(2015, 8), (2015, 9), (2015, 10)]


def fitted(root):
    """Fits unshrunk factors on the synthetic paired days for both type settings; returns
    ({setting: (models, table)}, params)."""
    con = store.connect(None, root)
    out, k_table = {}, []
    for h in weights.HOTSPOTS:
        table = fit.stratum_table(con, h, *WINDOW)
        models = {half: fit.ipf(table, half, n0=0.0) for half in fit.HALVES}
        frp = {half: fit.ipf(table, half, n0=0.0, a="FA", b="FB") for half in fit.HALVES}
        out[h] = (models, table)
        k_table += [{"hotspots": h, "region": g, "month": m, "k_day": fit.k_of(models["day"], g, m),
                     "k_night": fit.k_of(models["night"], g, m), "kf_day": fit.k_of(frp["day"], g, m),
                     "kf_night": fit.k_of(frp["night"], g, m)} for g in GROUPS for m in range(1, 13)]
    return out, {"k_table": k_table}


@pytest.mark.parametrize("hotspots", ["vegetation", "all"])
@pytest.mark.parametrize("daynight", ["all", "day", "night"])
def test_query_layer_reproduces_fit_series(tmp_path, hotspots, daynight):
    root = synthetic(tmp_path)
    fits, params = fitted(root)
    con = store.connect(params, root)
    aggregate.build(con, store.table_path("region_daily", root))
    con = store.connect(params, root)
    flags = queries.day_flags(con)
    models, table = fits[hotspots]
    expected = fit.series(table, models, MONTHS, daynight=daynight)
    for daily in (queries.daily_cached(con, daynight, ["idn"], hotspots),
                  queries.daily_general(con, daynight, "TRUE", hotspots)):
        monthly = queries.monthly_paired(daily, flags, *WINDOW)
        for y, m, a, b in expected:
            assert monthly[(y, m)][0] == pytest.approx(a, abs=1e-6)
            assert monthly[(y, m)][1] == pytest.approx(b, abs=1e-6)


real = pytest.mark.skipif(not all(store.table_path(n).is_file() for n in ("celldays", "days", "cells", "region_daily"))
                          or not config.params_path().is_file(), reason="real derived tables not built")


@real
@pytest.mark.parametrize("hotspots", ["vegetation", "all"])
def test_real_query_layer_reproduces_params_series(hotspots):
    params = weights.load_params()
    con = store.connect(params)
    flags = queries.day_flags(con)
    daily = queries.daily_cached(con, "all", ["idn"], hotspots)
    monthly = queries.monthly_paired(daily, flags, config.FIT_START, config.FIT_END)
    expected = params["settings"][hotspots]["series_national"]
    assert len(expected) == len(monthly)
    for y, m, a, b in expected:
        assert monthly[(y, m)][0] == pytest.approx(a, abs=1e-6)
        assert monthly[(y, m)][1] == pytest.approx(b, abs=1e-6)


@pytest.fixture
def client(tmp_path):
    root = synthetic(tmp_path)
    _, params = fitted(root)
    con = store.connect(params, root)
    aggregate.build(con, store.table_path("region_daily", root))
    events.build(con, store.table_path("events", root))
    con = store.connect(params, root)
    con.execute("""CREATE TABLE detections AS SELECT * FROM (VALUES
        ('viirs', 'SNPP', TIMESTAMP '2015-08-31 18:00:00', DATE '2015-09-01', 'N', 101.03, 0.53, 4.0::FLOAT,
         'nominal', 0::TINYINT, '2', 'archive'),
        ('viirs', 'SNPP', TIMESTAMP '2015-09-01 06:00:00', DATE '2015-09-01', 'D', 115.17, -8.38, 2.0::FLOAT,
         'low', 2::TINYINT, '2', 'archive'))
        AS t(sensor, platform, acq_utc, local_date, daynight, lon, lat, frp, confidence, type, version, source)""")
    con.execute("CREATE TABLE static_mask (mx INTEGER, my INTEGER)")
    api.configure(con, {**params, "verdict": "insufficient data", "settings": {}})
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
    assert lines[0].startswith("acq_utc,") and len(lines) == 2
    assert lines[1].split(",")[12] == "true"
    bali = client.get("/api/detections.csv?from=2015-09-01&to=2015-09-01&area=idn-bali").text.strip().splitlines()
    assert bali[1].split(",")[12] == "false"
    bali = client.get("/api/detections.csv?from=2015-09-01&to=2015-09-01&area=idn-bali&hotspots=all")
    assert bali.text.strip().splitlines()[1].split(",")[12] == "true"


def test_hotspot_type_setting_changes_every_view_consistently(client):
    veg, every = ({k: client.get(f"/api/{k}?area=idn-bali&from=2015-08-01&to=2015-10-31{q}").json()
                   for k in ("series", "cells", "agreement", "events")} for q in ("", "&hotspots=all"))
    # Each setting has its own factors, so harmonised values stay MODIS-equivalent under both: the
    # extra VIIRS hotspots raise the raw count and the factor, not the harmonised level.
    sv, sa = sum(v or 0 for v in veg["series"]["values"]), sum(v or 0 for v in every["series"]["values"])
    assert sa != pytest.approx(sv, abs=1e-3)
    assert veg["cells"]["total"] == pytest.approx(sv, abs=1e-2)
    assert every["cells"]["total"] == pytest.approx(sa, abs=1e-2)
    raw = [sum(m["viirs_px"] for m in x["agreement"]["months"]) for x in (veg, every)]
    assert raw[1] > raw[0]
    assert every["agreement"]["hotspots"] == "all" and every["events"]["hotspots"] == "all"
    assert [e["harmonised"] for e in every["events"]["events"]] != [e["harmonised"] for e in veg["events"]["events"]]


@pytest.mark.parametrize("hotspots", ["vegetation", "all"])
def test_drawn_area_sums_its_cells(client, hotspots):
    poly = "100.9,0.4;101.2,0.4;101.2,0.7;100.9,0.7"
    q = f"poly={poly}&from=2015-08-01&to=2015-10-31&hotspots={hotspots}"
    cells = client.get(f"/api/cells?{q}").json()
    series = client.get(f"/api/series?poly={poly}&hotspots={hotspots}").json()["values"]
    assert cells["count"] == 1
    assert cells["total"] == pytest.approx(sum(v or 0 for v in series), abs=1e-2)
    named = client.get(f"/api/series?area=idn-riau&hotspots={hotspots}").json()["values"]
    assert series == named


def test_tables_built_before_the_hotspot_unit_ask_for_a_rebuild(tmp_path):
    root = synthetic(tmp_path)
    _, params = fitted(root)
    con = store.connect(params, root)
    con.execute("CREATE TABLE region_daily (daynight VARCHAR, aqua_cd DOUBLE)")
    api.configure(con, params)
    try:
        res = TestClient(app).get("/api/series")
        assert res.status_code == 503 and "predate the hotspot unit" in res.json()["detail"]
    finally:
        api.configure(None, None)


def test_critical_periods_cover_every_month_and_week(client):
    body = client.get("/api/critical?area=idn-riau").json()
    assert [p["period"] for p in body["months"]["periods"]] == list(range(1, 13))
    assert [p["period"] for p in body["weeks"]["periods"]] == list(range(1, 54))
    # Three months of data hold no complete year, so nothing can be called critical.
    assert body["months"]["years"] == [] and not any(p["critical"] for p in body["months"]["periods"])
    assert body["method"]["ratio_min"] == 1.5
    assert client.get("/api/critical?area=idn-nope").status_code == 400


def test_area_ids_are_checked_against_known_areas(client):
    assert client.get("/api/series?area=idn-doesnotexist").status_code == 400
    # An outline in the boundary file with no cell in the dataset is a valid, empty area.
    empty = next(i for i, parent in geo.load_areas() if parent and parent != "idn")
    body = client.get(f"/api/series?area={empty}").json()
    assert all(v in (0, None) for v in body["values"])


def test_csv_reports_zero_rows_when_nothing_matches(client):
    res = client.get("/api/detections.csv?from=2015-09-02&to=2015-09-02&area=idn-riau")
    assert res.status_code == 200
    assert res.text.strip().splitlines() == [",".join(api.CSV_COLUMNS)]


def test_csv_accepts_periods_longer_than_a_year(client):
    res = client.get("/api/detections.csv?from=2014-01-01&to=2016-06-01&area=idn-riau")
    assert res.status_code == 200 and len(res.text.strip().splitlines()) > 1


@pytest.mark.parametrize("url", ["/api/series?area=nope", "/api/series?poly=1,2;3,4",
                                 "/api/series?poly=100,1;101,1;102,1",
                                 "/api/cells?from=2015-09-02&to=2015-09-01"])
def test_bad_requests_are_rejected(client, url):
    assert client.get(url).status_code == 400


def test_large_responses_are_compressed(client):
    small = client.get("/api/series", headers={"Accept-Encoding": "gzip"})
    assert len(small.content) < 1000 and "content-encoding" not in small.headers
    plain = client.get("/openapi.json", headers={"Accept-Encoding": "identity"})
    zipped = client.get("/openapi.json", headers={"Accept-Encoding": "gzip"})
    assert "content-encoding" not in plain.headers
    assert zipped.headers["content-encoding"] == "gzip"
    assert zipped.json() == plain.json()


@real
def test_real_polygons_reusing_the_cache_match_the_direct_path(monkeypatch):
    import random
    con = store.connect(weights.load_params())
    monkeypatch.setattr(queries, "REUSE_MIN_CELLS", 0)
    monkeypatch.setattr(queries, "REUSE_MIN_SHARE", 0.0)
    rng = random.Random(7)
    checked = 0
    for _ in range(12):
        x, y = rng.uniform(96, 138), rng.uniform(-10, 5)
        ring = [(x + rng.uniform(-4, 4), y + rng.uniform(-3, 3)) for _ in range(rng.choice((3, 5, 7)))]
        n = queries.polygon_cells(con, ring, "sel")
        if not n:
            continue
        for daynight in ("all", "night"):
            reused = queries.daily_polygon(con, daynight, "sel", n)
            direct = queries.daily_general(con, daynight, queries.area_filter(cells_table="sel"))
            assert reused.keys() == direct.keys()
            for d in direct:
                assert reused[d] == pytest.approx(direct[d], abs=1e-6)
        checked += 1
    assert checked >= 6


def test_map_layer_falls_back_to_blocks_above_the_cell_bound(client, monkeypatch):
    full = client.get("/api/cells?from=2015-09-01&to=2015-09-30").json()
    assert full["res_deg"] == pytest.approx(0.05) and full["count"] == 2
    monkeypatch.setattr(api, "MAX_MAP_CELLS", 1)
    coarse = client.get("/api/cells?from=2015-09-01&to=2015-09-30").json()
    assert coarse["res_deg"] == pytest.approx(0.25) and coarse["active_cells"] == 2
    assert sum(coarse["cells"]["value"]) == pytest.approx(full["total"], abs=1e-2)


def test_built_pages_are_served_next_to_the_api(tmp_path):
    (tmp_path / "assets").mkdir()
    (tmp_path / "dashboard").mkdir()
    (tmp_path / "index.html").write_text("<!doctype html><title>landing</title>", encoding="utf-8")
    (tmp_path / "dashboard" / "index.html").write_text("<!doctype html><title>dashboard</title>", encoding="utf-8")
    (tmp_path / "assets" / "app.js").write_text("console.log(1)", encoding="utf-8")
    client = TestClient(create_app(tmp_path))
    assert "landing" in client.get("/").text
    moved = client.get("/dashboard?from=2015-01-01", follow_redirects=False)
    assert moved.status_code == 307 and moved.headers["location"].endswith("/dashboard/?from=2015-01-01")
    assert "dashboard" in client.get("/dashboard/?from=2015-01-01").text
    assert client.get("/assets/app.js").text == "console.log(1)"
    assert client.get("/health").json() == {"status": "ok"}
    assert client.get("/api/series?area=nope").status_code == 400
    assert TestClient(create_app(tmp_path / "missing")).get("/").status_code == 404
