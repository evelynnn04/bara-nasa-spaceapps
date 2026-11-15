"""Fire cause attribution: the rules, the context readers and the events API on synthetic data."""

from __future__ import annotations

import datetime as dt

import duckdb
import pytest
from fastapi.testclient import TestClient

from app import api, attribution, context, store
from app.main import app
from app.pipeline import aggregate, events

from .conftest import write_table
from .test_api import fitted, synthetic

NONE = dict.fromkeys(attribution.EVIDENCE)


def evidence(**kw) -> dict:
    """Evidence of an event with every context field missing except those given."""
    return {**NONE, "island_group": "Kalimantan", "cells": 10, "duration_days": 5, "forest_loss_expected": 0.0 if "forest_loss" in kw else None,
            **kw}


def land(**shares) -> dict:
    return {**{k: 0.0 for k in attribution.GROUPS}, **shares}


def ids(res: dict, met=True) -> set[str]:
    return {i["id"] for i in res["indicators"] if i["met"] is met}


def test_forest_loss_on_tree_cover_points_to_land_clearing():
    res = attribution.evaluate(evidence(forest2000=0.8, forest_loss=0.12, **land(forest=0.9), peat=0.0,
                                        rain3=9.0, rain3_normal=9.0, oni=0.0, dmi=0.0))
    assert res["category"] == "land_clearing"
    assert {"forest_loss_strong", "tree_cover_before"} <= ids(res)


def test_usual_forest_loss_is_not_clearing_evidence():
    res = attribution.evaluate(evidence(forest2000=0.8, forest_loss=0.06, forest_loss_expected=0.055,
                                        **land(forest=0.9), peat=0.0, rain3=9.0, rain3_normal=9.0, oni=0.0, dmi=0.0))
    assert res["scores"]["land_clearing"] == 0 and "no_clearing" in ids(res)


def test_small_fire_on_cropland_points_to_agricultural_burning():
    res = attribution.evaluate(evidence(cells=2, duration_days=1, forest2000=0.0, forest_loss=0.0,
                                        **land(cropland=0.6, mosaic=0.2), peat=0.0, rain3=8.0, rain3_normal=8.0))
    assert res["category"] == "agricultural_burning" and res["confidence"] == "high"
    assert ids(res) == {"cropland_dominant", "small_short", "no_clearing"}


def test_large_peat_fire_in_el_nino_drought_points_to_wildfire():
    res = attribution.evaluate(evidence(cells=300, duration_days=40, forest2000=0.1, forest_loss=0.002,
                                        **land(wetland=0.4, shrub_savanna=0.3), peat=0.8,
                                        rain3=1.5, rain3_normal=6.0, oni=2.0, dmi=0.3))
    assert res["category"] == "wildfire" and res["confidence"] == "high"
    assert {"dry_months", "rain_deficit", "climate_driver", "peatland", "natural_vegetation", "large_long"} <= ids(res)


def test_dry_threshold_applies_only_where_it_was_established():
    dry = dict(cells=50, duration_days=10, forest_loss=0.0, **land(shrub_savanna=0.9), peat=0.0, rain3=1.0,
               rain3_normal=1.0, oni=0.0, dmi=0.0)
    assert "dry_months" in ids(attribution.evaluate(evidence(**dry)))
    res = attribution.evaluate(evidence(**dry, island_group="Java-Bali-NT"))
    assert "dry_months" in ids(res, None) and res["category"] == "unknown"


def test_drought_alone_names_no_wildfire_without_burnable_land():
    res = attribution.evaluate(evidence(cells=50, duration_days=10, forest_loss=0.0, **land(urban=0.9),
                                        peat=0.0, rain3=1.0, rain3_normal=6.0, oni=1.5))
    assert res["category"] == "unknown" and res["confidence"] is None


def test_missing_context_leaves_indicators_unavailable_and_the_cause_unknown():
    res = attribution.evaluate(evidence())
    assert res["category"] == "unknown"
    unavailable = ids(res, None)
    assert "forest_loss_strong" in unavailable and "dry_months" in unavailable
    assert "small_short" not in unavailable


def test_equal_support_for_two_causes_stays_unknown():
    res = attribution.evaluate(evidence(island_group="Sulawesi-Maluku", cells=200, duration_days=30, forest2000=0.9,
                                        forest_loss=0.2, **land(forest=0.9), peat=0.5,
                                        rain3=3.0, rain3_normal=6.0, oni=2.0, dmi=0.5))
    assert res["scores"]["land_clearing"] == res["scores"]["wildfire"] == 3
    assert res["category"] == "unknown"


LARGE_CLEARING = dict(cells=50, duration_days=10, forest2000=0.8, forest_loss=0.18, **land(forest=0.9),
                      peat=0.0, rain3=9.0, rain3_normal=9.0, oni=0.0, dmi=0.0)


