"""Experimental fire spread simulation from one location (see `docs/fire-spread.md`).

An empirical (analogue) model: the chance that a fire starting in a cell reaches each surrounding
cell by each day is the share of past fire events, started in the same calendar month, that reached
a cell at that distance with the same fire history. Everything is counted from the record of the
VIIRS era (from `config.SPLICE`); no wind, fuel, slope or rain data, and no rule of how fire moves,
are assumed.

**Fire event.** Active cells of the record that touch (the 8 neighbours on the 0.05° grid) and are
at most one day apart, the rule of `pipeline.events`. An event starts at its first active cell on
its first day; when several cells start it, the first in grid order.

**Table.** For a sample of `TRAIN_EVENTS` past events, every land cell within `WINDOW` cells of the
start cell is one trial, classed by

- its Chebyshev distance d (1 to `WINDOW`) from the start cell,
- its history class b, `floor(log2(1 + n))` capped at `HISTORY_CLASSES - 1`, where n is the number
  of days the cell was active over the estimation years (it stands in for fuel and land use; a
  cell never active is never reached),
- the calendar month m of the event's first day,

and the day it was first reached, if it was. `reach[m][b][d - 1][k]` is the share of trials reached
by day k (0 to `MAX_DAYS`).

**Two scenarios.** Most fires stay in one or two cells, so the table is also counted over the
sampled events that became large (`LARGE_CELLS` cells or more within `LARGE_DAYS` days): the
`large` scenario shows how such a fire spreads, and `share_large[m]` how often past fires of the
month became one.

**Simulation.** For a start cell and day, each land cell within `WINDOW` gets the reach share of its
(d, b, m) in each scenario; the expected footprint is their sum plus the start cell. `sizes` gives,
per scenario, month and day, the 50th and 90th percentile footprint of the sampled events.
"""

from __future__ import annotations

import datetime as dt
import json
import math
import random
from dataclasses import dataclass, field
from pathlib import Path

import duckdb

from . import config
from .harmonise import weights
from .pipeline import events as event_rule

WINDOW = 10
HISTORY_CLASSES = 8
MAX_DAYS = 30
TRAIN_EVENTS = 40000
#: A fire is large when it reaches this many cells within `LARGE_DAYS` days.
LARGE_CELLS = 5
LARGE_DAYS = 14
SCENARIOS = ("typical", "large")
#: Cells reached in fewer than this share of past events are left out of the response.
MIN_SHARE = 0.01
SEED = 11
#: Half-width, in cells, of the box searched for the observed progression of a fire.
OBSERVED_BOX = 40

ASSUMPTIONS = (
    "Fire moves on a 0.05 degree grid (about 5.5 km) by day; spread inside a cell is not resolved.",
    "The chance of reaching a cell is the share of past fires (VIIRS, 2012 onwards) that started in the same "
    "month and reached a cell at the same distance with the same fire history: a typical fire, not this one. "
    "The large-fire scenario uses only past fires that reached 5 or more cells within 14 days.",
    "No wind, fuel, slope or rain data are used, so a specific day's weather is not taken into account; "
    "past fires showed no preferred direction at this scale.",
    "A cell that never burned in the record is never reached; fire beyond 10 cells (about 55 km) is not shown.",
    "A fire event joins active cells that touch and are at most one day apart, so nearby ignitions that "
    "merge with the fire count as its spread.",
    "Satellites miss fire under cloud and smoke, so past footprints, and the chances drawn from them, are "
    "too small where clouds were frequent.",
)

Cell = tuple[int, int]


def model_path() -> Path:
    return config.derived_dir() / "spread_model.json"


def history_class(n: int) -> int:
    """History class of a cell active on n days."""
    return min(int(math.log2(1 + n)), HISTORY_CLASSES - 1)


def active_sql(years: list[int], hotspots: str = "vegetation") -> str:
    """Distinct active cell-days of the record in the VIIRS era, in the given years."""
    listing = ", ".join(str(y) for y in years) or "NULL"
    where = f"c.local_date >= DATE '{config.SPLICE}' AND year(c.local_date) IN ({listing})"
    return f"SELECT DISTINCT c.local_date AS d, c.cx, c.cy FROM ({weights.record_sql(where, hotspots)}) c"


def viirs_years(con: duckdb.DuckDBPyConnection) -> list[int]:
    """Complete calendar years of the VIIRS era in the record."""
    first, last = con.execute(f"SELECT min(local_date), max(local_date) FROM days "
                              f"WHERE local_date >= DATE '{config.SPLICE}'").fetchone()
    if first is None:
        return []
    return [y for y in range(first.year, last.year + 1) if first <= dt.date(y, 1, 1) and dt.date(y, 12, 31) <= last]


