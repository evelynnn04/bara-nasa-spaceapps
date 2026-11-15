"""Anomaly scoring rules, reference windows and the anomalies endpoint on a synthetic dataset."""

from __future__ import annotations

import datetime as dt

import pytest
from fastapi.testclient import TestClient

from app import anomaly, api, queries, store
from app.main import app

from .conftest import BALI, RIAU, day_row, write_dataset
from .test_api import real


def test_upper_tail_score_matches_the_formula():
    ref = [0, 0, 2, 5, 9]
    assert anomaly.upper_tail_score(0, ref) == 0
    assert anomaly.upper_tail_score(5, ref) == pytest.approx(1 - (1 + 2) / 6)
    assert anomaly.upper_tail_score(10, ref) == pytest.approx(5 / 6) == anomaly.max_score(5)


def test_labels_and_the_sample_size_ceiling():
    assert [anomaly.label_of(s) for s in (0.5, 0.8, 0.9, 0.97)] == ["normal", "elevated", "anomalous", "extreme"]
    assert anomaly.label_of(12 / 15) == "elevated"
    assert anomaly.reachable_labels(14) == ["normal", "elevated", "anomalous"]
    assert anomaly.reachable_labels(40) == ["normal", "elevated", "anomalous", "extreme"]
    top = anomaly.assess(100, [1.0] * 14)
    assert top["label"] == "anomalous" and top["at_ceiling"]
    assert not anomaly.assess(100, [1.0] * 40)["at_ceiling"]
    assert anomaly.assess(100, [1.0] * 3) == {"score": None, "label": anomaly.INSUFFICIENT, "at_ceiling": False}
    assert anomaly.assess(0, [0.0] * 14)["label"] == "normal"


def test_combined_label_takes_the_higher_indicator():
    h = {"score": 0.93, "label": "anomalous", "at_ceiling": True}
    f = {"score": 0.8, "label": "elevated", "at_ceiling": False}
    assert anomaly.combine(h, f) == ("anomalous", "hotspot")
    assert anomaly.combine(f, h) == ("anomalous", "frp")
    assert anomaly.combine(h, h) == ("anomalous", "both")


def flags_for(days: list[tuple]) -> list[tuple]:
    return [(d[0], d[7], False) for d in days]


def september_days(years, outage: dict[int, int] | None = None, last: dt.date | None = None) -> list[tuple]:
    """Day rows for every September of `years`; `outage` gives unobserved days per year."""
    rows = []
    for y in years:
        for i in range(30):
            d = dt.date(y, 9, 1) + dt.timedelta(days=i)
            if last and d > last:
                break
            rows.append(day_row(d, snpp=i >= (outage or {}).get(y, 0)))
    return rows


def test_baseline_windows_skip_low_coverage_and_match_partial_months():
    days = september_days(range(2012, 2019), outage={2013: 5}, last=dt.date(2018, 9, 10))
    b = anomaly.baseline(flags_for(days), 2018, 9)
    assert b.provisional and b.target.end == dt.date(2018, 9, 10)
    assert all(w.end.day == 10 for w in b.reference)
    assert b.years == [2012, 2014, 2015, 2016, 2017]
    assert b.excluded == [{"year": 2013, "reason": "low_coverage", "observed_days": 5, "window_days": 10}]
    assert anomaly.baseline(flags_for(days), 2016, 9, "prior").years == [2012, 2014, 2015]
    with pytest.raises(ValueError):
        anomaly.baseline(flags_for(days), 2012, 1)