@pytest.mark.parametrize("signal", [{}, {"oni": 1.0}, {"rain3": 3.0, "rain3_normal": 3.5}, {"peat": 0.5}])
def test_large_clearing_fire_with_one_wildfire_signal_stays_land_clearing(signal):
    res = attribution.evaluate(evidence(**{**LARGE_CLEARING, **signal}))
    assert res["category"] == "land_clearing"
    assert ids(res, met=False) >= {"natural_vegetation", "large_long"}


def test_large_fire_on_uncleared_forest_keeps_its_wildfire_points():
    res = attribution.evaluate(evidence(**{**LARGE_CLEARING, "forest_loss": 0.0, "rain3": 3.0, "rain3_normal": 6.0,
                                           "oni": 1.0}))
    assert res["category"] == "wildfire" and {"natural_vegetation", "large_long"} <= ids(res)


def test_cleared_forest_is_still_burnable_land_for_wildfire():
    res = attribution.evaluate(evidence(**{**LARGE_CLEARING, "forest_loss": 0.03, "forest2000": 0.3,
                                           "rain3": 1.5, "rain3_normal": 6.0, "oni": 2.0}))
    assert res["category"] == "wildfire" and "natural_vegetation" not in ids(res)


def test_every_indicator_cites_known_sources_and_max_points_add_up():
    for ind in attribution.INDICATORS:
        assert ind.category in attribution.CATEGORIES and set(ind.sources) <= set(attribution.SOURCES)
    assert attribution.MAX_POINTS == {"land_clearing": 3, "agricultural_burning": 4, "wildfire": 6}


def test_climate_index_files_are_parsed():
    pytest.importorskip("numpy")
    from app.context import climate
    oni = climate.parse_oni("SEAS  YR   TOTAL   ANOM\n  DJF 2015  27.20   0.55\n  JAS 2015  28.67   1.90\n")
    assert oni == {dt.date(2015, 1, 1): 0.55, dt.date(2015, 8, 1): 1.90}
    dmi = climate.parse_dmi("1870 2026\n2026  0.1 0.2 -9999.000 0.3 0.4 0.5 0.6 0.7 0.8 0.9 1.0 1.1\n")
    assert dmi[dt.date(2026, 2, 1)] == 0.2 and dt.date(2026, 3, 1) not in dmi


def test_hansen_tile_names():
    pytest.importorskip("numpy")
    from app.context import hansen
    assert hansen.tile_name(0, 100) == "00N_100E"
    assert hansen.tile_name(-10, 120) == "10S_120E"
    assert hansen.tile_name(10, 90) == "10N_090E"


def test_modis_sinusoidal_tiles_are_placed_on_the_grid():
    pytest.importorskip("numpy")
    from app.context import modis
    lon, lat = modis.pixel_centres(28, 9)
    assert lat[0, 0] == pytest.approx(-0.5 * modis.TILE / modis.PIXELS / modis.R * 57.29577951, abs=1e-9)
    assert lon[0, 0] == pytest.approx(100.0, abs=0.01)
    assert lat[-1, 0] == pytest.approx(-10.0, abs=0.01)


def test_context_cells_cover_land_and_the_record_but_not_open_sea():
    np = pytest.importorskip("numpy")
    from app.context import grid
    # Riau and Bali cells of the record, a Riau inland cell, and open sea in the Indian Ocean and Banda Sea.
    cx = np.array([2020, 2303, 2030, 1900, 2600])
    cy = np.array([10, -168, 12, -200, -110])
    assert grid.keep(cx, cy).tolist() == [True, True, True, False, False]


def test_grid_tables_keep_dates_and_missing_values(tmp_path):
    np = pytest.importorskip("numpy")
    from app.context import grid
    dest = tmp_path / "t.parquet"
    grid.write_parquet(dest, {"month": ("DATE", np.array([dt.date(2015, 9, 1).toordinal()])),
                              "oni": ("DOUBLE", np.array([np.nan])), "cx": ("INTEGER", np.array([2020]))})
    assert duckdb.execute(f"SELECT * FROM '{dest}'").fetchall() == [(dt.date(2015, 9, 1), None, 2020)]


