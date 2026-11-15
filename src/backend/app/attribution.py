"""Rule-based cause attribution of fire events.

Every fire event is enriched with the environmental context of the cells where it burned, weighted
by the harmonised hotspots of each cell (see `app.context` for the sources):

- tree cover in 2000, forest loss in the year before, the year of and the year after the peak
  day, and the loss those cells usually have in as many years (Hansen Global Forest Change);
- land cover of the year before the peak day (MODIS MCD12Q1, IGBP class groups);
- peatland share (CIFOR peatland map);
- rainfall of the three months ending with the peak month, and its 2001-2020 normal (GPM IMERG);
- El Niño (ONI) and Indian Ocean Dipole (DMI) indices of the peak month.

Indicators in `INDICATORS` turn this evidence into points for three likely causes: land clearing,
agricultural burning and wildfire. Each indicator names the published finding it rests on
(`SOURCES`). The cause with the most points wins when its key indicator holds and it has at least
`MIN_POINTS`; otherwise the event stays `unknown`. The confidence level compares the winner's
points with its maximum and with the runner-up.

The result is possible related evidence, not definitive causal evidence (`DISCLAIMER`). Satellites
see where and when fire burned and what the land looked like; they do not see who lit it or why.
The method is described in docs/attribution.md.
"""

from __future__ import annotations

import csv
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import duckdb

from . import config, store
from . import context
from .context import CANOPY_MIN, GROUPS, HANSEN_LAST_YEAR
from .db import quote

log = logging.getLogger("app.attribution")

DISCLAIMER = ("Possible cause from related environmental evidence, not definitive causal evidence. "
              "Satellite data show where and when fire burned and what the land looked like, not who lit it "
              "or why. Confirm with field reports before acting on it.")

CATEGORIES = ("land_clearing", "agricultural_burning", "wildfire", "unknown")
LABELS = {"land_clearing": "Land clearing", "agricultural_burning": "Agricultural burning",
          "wildfire": "Wildfire", "unknown": "Unknown"}
#: Fewest points for a cause to be named.
MIN_POINTS = 2
#: First and last year of the rainfall normal.
RAIN_NORMAL = (2001, 2020)

#: Published sources the indicators and datasets rest on.
SOURCES: dict[str, dict[str, str]] = {
    "hansen2013": {"citation": "Hansen, M. C. et al. (2013). High-resolution global maps of 21st-century forest "
                               "cover change. Science 342, 850-853. Data: Global Forest Change 2000-2024 v1.12.",
                   "url": "https://doi.org/10.1126/science.1244693"},
    "tyukavina2022": {"citation": "Tyukavina, A. et al. (2022). Global trends of forest loss due to fire from 2001 "
                                  "to 2019. Frontiers in Remote Sensing 3, 825190.",
                      "url": "https://doi.org/10.3389/frsen.2022.825190"},
    "curtis2018": {"citation": "Curtis, P. G. et al. (2018). Classifying drivers of global forest loss. "
                               "Science 361, 1108-1111.",
                   "url": "https://doi.org/10.1126/science.aau3445"},
    "mcd12q1": {"citation": "Friedl, M., Sulla-Menashe, D. (2022). MODIS/Terra+Aqua Land Cover Type Yearly L3 "
                            "Global 500m SIN Grid V061. NASA LP DAAC.",
                "url": "https://doi.org/10.5067/MODIS/MCD12Q1.061"},
    "korontzi2006": {"citation": "Korontzi, S. et al. (2006). Global distribution of agricultural fires in croplands "
                                 "from 3 years of Moderate Resolution Imaging Spectroradiometer (MODIS) data. "
                                 "Global Biogeochemical Cycles 20, GB2021.",
                     "url": "https://doi.org/10.1029/2005GB002529"},
    "gumbricht2017": {"citation": "Gumbricht, T. et al. (2017). An expert system model for mapping tropical "
                                  "wetlands and peatlands reveals South America as the largest contributor. "
                                  "Global Change Biology 23, 3581-3599. Data: CIFOR peatland map v2.1.",
                      "url": "https://doi.org/10.17528/CIFOR/DATA.00058"},
    "page2002": {"citation": "Page, S. E. et al. (2002). The amount of carbon released from peat and forest fires "
                             "in Indonesia during 1997. Nature 420, 61-65.",
                 "url": "https://doi.org/10.1038/nature01131"},
    "imerg": {"citation": "Huffman, G. J. et al. (2023). GPM IMERG Final Precipitation L3 1 month 0.1 degree x "
                          "0.1 degree V07. NASA GES DISC.",
              "url": "https://doi.org/10.5067/GPM/IMERG/3B-MONTH/07"},
    "field2009": {"citation": "Field, R. D., van der Werf, G. R., Shen, S. S. P. (2009). Human amplification of "
                              "drought-induced biomass burning in Indonesia since 1960. Nature Geoscience 2, "
                              "185-188.",
                  "url": "https://doi.org/10.1038/ngeo443"},
    "field2016": {"citation": "Field, R. D. et al. (2016). Indonesian fire activity and smoke pollution in 2015 "
                              "show persistent nonlinear sensitivity to El Nino-induced drought. PNAS 113, "
                              "9204-9209.",
                  "url": "https://doi.org/10.1073/pnas.1524888113"},
    "oni": {"citation": "NOAA Climate Prediction Center. Oceanic Nino Index (ONI), ERSSTv5.",
            "url": "https://www.cpc.ncep.noaa.gov/products/analysis_monitoring/ensostuff/ONI_v5.php"},
    "saji1999": {"citation": "Saji, N. H. et al. (1999). A dipole mode in the tropical Indian Ocean. Nature 401, "
                             "360-363. Data: NOAA PSL Dipole Mode Index (HadISST1).",
                 "url": "https://doi.org/10.1038/43854"},
}