def histories(con: duckdb.DuckDBPyConnection, years: list[int], hotspots: str = "vegetation") -> dict[Cell, int]:
    """Days each land cell was active over the given years."""
    rows = con.execute(f"SELECT k.cx, k.cy, count(a.d) FROM cells k LEFT JOIN ({active_sql(years, hotspots)}) a "
                       f"USING (cx, cy) GROUP BY k.cx, k.cy").fetchall()
    return {(cx, cy): int(n) for cx, cy, n in rows}


def year_events(con: duckdb.DuckDBPyConnection, year: int, hotspots: str = "vegetation") -> list[dict]:
    """Fire events of the active cells of one year: first day, first cell and the day each cell was
    first reached (days 0 to `MAX_DAYS` after the start only)."""
    rows = con.execute(f"SELECT d, cx, cy FROM ({active_sql([year], hotspots)}) ORDER BY d, cx, cy").fetchall()
    labels = event_rule.label(rows)
    out: dict[int, dict] = {}
    for (d, cx, cy), lab in zip(rows, labels):
        e = out.get(lab)
        if e is None:
            e = out[lab] = {"start": d, "first": (cx, cy), "reached": {}}
        k = (d - e["start"]).days
        if k <= MAX_DAYS:
            e["reached"].setdefault((cx, cy), k)
    return list(out.values())


@dataclass
class Model:
    """Reach shares and footprint percentiles per scenario, with the cell histories they were
    counted with.

    `reach[s][m][b][d - 1][k]` is indexed by scenario, month - 1, history class, distance - 1 and
    day; `sizes[s][m][k]` is [50th, 90th percentile footprint] of the sampled events of the month;
    `trials[s][m][b][d - 1]` the number of cells each share is counted over; `share_large[m]` the
    share of sampled events of the month that became large."""

    years: list[int]
    reach: dict[str, list]
    sizes: dict[str, list]
    share_large: list[float]
    trials: dict[str, list] = field(default_factory=dict)
    history: dict[Cell, int] = field(default_factory=dict)

    def to_json(self) -> dict:
        return {"years": self.years, "reach": self.reach, "sizes": self.sizes, "share_large": self.share_large,
                "trials": self.trials}

    @classmethod
    def from_json(cls, doc: dict, history: dict[Cell, int]) -> "Model":
        return cls(doc["years"], doc["reach"], doc["sizes"], doc["share_large"], doc.get("trials", {}), history)


def is_large(e: dict) -> bool:
    """Whether an event reached `LARGE_CELLS` cells within `LARGE_DAYS` days."""
    return sum(1 for k in e["reached"].values() if k <= LARGE_DAYS) >= LARGE_CELLS


def _percentiles(s: list[int]) -> list[int]:
    if not s:
        return [1, 1]
    return [s[min(len(s) - 1, int(0.5 * len(s)))], s[min(len(s) - 1, int(0.9 * len(s)))]]


def _count(sample: list[dict], cls: dict[Cell, int]) -> tuple[list, list, list]:
    """Reach shares, footprint percentiles and trial counts over a set of events."""
    trials = [[[0] * WINDOW for _ in range(HISTORY_CLASSES)] for _ in range(12)]
    first = [[[[0] * (MAX_DAYS + 1) for _ in range(WINDOW)] for _ in range(HISTORY_CLASSES)] for _ in range(12)]
    size_lists: list[list[list[int]]] = [[[] for _ in range(MAX_DAYS + 1)] for _ in range(12)]
    for e in sample:
        m = e["start"].month - 1
        fx, fy = e["first"]
        reached = e["reached"]
        for dx in range(-WINDOW, WINDOW + 1):
            for dy in range(-WINDOW, WINDOW + 1):
                d = max(abs(dx), abs(dy))
                if d == 0:
                    continue
                c = (fx + dx, fy + dy)
                b = cls.get(c)
                if b is None:
                    continue
                trials[m][b][d - 1] += 1
                k = reached.get(c)
                if k is not None:
                    first[m][b][d - 1][k] += 1
        days = sorted(reached.values())
        j = 0
        for k in range(MAX_DAYS + 1):
            while j < len(days) and days[j] <= k:
                j += 1
            size_lists[m][k].append(j)
    reach = [[[[0.0] * (MAX_DAYS + 1) for _ in range(WINDOW)] for _ in range(HISTORY_CLASSES)] for _ in range(12)]
    for m in range(12):
        for b in range(HISTORY_CLASSES):
            for d in range(WINDOW):
                t = trials[m][b][d]
                cum = 0
                for k in range(MAX_DAYS + 1):
                    cum += first[m][b][d][k]
                    reach[m][b][d][k] = round(cum / t, 6) if t else 0.0
    sizes = [[_percentiles(sorted(size_lists[m][k])) for k in range(MAX_DAYS + 1)] for m in range(12)]
    return reach, sizes, trials


