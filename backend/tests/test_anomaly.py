"""Anomaly scoring rules, reference windows and the anomalies endpoint on a synthetic dataset."""

from __future__ import annotations

import datetime as dt

import pytest
from fastapi.testclient import TestClient

from app import anomaly, api, queries, store
from app.harmonise import weights
from app.harmonise.regions import GROUPS
from app.main import app

from .conftest import BALI, RIAU, day_row, write_dataset
from .test_api import real

#: VIIRS cell-days count sqrt(pixels) (k = 1); VIIRS FRP is halved (kf = 2).
PARAMS = {"k_table": [{"region": g, "month": m, "k": 1.0} for g in GROUPS for m in range(1, 13)],
          "frp": {"k_table": [{"region": g, "month": m, "k": 2.0} for g in GROUPS for m in range(1, 13)]}}


def test_upper_tail_score_matches_the_formula():
    ref = [0, 0, 2, 5, 9]
    assert anomaly.upper_tail_score(0, ref) == 0
    assert anomaly.upper_tail_score(5, ref) == pytest.approx(1 - (1 + 2) / 6)
    assert anomaly.upper_tail_score(10, ref) == pytest.approx(5 / 6) == anomaly.max_score(5)


def test_labels_and_the_sample_size_ceiling():
    assert [anomaly.label_of(s) for s in (0.5, 0.8, 0.9, 0.97)] == ["normal", "elevated", "anomalous", "extreme"]
    assert anomaly.label_of(12 / 15) == "elevated"
    assert anomaly.reachable_labels(24) == ["normal", "elevated", "anomalous"]
    assert anomaly.reachable_labels(40) == ["normal", "elevated", "anomalous", "extreme"]
    top = anomaly.assess(100, [1.0] * 24)
    assert top["label"] == "anomalous" and top["at_ceiling"]
    assert not anomaly.assess(100, [1.0] * 40)["at_ceiling"]
    assert anomaly.assess(100, [1.0] * 3) == {"score": None, "label": anomaly.INSUFFICIENT, "at_ceiling": False}
    assert anomaly.assess(0, [0.0] * 24)["label"] == "normal"


def test_combined_label_takes_the_higher_indicator():
    a = {"score": 0.93, "label": "anomalous", "at_ceiling": True}
    f = {"score": 0.8, "label": "elevated", "at_ceiling": False}
    assert anomaly.combine(a, f) == ("anomalous", "activity")
    assert anomaly.combine(f, a) == ("anomalous", "frp")
    assert anomaly.combine(a, a) == ("anomalous", "both")


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
            observed = i >= (outage or {}).get(y, 0)
            rows.append(day_row(d, aqua=observed, snpp=observed))
    return rows


def test_baseline_spans_the_splice_skips_low_coverage_and_matches_partial_months():
    days = september_days(range(2009, 2016), outage={2010: 5}, last=dt.date(2015, 9, 10))
    b = anomaly.baseline(flags_for(days), 2015, 9)
    assert b.provisional and b.target.end == dt.date(2015, 9, 10)
    assert all(w.end.day == 10 for w in b.reference)
    assert b.years == [2009, 2011, 2012, 2013, 2014]
    assert b.excluded == [{"year": 2010, "reason": "low_coverage", "observed_days": 5, "window_days": 10}]
    assert b.reference[0].platforms == {"Aqua": 10} and b.reference[-1].platforms == {"SNPP": 10}
    assert anomaly.baseline(flags_for(days), 2013, 9, "prior").years == [2009, 2011, 2012]
    with pytest.raises(ValueError):
        anomaly.baseline(flags_for(days), 2008, 9)


@pytest.fixture
def dataset(tmp_path):
    """Septembers 2009-2018 (Aqua before the splice, S-NPP after): Bali burns a little every year,
    Riau burns only in 2015."""
    years = range(2009, 2019)
    celldays = []
    for y in years:
        for i in range(0, 30, 3):
            d = dt.date(y, 9, 1) + dt.timedelta(days=i)
            if y < 2012:
                celldays.append(("modis", "Aqua", d, BALI[0], BALI[1], 1, 0, 30.0 + y % 3, 30.0))
            else:
                celldays.append(("viirs", "SNPP", d, BALI[0], BALI[1], 2 + (y % 3), 1, 6.0 + y % 3, 3.0))
            if y == 2015:
                celldays.append(("viirs", "SNPP", d, RIAU[0], RIAU[1], 20, 5, 200.0, 40.0))
                celldays.append(("modis", "Aqua", d, RIAU[0], RIAU[1], 3, 0, 90.0, 40.0))
    return write_dataset(tmp_path, celldays, september_days(years), [RIAU, BALI])