@dataclass(frozen=True)
class Indicator:
    """One piece of evidence for one cause."""

    id: str
    category: str
    points: int
    text: str
    #: Evidence fields the test reads; the indicator is unavailable when any of them is missing.
    needs: tuple[str, ...]
    test: Callable[[dict], bool]
    sources: tuple[str, ...]
    #: Whether the cause can only be named when this indicator holds (any key indicator of it).
    key: bool = False
    #: The stronger indicator this one is a weaker step of; the two never hold together.
    weaker_of: str | None = None


#: Land cover groups of natural vegetation.
NATURAL = ("forest", "shrub_savanna", "grassland", "wetland")


def _natural(e: dict) -> float:
    return sum(e[k] for k in NATURAL)


def _farmland(e: dict) -> float:
    return e["cropland"] + e["mosaic"]


def excess_loss(e: dict) -> float:
    """Forest loss around the fire beyond the cells' usual loss over as many years, at least 0."""
    return max(e["forest_loss"] - e["forest_loss_expected"], 0.0)


def _cleared(e: dict) -> bool:
    """Whether the fire coincides with forest clearing (a land clearing key indicator holds); False
    when forest loss is unknown."""
    return e.get("forest_loss") is not None and e.get("forest_loss_expected") is not None         and excess_loss(e) >= LOSS_SOME


def _burnable(e: dict) -> bool:
    """Whether the burned land can carry a wildfire: mostly peat, or mostly natural vegetation the
    year before (cleared or not)."""
    if e.get("peat") is not None and e["peat"] >= 0.3:
        return True
    return all(e.get(k) is not None for k in NATURAL) and _natural(e) >= 0.5


#: Excess forest loss, as a share of the burned cells, that counts as clearing evidence (strong / some).
LOSS_STRONG, LOSS_SOME = 0.05, 0.01
#: Rainfall below this mean rate over three months marks drought-prone conditions (Field et al. 2009),
#: in the island groups the threshold was derived for.
DRY_MM_DAY = 4.0
DRY_REGIONS = ("Sumatra", "Kalimantan")
#: Rainfall at most this share of its normal counts as a deficit.
DEFICIT = 0.6
ONI_EL_NINO, DMI_POSITIVE = 0.5, 0.4

