"""Boundary outlines, a label raster for fast point lookups, and polygon helpers.

The boundary file is the one the dashboard draws (geoBoundaries outlines of Indonesia, its
provinces and its cities/regencies). Lookups go through a 0.01° label raster filled by scanline at
raster-cell centres. A 0.05° grid cell centre, `(cx + 0.5) * 0.05`, is always a 0.01° raster-cell
centre, so "which outline contains this cell centre" is answered exactly, not approximately.
"""

from __future__ import annotations

import json
import math
from array import array
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

from . import config

Ring = list[tuple[float, float]]


@dataclass(frozen=True)
class Boundary:
    """One outline from the boundary file."""

    id: str
    name: str
    level: str
    parent_id: str | None
    rings: tuple[Ring, ...]


def load_boundaries(path: Path | None = None) -> list[Boundary]:
    """Every outline in the boundary file, rings as (lon, lat) tuples."""
    doc = json.loads((path or config.boundaries_path()).read_text(encoding="utf-8"))
    out = []
    for f in doc["features"]:
        p, g = f["properties"], f["geometry"]
        polys = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
        rings = tuple([(float(x), float(y)) for x, y in ring] for poly in polys for ring in poly)
        out.append(Boundary(p["id"], p["name"], p["level"], p.get("parentId"), rings))
    return out


def load_areas(path: Path | None = None) -> list[tuple[str, str | None]]:
    """(id, parent id) of every outline in the boundary file, without reading geometry."""
    doc = json.loads((path or config.boundaries_path()).read_text(encoding="utf-8"))
    return [(f["properties"]["id"], f["properties"].get("parentId")) for f in doc["features"]]


def point_in_rings(lon: float, lat: float, rings: tuple[Ring, ...] | list[Ring]) -> bool:
    """Even-odd ray casting over all rings, so holes are respected."""
    inside = False
    for ring in rings:
        n = len(ring)
        j = n - 1
        for i in range(n):
            xi, yi = ring[i]
            xj, yj = ring[j]
            if (yi > lat) != (yj > lat) and lon < (xj - xi) * (lat - yi) / (yj - yi) + xi:
                inside = not inside
            j = i
    return inside


class LabelRaster:
    """A grid over the Indonesia bounding box holding a small integer label per cell (0 = none)."""

    def __init__(self, res: float = 0.01, bbox: tuple[float, float, float, float] = config.INDONESIA_BBOX):
        self.res = res
        self.west, self.south, east, north = bbox
        self.width = int(round((east - self.west) / res))
        self.height = int(round((north - self.south) / res))
        self.cells = array("H", bytes(2 * self.width * self.height))

    def index(self, lon: float, lat: float) -> tuple[int, int]:
        return math.floor((lon - self.west) / self.res), math.floor((lat - self.south) / self.res)

    def fill(self, rings: tuple[Ring, ...], label: int) -> None:
        """Sets `label` on every cell whose centre lies inside the rings (even-odd rule)."""
        res, south, west = self.res, self.south, self.west
        crossings: dict[int, list[float]] = defaultdict(list)
        for ring in rings:
            n = len(ring)
            for i in range(n):
                x1, y1 = ring[i - 1]
                x2, y2 = ring[i]
                if y1 == y2:
                    continue
                lo, hi = (y1, y2) if y1 < y2 else (y2, y1)
                first = max(0, math.ceil((lo - south) / res - 0.5))
                last = min(self.height - 1, math.ceil((hi - south) / res - 0.5) - 1)
                slope = (x2 - x1) / (y2 - y1)
                for iy in range(first, last + 1):
                    y = south + (iy + 0.5) * res
                    crossings[iy].append(x1 + (y - y1) * slope)
        for iy, xs in crossings.items():
            xs.sort()
            row = iy * self.width
            for k in range(0, len(xs) - 1, 2):
                a = max(0, math.ceil((xs[k] - west) / res - 0.5))
                b = min(self.width - 1, math.floor((xs[k + 1] - west) / res - 0.5))
                if b >= a:
                    self.cells[row + a: row + b + 1] = array("H", [label]) * (b - a + 1)

    def at(self, lon: float, lat: float) -> int:
        ix, iy = self.index(lon, lat)
        if 0 <= ix < self.width and 0 <= iy < self.height:
            return self.cells[iy * self.width + ix]
        return 0

    def nearest(self, lon: float, lat: float, max_deg: float) -> int:
        """Label of the nearest labelled cell centre within `max_deg`, or 0. Accurate to one cell."""
        ix0, iy0 = self.index(lon, lat)
        reach = math.ceil(max_deg / self.res)
        best, best_d = 0, max_deg
        for r in range(0, reach + 1):
            if (r - 1) * self.res > best_d:
                break
            for ix, iy in _square_ring(ix0, iy0, r):
                if 0 <= ix < self.width and 0 <= iy < self.height:
                    v = self.cells[iy * self.width + ix]
                    if v:
                        d = math.hypot(self.west + (ix + 0.5) * self.res - lon, self.south + (iy + 0.5) * self.res - lat)
                        if d <= best_d:
                            best, best_d = v, d
        return best

    def spans(self, dilate: int = 0) -> list[tuple[int, int, int]]:
        """Runs of labelled cells as (iy, ix_from, ix_to), optionally grown by `dilate` cells."""
        runs: dict[int, list[tuple[int, int]]] = defaultdict(list)
        w = self.width
        for iy in range(self.height):
            row = self.cells[iy * w:(iy + 1) * w]
            ix = 0
            while ix < w:
                if row[ix]:
                    start = ix
                    while ix < w and row[ix]:
                        ix += 1
                    for dy in range(-dilate, dilate + 1):
                        if 0 <= iy + dy < self.height:
                            runs[iy + dy].append((max(0, start - dilate), min(w - 1, ix - 1 + dilate)))
                else:
                    ix += 1
        out = []
        for iy in sorted(runs):
            merged: list[list[int]] = []
            for a, b in sorted(runs[iy]):
                if merged and a <= merged[-1][1] + 1:
                    merged[-1][1] = max(merged[-1][1], b)
                else:
                    merged.append([a, b])
            out += [(iy, a, b) for a, b in merged]
        return out


def _square_ring(cx: int, cy: int, r: int):
    if r == 0:
        yield cx, cy
        return
    for dx in range(-r, r + 1):
        yield cx + dx, cy - r
        yield cx + dx, cy + r
    for dy in range(-r + 1, r):
        yield cx - r, cy + dy
        yield cx + r, cy + dy


def rasterise(boundaries: list[Boundary], level: str) -> tuple[LabelRaster, list[Boundary]]:
    """Label raster of every outline at one level; label i + 1 is `items[i]`."""
    items = [b for b in boundaries if b.level == level]
    raster = LabelRaster()
    for i, b in enumerate(items):
        raster.fill(b.rings, i + 1)
    return raster, items


def parse_polygon(text: str) -> Ring:
    """Parses "lon,lat;lon,lat;..." into a ring of at least three valid corners."""
    ring: Ring = []
    for pair in text.split(";"):
        lon_s, _, lat_s = pair.partition(",")
        lon, lat = float(lon_s), float(lat_s)
        if not (math.isfinite(lon) and math.isfinite(lat) and abs(lon) <= 180 and abs(lat) <= 90):
            raise ValueError("polygon corner out of range")
        ring.append((lon, lat))
    if len(ring) < 3:
        raise ValueError("a polygon needs at least three corners")
    if len(ring) > 500:
        raise ValueError("a polygon may have at most 500 corners")
    twice_area = sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]))
    if twice_area == 0:
        raise ValueError("the polygon has no area (its corners lie on one line)")
    return ring