def fit(evts: list[dict], history: dict[Cell, int], years: list[int], n: int = TRAIN_EVENTS,
        seed: int = SEED) -> Model:
    """Counts both scenarios over a sample of `n` events, and the large one over up to `n` large
    events, with cell histories `history`."""
    rng = random.Random(seed)
    sample = evts if len(evts) <= n else rng.sample(evts, n)
    large = [e for e in evts if is_large(e)]
    large = large if len(large) <= n else rng.sample(large, n)
    cls = {c: history_class(v) for c, v in history.items()}
    out = {"typical": _count(sample, cls), "large": _count(large, cls)}
    per_month = [[0, 0] for _ in range(12)]
    for e in sample:
        per_month[e["start"].month - 1][0] += 1
        per_month[e["start"].month - 1][1] += is_large(e)
    share = [round(b / a, 4) if a else 0.0 for a, b in per_month]
    return Model(years, {s: v[0] for s, v in out.items()}, {s: v[1] for s, v in out.items()}, share,
                 {s: v[2] for s, v in out.items()}, history)


def estimate(con: duckdb.DuckDBPyConnection, years: list[int], hotspots: str = "vegetation",
             evts: dict[int, list[dict]] | None = None, seed: int = SEED) -> Model:
    """The model of the given years; `evts` may hold their events already, keyed by year."""
    pool = [e for y in years for e in (evts[y] if evts and y in evts else year_events(con, y, hotspots))]
    return fit(pool, histories(con, years, hotspots), years, seed=seed)


def build(con: duckdb.DuckDBPyConnection, path: Path | None = None, hotspots: str = "vegetation") -> Model:
    """Counts the model over every complete VIIRS-era year and writes it as JSON."""
    model = estimate(con, viirs_years(con), hotspots)
    path = path or model_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".part")
    tmp.write_text(json.dumps(model.to_json()), encoding="utf-8")
    tmp.replace(path)
    return model


def load(con: duckdb.DuckDBPyConnection, path: Path | None = None, hotspots: str = "vegetation") -> Model | None:
    """The stored model with the cell histories of its years, or None when it has not been built."""
    path = path or model_path()
    if not path.is_file():
        return None
    doc = json.loads(path.read_text(encoding="utf-8"))
    return Model.from_json(doc, histories(con, doc["years"], hotspots))


def chances(model: Model, origin: Cell, start: dt.date, days: int, scenario: str = "typical") -> dict[Cell, list[float]]:
    """Per land cell within `WINDOW` of the origin, the chance of being reached by each day 1 to
    `days` in a scenario (1 for the origin itself). Empty when the origin is not a land cell."""
    m = start.month - 1
    reach = model.reach[scenario]
    if origin not in model.history:
        return {}
    out: dict[Cell, list[float]] = {origin: [1.0] * days}
    for dx in range(-WINDOW, WINDOW + 1):
        for dy in range(-WINDOW, WINDOW + 1):
            d = max(abs(dx), abs(dy))
            c = (origin[0] + dx, origin[1] + dy)
            if d == 0 or c not in model.history:
                continue
            row = reach[m][history_class(model.history[c])][d - 1]
            out[c] = [row[k] for k in range(1, days + 1)]
    return out


def cell_of(lon: float, lat: float) -> Cell:
    return math.floor(lon / config.GRID), math.floor(lat / config.GRID)


def centre(c: Cell) -> tuple[float, float]:
    return round((c[0] + 0.5) * config.GRID, 4), round((c[1] + 0.5) * config.GRID, 4)


def km2(cells: float, lat: float) -> float:
    """Area of `cells` grid cells at latitude `lat`, in square kilometres."""
    side = config.GRID * 111.32
    return cells * side * side * math.cos(math.radians(lat))