INDICATORS: tuple[Indicator, ...] = (
    Indicator("forest_loss_strong", "land_clearing", 2,
              f"Forest loss within a year of the fire exceeded the usual loss there by at least {LOSS_STRONG:.0%} "
              "of the burned area",
              ("forest_loss", "forest_loss_expected"), lambda e: excess_loss(e) >= LOSS_STRONG,
              ("hansen2013", "tyukavina2022", "curtis2018"), key=True),
    Indicator("forest_loss_some", "land_clearing", 1,
              f"Forest loss within a year of the fire exceeded the usual loss there by {LOSS_SOME:.0%}-{LOSS_STRONG:.0%} "
              "of the burned area",
              ("forest_loss", "forest_loss_expected"), lambda e: LOSS_SOME <= excess_loss(e) < LOSS_STRONG,
              ("hansen2013", "tyukavina2022"), key=True, weaker_of="forest_loss_strong"),
    Indicator("tree_cover_before", "land_clearing", 1,
              "Most of the burned area was tree-covered in 2000 and forest loss around the fire was above usual",
              ("forest2000", "forest_loss", "forest_loss_expected"),
              lambda e: e["forest2000"] >= 0.5 and excess_loss(e) >= LOSS_SOME,
              ("hansen2013", "curtis2018")),
    Indicator("cropland_dominant", "agricultural_burning", 2,
              "At least half of the burned area was cropland or cropland mosaic the year before",
              ("cropland", "mosaic"), lambda e: _farmland(e) >= 0.5,
              ("mcd12q1", "korontzi2006"), key=True),
    Indicator("cropland_present", "agricultural_burning", 1,
              "A quarter to half of the burned area was cropland or cropland mosaic the year before",
              ("cropland", "mosaic"), lambda e: 0.25 <= _farmland(e) < 0.5,
              ("mcd12q1", "korontzi2006"), key=True, weaker_of="cropland_dominant"),
    Indicator("small_short", "agricultural_burning", 1,
              "The fire was small and short (at most 4 cells and 3 days), as crop residue fires usually are",
              ("cells", "duration_days"), lambda e: e["cells"] <= 4 and e["duration_days"] <= 3,
              ("korontzi2006",)),
    Indicator("no_clearing", "agricultural_burning", 1,
              f"Forest loss around the fire was within {LOSS_SOME:.0%} of the burned area of the usual loss, "
              "so no sign of forest clearing",
              ("forest_loss", "forest_loss_expected"), lambda e: excess_loss(e) < LOSS_SOME,
              ("hansen2013",)),
    Indicator("dry_months", "wildfire", 1,
              f"Rainfall over the three months up to the peak averaged under {DRY_MM_DAY:g} mm/day "
              "(Sumatra and Kalimantan only, where this threshold was established)",
              ("rain3", "dry_region"), lambda e: e["rain3"] < DRY_MM_DAY,
              ("imerg", "field2009"), key=True),
    Indicator("rain_deficit", "wildfire", 1,
              f"Rainfall over the three months up to the peak was at most {DEFICIT:.0%} of its 2001-2020 normal",
              ("rain3", "rain3_normal"), lambda e: e["rain3_normal"] > 0 and e["rain3"] <= DEFICIT * e["rain3_normal"],
              ("imerg", "field2009"), key=True),
    Indicator("climate_driver", "wildfire", 1,
              f"El Nino (ONI >= {ONI_EL_NINO}) or a positive Indian Ocean Dipole (DMI >= {DMI_POSITIVE}) in the peak month",
              ("oni", "dmi"), lambda e: (e["oni"] is not None and e["oni"] >= ONI_EL_NINO)
              or (e["dmi"] is not None and e["dmi"] >= DMI_POSITIVE),
              ("oni", "saji1999", "field2016"), key=True),
    Indicator("peatland", "wildfire", 1,
              "At least 30% of the burned area is peatland, where fire spreads underground and is hard to control",
              ("peat",), lambda e: e["peat"] >= 0.3,
              ("gumbricht2017", "page2002", "field2016")),
    # These two also describe a large clearing fire, so they hold only without clearing evidence.
    Indicator("natural_vegetation", "wildfire", 1,
              "At least half of the burned area was forest, shrubland, savanna, grassland or wetland the year before, "
              f"and forest loss around the fire was within {LOSS_SOME:.0%} of the burned area of the usual loss",
              NATURAL, lambda e: _natural(e) >= 0.5 and not _cleared(e),
              ("mcd12q1", "hansen2013")),
    Indicator("large_long", "wildfire", 1,
              "The fire spread over at least 20 cells or lasted at least 7 days, and forest loss around it was "
              f"within {LOSS_SOME:.0%} of the burned area of the usual loss",
              ("cells", "duration_days"), lambda e: (e["cells"] >= 20 or e["duration_days"] >= 7) and not _cleared(e),
              ("field2016", "hansen2013")),
)

