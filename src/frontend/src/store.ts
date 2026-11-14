import { toDay } from "./dates";
import { RegionIndex } from "./regions";
import type { Dataset, Filters, Hotspot, LngLat } from "./types";

export interface Selection {
  /** Detections inside the selected area and date range. */
  items: Hotspot[];
  /** Daily detection counts for the selected area over the whole record, indexed from `firstDay`. */
  daily: Int32Array;
  firstDay: number;
  lastDay: number;
  /** Selected date range as day numbers, clamped to the record. */
  from: number;
  to: number;
}

/** Ray-casting test for a point inside a closed ring of [lon, lat] vertices. */
export function pointInPolygon(lon: number, lat: number, ring: LngLat[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Holds the dataset with precomputed day numbers and answers filter queries. */
export class HotspotStore {
  readonly regions: RegionIndex;
  readonly firstDay: number;
  readonly lastDay: number;
  private readonly days: Int32Array;
  private readonly lineage = new Map<string, string[]>();

  constructor(readonly data: Dataset) {
    this.regions = new RegionIndex(data.regions);
    this.firstDay = toDay(data.start);
    this.lastDay = toDay(data.end);
    this.days = Int32Array.from(data.hotspots, (h) => toDay(h.date));
    for (const r of data.regions) this.lineage.set(r.id, this.regions.lineage(r.id));
  }

  /** Applies the area or polygon filter, then the date range. */
  select(f: Filters): Selection {
    const inArea = this.areaTest(f);
    const length = this.lastDay - this.firstDay + 1;
    const daily = new Int32Array(length);
    const from = Math.max(this.firstDay, toDay(f.start));
    const to = Math.min(this.lastDay, toDay(f.end));
    const items: Hotspot[] = [];
    const hs = this.data.hotspots;
    for (let i = 0; i < hs.length; i++) {
      if (!inArea(hs[i])) continue;
      const d = this.days[i];
      daily[d - this.firstDay]++;
      if (d >= from && d <= to) items.push(hs[i]);
    }
    return { items, daily, firstDay: this.firstDay, lastDay: this.lastDay, from, to };
  }

  private areaTest(f: Filters): (h: Hotspot) => boolean {
    if (f.mode === "polygon") {
      const ring = f.polygon;
      if (!ring || ring.length < 3) return () => true;
      const xs = ring.map((p) => p[0]);
      const ys = ring.map((p) => p[1]);
      const [w, e, s, n] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
      return (h) => h.lon >= w && h.lon <= e && h.lat >= s && h.lat <= n && pointInPolygon(h.lon, h.lat, ring);
    }
    if (f.regionIds.length === 0) return () => true;
    const wanted = new Set(f.regionIds);
    return (h) => (this.lineage.get(h.regionId) ?? []).some((id) => wanted.has(id));
  }
}

export interface Cell {
  lon: number;
  lat: number;
  count: number;
  /** Region holding most of the cell's detections. */
  regionId: string;
}

/** Centre, count and dominant region of the grid cell (default 0.25 degrees) with the most detections, or null when empty. */
export function hottestCell(items: Hotspot[], size = 0.25): Cell | null {
  const bins = new Map<string, number>();
  let best: string | null = null;
  let bestCount = 0;
  for (const h of items) {
    const key = `${Math.floor(h.lon / size)},${Math.floor(h.lat / size)}`;
    const n = (bins.get(key) ?? 0) + 1;
    bins.set(key, n);
    if (n > bestCount) {
      bestCount = n;
      best = key;
    }
  }
  if (!best) return null;
  const [x, y] = best.split(",").map(Number);
  const perRegion = new Map<string, number>();
  let regionId = "";
  for (const h of items) {
    if (Math.floor(h.lon / size) !== x || Math.floor(h.lat / size) !== y) continue;
    const n = (perRegion.get(h.regionId) ?? 0) + 1;
    perRegion.set(h.regionId, n);
    if (n > (perRegion.get(regionId) ?? 0)) regionId = h.regionId;
  }
  return { lon: (x + 0.5) * size, lat: (y + 0.5) * size, count: bestCount, regionId };
}