def _scenario(model: Model, origin: Cell, start: dt.date, days: int, scenario: str, lat: float) -> dict:
    """Footprint per day and chance per cell of one scenario."""
    ch = chances(model, origin, start, days, scenario)
    m = start.month - 1
    footprint = []
    for k in range(days):
        cells = sum(row[k] for row in ch.values())
        p50, p90 = model.sizes[scenario][m][k + 1]
        footprint.append({"day": k + 1, "date": str(start + dt.timedelta(days=k + 1)),
                          "expected_cells": round(cells, 2), "expected_km2": round(km2(cells, lat), 1),
                          "past_fires_cells_p50": p50, "past_fires_cells_p90": p90})
    shown = {c: row for c, row in ch.items() if max(row) >= MIN_SHARE}
    return {"footprint": footprint,
            "cells": {"lon": [centre(c)[0] for c in shown], "lat": [centre(c)[1] for c in shown],
                      "chance": [[round(p, 3) for p in row] for row in shown.values()]}}


def simulate(model: Model, origin: Cell, start: dt.date, days: int) -> dict:
    """The API form of a simulation: for the typical and the large-fire scenario, per day the
    expected footprint and the range of past fires of the month, and per cell the chance of being
    reached by each day."""
    lon, lat = centre(origin)
    n = model.history.get(origin)
    typical = _scenario(model, origin, start, days, "typical", lat)
    large = _scenario(model, origin, start, days, "large", lat)
    large["share_of_past_fires"] = model.share_large[start.month - 1]
    return {
        "origin": {"lon": lon, "lat": lat, "land": origin in model.history, "history_days": n,
                   "history_class": None if n is None else history_class(n)},
        "start": str(start), "days": days, "grid_deg": config.GRID, "window_cells": WINDOW,
        "method": {"model": "empirical analogue of past fire events", "large_fire_cells": LARGE_CELLS,
                   "large_fire_days": LARGE_DAYS,
                   "estimated_on": [model.years[0], model.years[-1]] if model.years else None},
        **typical,
        "large_fire": large,
        "assumptions": list(ASSUMPTIONS),
    }


def _active_box(con: duckdb.DuckDBPyConnection, centre_cell: Cell, first: dt.date, last: dt.date,
                hotspots: str = "vegetation") -> list[tuple[dt.date, int, int]]:
    """Active cell-days of the record in a box around a cell, sorted by day."""
    cx, cy = centre_cell
    where = (f"c.local_date BETWEEN DATE '{first}' AND DATE '{last}' "
             f"AND c.cx BETWEEN {cx - OBSERVED_BOX} AND {cx + OBSERVED_BOX} "
             f"AND c.cy BETWEEN {cy - OBSERVED_BOX} AND {cy + OBSERVED_BOX}")
    return con.execute(f"SELECT DISTINCT c.local_date, c.cx, c.cy FROM ({weights.record_sql(where, hotspots)}) c "
                       f"ORDER BY 1, 2, 3").fetchall()


def event_origin(con: duckdb.DuckDBPyConnection, event: int, hotspots: str = "vegetation") -> tuple[Cell, dt.date] | None:
    """Start cell and day of a fire event: of its cells active on its first day, the one nearest its
    weighted centre. None when the event does not exist."""
    row = con.execute(f"SELECT start, lon, lat FROM events WHERE hotspots = '{hotspots}' AND event = {int(event)}").fetchone()
    if row is None:
        return None
    start, lon, lat = row
    centre_cell = cell_of(lon, lat)
    day = [(cx, cy) for _, cx, cy in _active_box(con, centre_cell, start, start, hotspots)]
    if not day:
        return centre_cell, start
    return min(day, key=lambda c: (c[0] - centre_cell[0]) ** 2 + (c[1] - centre_cell[1]) ** 2), start


def observed(con: duckdb.DuckDBPyConnection, origin: Cell, start: dt.date, days: int,
             hotspots: str = "vegetation") -> dict[Cell, int] | None:
    """Day (0 to `days`) on which the fire active at `origin` on `start` first reached each cell, by
    the event rule. None when the origin was not active on `start`, or the period is not inside the
    record."""
    last = con.execute("SELECT max(local_date) FROM days").fetchone()[0]
    end = start + dt.timedelta(days=days)
    if end > last:
        return None
    rows = _active_box(con, origin, start, end, hotspots)
    if (start, *origin) not in rows:
        return None
    labels = event_rule.label(rows)
    mine = labels[rows.index((start, *origin))]
    out: dict[Cell, int] = {}
    for (d, cx, cy), lab in zip(rows, labels):
        if lab == mine:
            out.setdefault((cx, cy), (d - start).days)
    return out