#: Fields that may be missing (null) when a dataset does not cover the event.
OPTIONAL = {"oni", "dmi"}
#: Most points each cause can get.
MAX_POINTS = {c: sum(i.points for i in INDICATORS if i.category == c and i.weaker_of is None) for c in CATEGORIES[:3]}


def _available(ind: Indicator, e: dict) -> bool:
    if "dry_region" in ind.needs and e.get("island_group") not in DRY_REGIONS:
        return False
    if set(ind.needs) <= OPTIONAL:
        return any(e.get(k) is not None for k in ind.needs)
    return all(e.get(k) is not None for k in ind.needs if k != "dry_region")


def evaluate(e: dict) -> dict:
    """Indicators, points, cause and confidence of one event's evidence `e`.

    Returns `{"category", "confidence", "scores", "indicators"}`; each indicator is
    `{"id", "category", "points", "met", "text", "sources"}` with `met` None when its data is
    missing."""
    results, scores, keyed = [], dict.fromkeys(CATEGORIES[:3], 0), set()
    for ind in INDICATORS:
        met = ind.test(e) if _available(ind, e) else None
        if met:
            scores[ind.category] += ind.points
            if ind.key:
                keyed.add(ind.category)
        results.append({"id": ind.id, "category": ind.category, "points": ind.points, "met": met,
                        "text": ind.text, "sources": list(ind.sources)})
    if not _burnable(e):
        keyed.discard("wildfire")
    if not keyed:
        return {"category": "unknown", "confidence": None, "scores": scores, "indicators": results}
    best = max(sorted(keyed), key=lambda c: scores[c])
    top = scores[best]
    runner = max(v for c, v in scores.items() if c != best)
    if top < MIN_POINTS or top <= runner:
        return {"category": "unknown", "confidence": None, "scores": scores, "indicators": results}
    share, margin = top / MAX_POINTS[best], top - runner
    confidence = "high" if share >= 0.75 and margin >= 2 else "medium" if share >= 0.5 and margin >= 1 else "low"
    return {"category": best, "confidence": confidence, "scores": scores, "indicators": results}


#: Evidence columns of `event_attribution.parquet`, in order.
EVIDENCE = ("island_group", "year", "month", "cells", "duration_days", "forest2000", "forest_loss", "forest_loss_expected",
            "loss_from", "loss_to", "landcover_year",
            *GROUPS, "peat", "rain3", "rain3_normal", "rain_from", "rain_to", "oni", "dmi")


def attribution_path() -> Path:
    return config.derived_dir() / "event_attribution.parquet"


def _context_views(con: duckdb.DuckDBPyConnection, root: Path | None = None) -> set[str]:
    """Registers the context layers that exist as views `ctx_<name>`; returns their names."""
    layers = context.layer_sql(root)
    for name, sql in layers.items():
        con.execute(f"CREATE OR REPLACE VIEW ctx_{name} AS {sql}")
    return set(layers)