@pytest.fixture
def client(tmp_path):
    """Septembers 2012-2018: Bali burns a little every year, Riau burns only in 2015."""
    years = range(2012, 2019)
    days = september_days(years)
    celldays = []
    for y in years:
        for i in range(0, 30, 3):
            d = dt.date(y, 9, 1) + dt.timedelta(days=i)
            celldays.append(("viirs", "SNPP", d, BALI[0], BALI[1], 2 + (y % 3), 1, 6.0 + y % 3, 3.0))
            if y == 2015:
                celldays.append(("viirs", "SNPP", d, RIAU[0], RIAU[1], 20, 5, 200.0, 40.0))
                celldays.append(("modis", "Aqua", d, RIAU[0], RIAU[1], 3, 0, 90.0, 40.0))
    root = write_dataset(tmp_path, celldays, days, [RIAU, BALI])
    con = store.connect(None, root)
    con.execute("CREATE TABLE region_daily (x INTEGER)")
    api.configure(con, {"k_table": []})
    yield TestClient(app)
    api.configure(None, None)


def test_endpoint_flags_the_unusual_grid_and_keeps_the_usual_one_normal(client):
    body = client.get("/api/anomalies?year=2015&month=9").json()
    assert body["baseline"]["years"] == [2012, 2013, 2014, 2016, 2017, 2018]
    assert body["baseline"]["max_score"] == pytest.approx(6 / 7, abs=1e-4)
    grids = {g["grid_id"]: g for g in body["grids"]}
    riau = grids[anomaly.grid_id(*anomaly.grid_of(RIAU[0], RIAU[1]))]
    bali = grids[anomaly.grid_id(*anomaly.grid_of(BALI[0], BALI[1]))]
    assert riau["hotspot_count"] == 250 and riau["summed_frp_mw"] == 2000.0
    assert riau["label"] == "elevated" and riau["hotspot_at_ceiling"] and riau["sparse_history"]
    assert riau["environmental_context"]["province_id"] == "idn-riau"
    assert "usually has no fire" in riau["disclaimer"] and "250 hotspots" in riau["disclaimer"]
    assert bali["label"] == "normal" and not bali["sparse_history"] and bali["disclaimer"] is None
    years = body["area"]["years"]
    assert [y["year"] for y in years] == list(range(2012, 2019)) and [y["target"] for y in years].count(True) == 1
    assert sum(y["hotspot_count"] for y in years if y["target"]) == body["area"]["hotspot_count"]
    assert "years" not in riau
    assert body["counts"]["elevated"] == 1 and body["counts"]["normal"] == 1
    assert body["area"]["hotspot_count"] == riau["hotspot_count"] + bali["hotspot_count"]


def test_endpoint_restricts_grids_to_the_area_and_reports_short_baselines(client):
    body = client.get("/api/anomalies?year=2015&month=9&area=idn-bali").json()
    assert [g["environmental_context"]["province_id"] for g in body["grids"]] == ["idn-bali"]
    prior = client.get("/api/anomalies?year=2015&month=9&reference=prior").json()
    assert prior["baseline"]["years"] == [2012, 2013, 2014]
    assert prior["area"]["label"] == anomaly.INSUFFICIENT and "insufficient_baseline" in prior["data_quality"]["flags"]
    assert client.get("/api/anomalies?year=2011&month=9").status_code == 400


def test_default_period_is_the_last_data_month(client):
    body = client.get("/api/anomalies").json()
    assert (body["period"]["year"], body["period"]["month"]) == (2018, 9)
    assert not body["period"]["provisional"]


@real
def test_real_grid_values_add_up_to_the_area_totals():
    con = store.connect()
    flags = queries.day_flags(con)
    b = anomaly.baseline(flags, 2019, 9)
    anomaly.area_grids(con, queries.area_filter(["idn-riau"]), "agrid")
    totals = anomaly.area_totals(con, b, "agrid_cells")
    grids = anomaly.monthly_grids(con, b, "agrid")
    anomaly.area_grids(con, "TRUE", "allg")
    national = anomaly.monthly_grids(con, b, "allg")
    assert sum(v.get(2019, (0, 0))[0] for v in national.values()) == anomaly.area_totals(con, b, "allg_cells")[2019][0]
    assert sum(v.get(2019, (0, 0))[0] for v in grids.values()) >= totals[2019][0] > 0