@pytest.fixture
def client(dataset):
    con = store.connect(PARAMS, dataset)
    con.execute("CREATE TABLE region_daily (x INTEGER)")
    api.configure(con, PARAMS)
    yield TestClient(app)
    api.configure(None, None)


def test_area_record_uses_the_harmonised_record(client):
    body = client.get("/api/anomalies?year=2015&month=9").json()
    assert body["baseline"]["years"] == [2009, 2010, 2011, 2012, 2013, 2014, 2016, 2017, 2018]
    assert "grids" not in body
    years = {y["year"]: y for y in body["area"]["years"]}
    # Aqua years count one per active cell-day and keep their FRP; S-NPP years count sqrt(pixels)
    # and halve their FRP. Riau's Aqua rows in 2015 are not part of the record.
    assert years[2010]["activity"] == 10 and years[2010]["frp_mw"] == pytest.approx(10 * 30.0)
    assert years[2015]["activity"] == pytest.approx(10 * (5 ** 0.5 + 25 ** 0.5), abs=1e-3)
    assert years[2015]["frp_mw"] == pytest.approx(10 * (8.0 + 200.0) / 2)
    assert [y["target"] for y in body["area"]["years"]].count(True) == 1
    assert body["area"]["label"] == "anomalous" and body["area"]["activity_at_ceiling"]


def test_grids_are_opt_in_and_flag_the_unusual_cell(client):
    body = client.get("/api/anomalies?year=2015&month=9&grids=true").json()
    grids = {g["grid_id"]: g for g in body["grids"]}
    riau = grids[anomaly.grid_id(*anomaly.grid_of(RIAU[0], RIAU[1]))]
    bali = grids[anomaly.grid_id(*anomaly.grid_of(BALI[0], BALI[1]))]
    assert riau["activity"] == pytest.approx(50.0) and riau["frp_mw"] == pytest.approx(1000.0)
    assert riau["label"] == "anomalous" and riau["activity_at_ceiling"] and riau["sparse_history"]
    assert "usually has no fire" in riau["disclaimer"] and "50.00 fire cell-days" in riau["disclaimer"]
    assert riau["environmental_context"]["province_id"] == "idn-riau" and riau["in_area_share"] == 1.0
    assert bali["label"] == "normal" and not bali["sparse_history"] and bali["disclaimer"] is None
    assert body["counts"]["anomalous"] == 1 and body["counts"]["normal"] == 1
    assert "years" not in riau


def test_area_selection_and_short_baselines(client):
    body = client.get("/api/anomalies?year=2015&month=9&area=idn-bali&grids=true").json()
    assert [g["environmental_context"]["province_id"] for g in body["grids"]] == ["idn-bali"]
    assert body["area"]["label"] == "normal"
    prior = client.get("/api/anomalies?year=2012&month=9&reference=prior").json()
    assert prior["baseline"]["years"] == [2009, 2010, 2011]
    assert prior["area"]["label"] == anomaly.INSUFFICIENT and "insufficient_baseline" in prior["data_quality"]["flags"]
    assert client.get("/api/anomalies?year=2001&month=9").status_code == 400


def test_default_period_is_the_last_data_month(client):
    body = client.get("/api/anomalies").json()
    assert (body["period"]["year"], body["period"]["month"]) == (2018, 9)
    assert not body["period"]["provisional"]


def test_missing_frp_factors_are_reported(dataset):
    params = {"k_table": PARAMS["k_table"]}
    con = store.connect(params, dataset)
    con.execute("CREATE TABLE region_daily (x INTEGER)")
    api.configure(con, params)
    try:
        res = TestClient(app).get("/api/anomalies?year=2015&month=9")
        assert res.status_code == 503 and "fit" in res.json()["detail"]
    finally:
        api.configure(None, None)


@real
def test_real_area_activity_matches_the_region_cache():
    con = store.connect(weights.load_params())
    flags = queries.day_flags(con)
    b = anomaly.baseline(flags, 2019, 9)
    area = anomaly.totals(con, b.windows, queries.area_filter(["idn-riau"]))[None]
    daily = queries.record_series(queries.daily_cached(con, "all", ["idn-riau"]), flags)
    for w in b.windows:
        cached = sum(v or 0 for (d, _, _), v in zip(flags, daily) if w.start <= d <= w.end)
        assert area.get(w.year, (0.0, 0.0))[0] == pytest.approx(cached, abs=1e-6)
    anomaly.area_grids(con, "TRUE", "allg")
    grids = anomaly.grid_totals(con, b, "allg")
    national = anomaly.totals(con, b.windows)[None]
    assert sum(v.get(2019, (0, 0))[0] for v in grids.values()) == pytest.approx(national[2019][0], rel=1e-9)