def features_sql(have: set[str]) -> str:
    """One row of evidence per (hotspots, event), with NULL where a context table is missing or
    does not cover the event."""
    g = list(GROUPS)
    parts = ["""
        WITH groups AS (SELECT province_id, any_value(island_group) AS island_group FROM cells GROUP BY 1),
        ev AS (
            SELECT hotspots, event, year(peak_day) AS year, CAST(date_trunc('month', peak_day) AS DATE) AS m,
                   cells, duration_days, groups.island_group
            FROM events LEFT JOIN groups USING (province_id)),
        c AS (SELECT ec.hotspots, ec.event, ec.cx, ec.cy, ec.w, ev.year, ev.m
              FROM event_cells ec JOIN ev USING (hotspots, event)),
        tot AS (SELECT hotspots, event, sum(w) AS wsum FROM c GROUP BY ALL)"""]
    select = ["ev.hotspots", "ev.event", "ev.island_group", "ev.year", "ev.m AS month", "ev.cells", "ev.duration_days"]
    joins = ["JOIN tot USING (hotspots, event)"]
    if "forest" in have:
        parts.append("""f AS (SELECT c.hotspots, c.event, sum(c.w * coalesce(x.forest2000, 0)) AS v
              FROM c LEFT JOIN ctx_forest x USING (cx, cy) GROUP BY ALL)""")
        select.append("f.v / tot.wsum AS forest2000")
        joins.append("LEFT JOIN f USING (hotspots, event)")
    else:
        select.append("NULL::DOUBLE AS forest2000")
    if "forest_loss" in have:
        last = HANSEN_LAST_YEAR
        lo, hi, years = "c.year - 1", f"least(c.year + 1, {last})", last - 2000
        parts.append(f"""l AS (
            SELECT hotspots, event, sum(w * win) AS v, sum(w * other / ({years} - n) * n) AS b FROM (
                SELECT c.hotspots, c.event, any_value(c.w) AS w, {hi} - ({lo}) + 1 AS n,
                       coalesce(sum(x.loss) FILTER (WHERE x.year BETWEEN {lo} AND {hi}), 0) AS win,
                       coalesce(sum(x.loss) FILTER (WHERE x.year NOT BETWEEN {lo} AND {hi}), 0) AS other
                FROM c LEFT JOIN ctx_forest_loss x ON x.cx = c.cx AND x.cy = c.cy
                GROUP BY c.hotspots, c.event, c.cx, c.cy, c.year)
            GROUP BY ALL)""")
        select += [f"CASE WHEN ev.year - 1 <= {last} THEN coalesce(l.v, 0) / tot.wsum END AS forest_loss",
                   f"CASE WHEN ev.year - 1 <= {last} THEN coalesce(l.b, 0) / tot.wsum END AS forest_loss_expected",
                   f"CASE WHEN ev.year - 1 <= {last} THEN ev.year - 1 END AS loss_from",
                   f"CASE WHEN ev.year - 1 <= {last} THEN least(ev.year + 1, {last}) END AS loss_to"]
        joins.append("LEFT JOIN l USING (hotspots, event)")
    else:
        select += ["NULL::DOUBLE AS forest_loss", "NULL::DOUBLE AS forest_loss_expected", "NULL::INT AS loss_from",
                   "NULL::INT AS loss_to"]
    if "landcover" in have:
        shares = ", ".join(f"sum(c.w * x.{k}) AS {k}" for k in g)
        parts.append(f"""lc AS (SELECT c.hotspots, c.event, any_value(x.year) AS landcover_year, sum(c.w) AS wc, {shares}
              FROM c JOIN ctx_landcover x ON x.cx = c.cx AND x.cy = c.cy
                   AND x.year = greatest(least(c.year - 1, (SELECT max(year) FROM ctx_landcover)),
                                         (SELECT min(year) FROM ctx_landcover))
              GROUP BY ALL)""")
        select += ["lc.landcover_year"] + [f"lc.{k} / lc.wc AS {k}" for k in g]
        joins.append("LEFT JOIN lc USING (hotspots, event)")
    else:
        select += ["NULL::INT AS landcover_year"] + [f"NULL::DOUBLE AS {k}" for k in g]
    if "peat" in have:
        parts.append("""p AS (SELECT c.hotspots, c.event, sum(c.w * coalesce(x.peat, 0)) AS v
              FROM c LEFT JOIN ctx_peat x USING (cx, cy) GROUP BY ALL)""")
        select.append("p.v / tot.wsum AS peat")
        joins.append("LEFT JOIN p USING (hotspots, event)")
    else:
        select.append("NULL::DOUBLE AS peat")
    if "rain" in have:
        lo, hi = RAIN_NORMAL
        parts.append(f"""normal AS (SELECT rx, ry, month(month) AS mo, avg(rain) AS rain FROM ctx_rain
              WHERE year(month) BETWEEN {lo} AND {hi} GROUP BY ALL)""")
        parts.append("""r AS (
            SELECT c.hotspots, c.event,
                   sum(c.w * x.rain) / sum(c.w) AS rain3, sum(c.w * n.rain) / sum(c.w) AS rain3_normal,
                   count(DISTINCT x.month) AS months
            FROM c, range(0, 3) k(k)
            JOIN ctx_rain x ON x.rx = CAST(floor(c.cx / 2) AS INT) AND x.ry = CAST(floor(c.cy / 2) AS INT)
                 AND x.month = CAST(c.m - INTERVAL (k.k) MONTH AS DATE)
            LEFT JOIN normal n ON n.rx = x.rx AND n.ry = x.ry AND n.mo = month(x.month)
            GROUP BY ALL)""")
        select += ["CASE WHEN r.months = 3 THEN r.rain3 END AS rain3",
                   "CASE WHEN r.months = 3 THEN r.rain3_normal END AS rain3_normal",
                   "CASE WHEN r.months = 3 THEN CAST(ev.m - INTERVAL 2 MONTH AS DATE) END AS rain_from",
                   "CASE WHEN r.months = 3 THEN ev.m END AS rain_to"]
        joins.append("LEFT JOIN r USING (hotspots, event)")
    else:
        select += ["NULL::DOUBLE AS rain3", "NULL::DOUBLE AS rain3_normal", "NULL::DATE AS rain_from",
                   "NULL::DATE AS rain_to"]
    if "climate" in have:
        select += ["k.oni", "k.dmi"]
        joins.append("LEFT JOIN ctx_climate k ON k.month = ev.m")
    else:
        select += ["NULL::DOUBLE AS oni", "NULL::DOUBLE AS dmi"]
    return (",\n".join(parts) + f"\nSELECT {', '.join(select)} FROM ev {' '.join(joins)}")


