"""Fire events: active cell-days of the harmonised record grouped in space and time.

Rule: two active cell-days belong to the same event when their cells touch (the same cell or one
of its 8 neighbours on the 0.05° grid) and their local days are at most one day apart. Events are
the connected groups under that rule (union-find).

Descriptors per event:

- **time:** first and last day, duration, peak day (the earliest of equally active days);
- **space:** number of distinct cells, centroid weighted by harmonised value, bounding box, and
  the city/regency and province holding most of it (ties go to the first id alphabetically);
- **intensity:** harmonised cell-days, qualifying pixels, maximum pixel fire radiative power.
"""

from __future__ import annotations

import datetime as dt
import logging
from pathlib import Path

import duckdb

from .. import config, store
from ..db import quote
from ..harmonise import weights

log = logging.getLogger("app.events")

#: Maximum gap, in days, between linked cell-days.
MAX_GAP_DAYS = 1
NEIGHBOURS = [(dx, dy) for dx in (-1, 0, 1) for dy in (-1, 0, 1)]


def events_path() -> Path:
    return config.derived_dir() / "events.parquet"


def label(rows: list[tuple[dt.date, int, int]]) -> list[int]:
    """Event label per row for rows sorted by day. Labels are 0..n-1 in order of first appearance."""
    parent = list(range(len(rows)))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    recent: dict[dt.date, dict[tuple[int, int], int]] = {}
    for i, (d, cx, cy) in enumerate(rows):
        today = recent.setdefault(d, {})
        for g in range(0, MAX_GAP_DAYS + 1):
            cells = recent.get(d - dt.timedelta(days=g))
            if not cells:
                continue
            for dx, dy in NEIGHBOURS:
                j = cells.get((cx + dx, cy + dy))
                if j is not None:
                    a, b = find(i), find(j)
                    if a != b:
                        parent[max(a, b)] = min(a, b)
        today[(cx, cy)] = i
        for old in [k for k in recent if (d - k).days > MAX_GAP_DAYS]:
            del recent[old]
    ids: dict[int, int] = {}
    return [ids.setdefault(find(i), len(ids)) for i in range(len(rows))]


def build(con: duckdb.DuckDBPyConnection, dest: Path) -> int:
    """Labels the record's active cell-days and writes one row per event; returns the event count."""
    w = weights.weight_sql("all")
    n = weights.pixels_sql("all")
    con.execute(f"""
        CREATE OR REPLACE TEMP TABLE active AS
        SELECT row_number() OVER (ORDER BY c.local_date, c.cx, c.cy) - 1 AS i,
               c.local_date, c.cx, c.cy, {w} AS w, {n} AS px, c.frp_max, c.province_id, c.regency_id
        FROM ({weights.record_sql()}) c
        WHERE {n} > 0
    """)
    rows = con.execute("SELECT local_date, cx, cy FROM active ORDER BY i").fetchall()
    labels = label(rows)
    tmp = dest.with_suffix(".labels.csv")
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp.write_text("event\n" + "\n".join(map(str, labels)) + "\n")
    g = config.GRID
    con.execute(f"""
        CREATE OR REPLACE TEMP TABLE labelled AS
        SELECT a.*, l.event FROM active a
        JOIN (SELECT row_number() OVER () - 1 AS i, event FROM read_csv({quote(str(tmp))}, header=true)) l USING (i)
    """)
    con.execute(f"""
        COPY (
            WITH e AS (
                SELECT event,
                       min(local_date) AS start, max(local_date) AS "end",
                       count(DISTINCT (cx, cy)) AS cells, count(*) AS cell_days,
                       sum(w) AS harmonised, sum(px) AS pixels, max(frp_max) AS frp_max,
                       sum(w * (cx + 0.5) * {g}) / sum(w) AS lon, sum(w * (cy + 0.5) * {g}) / sum(w) AS lat,
                       min(cx) * {g} AS west, min(cy) * {g} AS south, (max(cx) + 1) * {g} AS east, (max(cy) + 1) * {g} AS north
                FROM labelled GROUP BY event
            ),
            peak AS (
                SELECT event, first(local_date ORDER BY s DESC, local_date) AS peak_day FROM (
                    SELECT event, local_date, round(sum(w), 9) AS s FROM labelled GROUP BY ALL) GROUP BY event
            ),
            regency AS (
                SELECT event, first(regency_id ORDER BY s DESC, regency_id) AS regency_id FROM (
                    SELECT event, regency_id, round(sum(w), 9) AS s FROM labelled GROUP BY ALL) GROUP BY event
            ),
            province AS (
                SELECT event, first(province_id ORDER BY s DESC, province_id) AS province_id FROM (
                    SELECT event, province_id, round(sum(w), 9) AS s FROM labelled GROUP BY ALL) GROUP BY event
            )
            SELECT e.*, datediff('day', e.start, e."end") + 1 AS duration_days, peak.peak_day,
                   regency.regency_id, province.province_id
            FROM e JOIN peak USING (event) JOIN regency USING (event) JOIN province USING (event)
            ORDER BY harmonised DESC
        ) TO {quote(str(dest))} (FORMAT parquet, COMPRESSION zstd)
    """)
    tmp.unlink()
    return con.execute(f"SELECT count(*) FROM read_parquet({quote(str(dest))})").fetchone()[0]


def run() -> None:
    """Rebuilds `events.parquet` from the harmonised record."""
    con = store.connect(weights.load_params())
    log.info("fire events: %d", build(con, events_path()))