def write_context(root) -> None:
    """Context for the synthetic Riau cell (cleared forest) and Bali cell (cropland), in the stored
    layout: pixel counts per piece, rain in hundredths of mm/day."""
    con = duckdb.connect()
    for d in ("hansen", "modis", "imerg"):
        (root / d).mkdir(parents=True, exist_ok=True)
    px = context.HANSEN_CELL_PX
    write_table(con, root / "hansen" / "00N_100E.parquet",
                {"cx": "SMALLINT", "cy": "SMALLINT", "year": "SMALLINT", "px": "USMALLINT"},
                [(2020, 10, 0, int(0.8 * px)), (2020, 10, 2015, int(0.2 * px)), (2020, 10, 2010, int(0.5 * px))])
    lc_cols = {"cx": "SMALLINT", "cy": "SMALLINT", "year": "SMALLINT", "n": "USMALLINT",
               **{k: "USMALLINT" for k in attribution.GROUPS}}
    def lc(cx, cy, year, **s):
        return (cx, cy, year, 100, *(round(100 * land(**s)[k]) for k in attribution.GROUPS))
    write_table(con, root / "modis" / "2014.parquet", lc_cols,
                [lc(2020, 10, 2014, forest=1.0), lc(2303, -168, 2014, cropland=0.8, urban=0.2)])
    write_table(con, root / "modis" / "2015.parquet", lc_cols, [lc(2303, -168, 2015, forest=1.0)])
    months = [dt.date(y, m, 1) for y in range(2001, 2016) for m in range(1, 13)]
    scale = context.RAIN_SCALE
    write_table(con, root / "imerg" / "all.parquet",
                {"rx": "SMALLINT", "ry": "SMALLINT", "month": "DATE", "rain": "USMALLINT"},
                [(1010, 5, m, 10 * scale) for m in months] + [(1151, -84, m, 6 * scale) for m in months])
    write_table(con, root / "climate.parquet", {"month": "DATE", "oni": "FLOAT", "dmi": "FLOAT"},
                [(m, 0.0, 0.0) for m in months])


@pytest.fixture
def client(tmp_path):
    root = synthetic(tmp_path / "data")
    _, params = fitted(root)
    con = store.connect(params, root)
    aggregate.build(con, store.table_path("region_daily", root))
    events.build(con, store.table_path("events", root), store.table_path("event_cells", root))
    write_context(tmp_path / "context")
    attribution.build(store.connect(params, root), store.table_path("event_attribution", root), tmp_path / "context")
    api.configure(store.connect(params, root), {**params, "verdict": "insufficient data", "settings": {}})
    yield TestClient(app)
    api.configure(None, None)


def test_events_carry_their_attribution_and_evidence(client):
    body = client.get("/api/events", params={"from": "2015-08-01", "to": "2015-10-31"}).json()
    assert body["attribution_disclaimer"] == attribution.DISCLAIMER
    by_province = {}
    for e in body["events"]:
        by_province.setdefault(e["province_id"], e["attribution"])
    riau, bali = by_province["idn-riau"], by_province["idn-bali"]
    assert riau["category"] == "land_clearing"
    # 0.5 lost in 2010, spread over the 21 years outside 2014-2016, makes 3 * 0.5 / 21 expected.
    assert riau["evidence"]["forest_loss"] == {"share": 0.2, "expected_share": round(1.5 / 21, 4),
                                               "excess_share": round(0.2 - 1.5 / 21, 4), "years": [2014, 2016],
                                               "source": "hansen2013"}
    assert riau["evidence"]["landcover"]["year"] == 2014
    assert riau["evidence"]["rainfall"]["share_of_normal"] == 1.0
    assert bali["category"] == "agricultural_burning"
    assert bali["evidence"]["landcover"]["shares"]["cropland"] == 0.8
    assert bali["evidence"]["peat"] is None


def test_events_can_be_filtered_by_cause(client):
    body = client.get("/api/events", params={"from": "2015-08-01", "to": "2015-10-31",
                                             "cause": "agricultural_burning"}).json()
    assert body["events"] and {e["province_id"] for e in body["events"]} == {"idn-bali"}
    assert {e["attribution"]["category"] for e in body["events"]} == {"agricultural_burning"}
    assert client.get("/api/events", params={"cause": "arson"}).status_code == 422


def test_attribution_method_lists_rules_sources_and_layers(client):
    body = client.get("/api/attribution").json()
    assert body["available"] and body["disclaimer"] == attribution.DISCLAIMER
    assert body["layers"] == {"forest2000": True, "forest_loss": True, "landcover_year": True, "peat": False,
                              "rain3": True, "oni": True, "dmi": True}
    assert {i["id"] for i in body["indicators"]} == {i.id for i in attribution.INDICATORS}


def test_context_downloads_run_in_parallel_and_keep_their_order(monkeypatch):
    import threading
    import time
    from pathlib import Path

    from app.context import fetch
    running, peak, lock = 0, 0, threading.Lock()

    def fake(url, dest, token=None):
        nonlocal running, peak
        with lock:
            running += 1
            peak = max(peak, running)
        time.sleep(0.05)
        with lock:
            running -= 1
        return dest

    monkeypatch.setattr(fetch, "download", fake)
    jobs = [(f"https://example.org/{i}", Path(f"f{i}")) for i in range(8)]
    assert list(fetch.download_many(jobs, workers=4)) == [d for _, d in jobs]
    assert peak == 4