def build(con: duckdb.DuckDBPyConnection, dest: Path, context_root: Path | None = None) -> dict[str, int]:
    """Writes `event_attribution.parquet`: the evidence, cause, confidence and points of every
    event. Returns the event count per cause."""
    have = _context_views(con, context_root)
    rows = con.execute(features_sql(have)).fetchall()
    cols = ["hotspots", "event", *EVIDENCE]
    order = [c[0] for c in con.description]
    counts = dict.fromkeys(CATEGORIES, 0)
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(".csv")
    with tmp.open("w", newline="") as f:
        out = csv.writer(f)
        out.writerow([c for c, _ in _types()])
        for r in rows:
            e = dict(zip(order, r))
            res = evaluate(e)
            counts[res["category"]] += 1
            out.writerow(["" if v is None else v for v in (*(e[c] for c in cols), res["category"],
                                                           res["confidence"], *res["scores"].values())])
    types = ", ".join(f"'{c}': '{t}'" for c, t in _types())
    con.execute(f"COPY (SELECT * FROM read_csv({quote(str(tmp))}, header=true, nullstr='', columns={{{types}}})) "
                f"TO {quote(str(dest))} (FORMAT parquet, COMPRESSION zstd)")
    tmp.unlink()
    log.info("attribution from %s: %s", ", ".join(sorted(have)) or "no context", counts)
    return counts


def _types() -> list[tuple[str, str]]:
    """Columns of `event_attribution.parquet` with their DuckDB types."""
    ints = {"event", "year", "cells", "duration_days", "loss_from", "loss_to", "landcover_year"}
    cols = [("hotspots", "VARCHAR")]
    for c in ("event", *EVIDENCE):
        cols.append((c, "BIGINT" if c in ints else "DATE" if c in ("month", "rain_from", "rain_to")
                     else "VARCHAR" if c == "island_group" else "DOUBLE"))
    return cols + [("category", "VARCHAR"), ("confidence", "VARCHAR"),
                   *((f"score_{c}", "INTEGER") for c in CATEGORIES[:3])]


def _r(v, digits: int = 4):
    return None if v is None else round(float(v), digits)


def describe(e: dict) -> dict:
    """The attribution of one stored row (columns of `event_attribution.parquet`) as served by
    `/api/events`: cause, confidence, points, every indicator and the cited evidence."""
    res = evaluate(e)
    rain_ratio = (e["rain3"] / e["rain3_normal"]) if e.get("rain3") is not None and e.get("rain3_normal") else None
    landcover = None
    if e.get("landcover_year") is not None:
        landcover = {"year": e["landcover_year"], "source": "mcd12q1",
                     "shares": {k: _r(e[k], 3) for k in GROUPS}}
    return {
        "category": res["category"],
        "label": LABELS[res["category"]],
        "confidence": res["confidence"],
        "scores": res["scores"],
        "indicators": res["indicators"],
        "evidence": {
            "forest_cover_2000": None if e.get("forest2000") is None else
            {"share": _r(e["forest2000"], 3), "canopy_min_percent": CANOPY_MIN, "source": "hansen2013"},
            "forest_loss": None if e.get("forest_loss") is None else
            {"share": _r(e["forest_loss"]), "expected_share": _r(e["forest_loss_expected"]),
             "excess_share": _r(excess_loss(e)), "years": [e["loss_from"], e["loss_to"]], "source": "hansen2013"},
            "landcover": landcover,
            "peat": None if e.get("peat") is None else {"share": _r(e["peat"], 3), "source": "gumbricht2017"},
            "rainfall": None if e.get("rain3") is None else
            {"mm_per_day": _r(e["rain3"], 2), "normal_mm_per_day": _r(e["rain3_normal"], 2),
             "share_of_normal": _r(rain_ratio, 3), "months": [str(e["rain_from"])[:7], str(e["rain_to"])[:7]],
             "normal_years": list(RAIN_NORMAL), "source": "imerg"},
            "climate": None if e.get("oni") is None and e.get("dmi") is None else
            {"month": str(e["month"])[:7],
             "oni": _r(e.get("oni"), 2), "dmi": _r(e.get("dmi"), 2), "sources": ["oni", "saji1999"]},
        },
    }


def method() -> dict:
    """The rules, thresholds, sources and disclaimer, for `/api/attribution`."""
    return {
        "disclaimer": DISCLAIMER,
        "categories": [{"id": c, "label": LABELS[c], "max_points": MAX_POINTS.get(c)} for c in CATEGORIES],
        "min_points": MIN_POINTS,
        "confidence": {
            "high": "at least 75% of the cause's maximum points and at least 2 points ahead of any other cause",
            "medium": "at least 50% of the maximum points and at least 1 point ahead",
            "low": "named, but with less support than medium",
        },
        "indicators": [{"id": i.id, "category": i.category, "points": i.points, "key": i.key, "text": i.text,
                        "sources": list(i.sources)} for i in INDICATORS],
        "wildfire_also_needs": "burnable land: peat >= 30% or natural vegetation >= 50% the year before, "
                               "cleared or not",
        "sources": SOURCES,
        "doc": "docs/attribution.md",
    }


def has_context() -> bool:
    """Whether any context layer exists."""
    return bool(context.layer_sql())


def run() -> None:
    """Rebuilds `event_attribution.parquet` from the events and the context tables."""
    from .harmonise import weights
    con = store.connect(weights.load_params())
    if not store.has(con, "events", "event_cells"):
        raise RuntimeError("Fire events are missing. Run `python -m app cache` first.")
    build(con, attribution_path())
