import { fromDay, parts, toDay } from "./dates";
import type { Shapes } from "./regions";
import { pointInPolygon } from "./store";
import type { Confidence, Dataset, Hotspot, LngLat, Region } from "./types";

export const DUMMY_START = "2012-01-01";
export const DUMMY_END = "2025-12-31";

/** Relative fire activity per year, loosely shaped like El Nino and La Nina years. Applied mostly to the dry season. */
const YEAR_FACTOR: Record<number, number> = {
  2012: 1.2, 2013: 1.1, 2014: 2.0, 2015: 5.5, 2016: 0.6, 2017: 0.5, 2018: 1.0,
  2019: 3.2, 2020: 0.5, 2021: 0.6, 2022: 0.5, 2023: 2.1, 2024: 1.3, 2025: 0.9,
};

/** Seasonal profiles by month, January first. */
const SEASON: Record<string, number[]> = {
  riau: [0.25, 0.55, 0.6, 0.2, 0.15, 0.4, 0.8, 1.0, 0.9, 0.35, 0.1, 0.1],
  sumatra: [0.05, 0.05, 0.08, 0.08, 0.1, 0.2, 0.45, 0.8, 1.0, 0.85, 0.2, 0.05],
  kalimantan: [0.03, 0.03, 0.05, 0.05, 0.08, 0.15, 0.4, 0.9, 1.0, 0.8, 0.15, 0.03],
  south: [0.02, 0.02, 0.03, 0.05, 0.1, 0.25, 0.55, 0.85, 1.0, 0.75, 0.2, 0.03],
  papua: [0.05, 0.05, 0.05, 0.05, 0.08, 0.12, 0.25, 0.5, 0.85, 1.0, 0.7, 0.15],
};

function seasonFor(province: string): number[] {
  if (province === "Riau") return SEASON.riau;
  if (/Kalimantan/.test(province)) return SEASON.kalimantan;
  if (/Papua/.test(province)) return SEASON.papua;
  if (/Java|Bali|Nusa Tenggara|Sulawesi|Yogyakarta|Jakarta|Banten|Maluku/.test(province)) return SEASON.south;
  return SEASON.sumatra;
}

/** Peak-season detections per day for a whole province in an average year. Peatland provinces burn most. */
const PROVINCE_FIRES: Record<string, number> = {
  "Central Kalimantan": 6, Riau: 5, "South Sumatra": 5, "West Kalimantan": 4.5, Jambi: 3,
  "South Kalimantan": 2.2, "East Kalimantan": 2.2, Papua: 2, "East Nusa Tenggara": 1.2,
  Lampung: 1.1, "North Sumatra": 0.8, "Bangka-Belitung Islands": 0.8, "North Kalimantan": 0.8,
  "West Papua": 0.6, Aceh: 0.6, "South Sulawesi": 0.6, "Southeast Sulawesi": 0.6, "West Nusa Tenggara": 0.6,
};
const DEFAULT_FIRES = 0.15;

function ringArea(ring: LngLat[]): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  return Math.abs(a / 2);
}

function inShape(lon: number, lat: number, rings: LngLat[][]): boolean {
  return rings.some((r) => pointInPolygon(lon, lat, r));
}

/** Small seeded PRNG (mulberry32) so every load produces the same dummy data. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand: () => number): number {
  const u = Math.max(rand(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

function poisson(lambda: number, rand: () => number): number {
  if (lambda <= 0) return 0;
  if (lambda > 30) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * gaussian(rand)));
  const limit = Math.exp(-lambda);
  let k = 0;
  let p = rand();
  while (p > limit) {
    k++;
    p *= rand();
  }
  return k;
}

function pickConfidence(rand: () => number): Confidence {
  const r = rand();
  return r < 0.15 ? "low" : r < 0.75 ? "nominal" : "high";
}

interface Unit {
  region: Region;
  rings: LngLat[][];
  share: number;
  clusters: [number, number, number][];
}

/** A random point inside the shape, found by sampling its bounding box. */
function pointIn(r: Region, rings: LngLat[][], rand: () => number): [number, number] {
  const [w, s, e, n] = r.bbox;
  for (let i = 0; i < 60; i++) {
    const lon = w + (e - w) * rand();
    const lat = s + (n - s) * rand();
    if (inShape(lon, lat, rings)) return [lon, lat];
  }
  return rings[0][0];
}

/**
 * Generates deterministic dummy hotspots inside the real outline of every city/regency, shaped like the merged
 * MODIS and VIIRS record: province fire seasons, strong and weak fire years, multi-day episodes and clustered fires.
 */
export function generateDummy(regions: Region[], shapes: Shapes, seed = 2015): Dataset {
  const rand = rng(seed);
  const start = toDay(DUMMY_START);
  const end = toDay(DUMMY_END);
  const days = end - start + 1;
  const monthOf = new Uint8Array(days);
  const yearOf = new Uint16Array(days);
  for (let d = 0; d < days; d++) {
    const p = parts(start + d);
    monthOf[d] = p.month;
    yearOf[d] = p.year;
  }

  const provinces = regions.filter((r) => r.level === "province");
  const groups = provinces.map((prov) => {
    const units: Unit[] = regions
      .filter((r) => r.level === "regency" && r.parentId === prov.id)
      .map((region) => {
        const rings = shapes.get(region.id) ?? [];
        const spread = Math.min(region.bbox[2] - region.bbox[0], region.bbox[3] - region.bbox[1]) * 0.12;
        const clusters = Array.from({ length: 4 }, () => [...pointIn(region, rings, rand), spread * (0.5 + rand())] as [number, number, number]);
        return { region, rings, share: rings.reduce((a, r) => a + ringArea(r), 0), clusters };
      })
      .filter((u) => u.rings.length);
    const total = units.reduce((a, u) => a + u.share, 0) || 1;
    units.forEach((u) => (u.share /= total));
    return { units, season: seasonFor(prov.name), fires: PROVINCE_FIRES[prov.name] ?? DEFAULT_FIRES, episode: 0 };
  });

  const hotspots: Hotspot[] = [];
  for (let d = 0; d < days; d++) {
    const month = monthOf[d];
    const yearFactor = YEAR_FACTOR[yearOf[d]] ?? 1;
    let date = "";
    for (const g of groups) {
      g.episode = 0.85 * g.episode + 0.5 * gaussian(rand);
      const seasonal = g.season[month];
      const provinceLambda = g.fires * seasonal * yearFactor ** seasonal * Math.exp(g.episode);
      for (const u of g.units) {
        const n = poisson(provinceLambda * u.share, rand);
        if (n === 0) continue;
        date ||= fromDay(start + d);
        for (let i = 0; i < n; i++) {
          const c = u.clusters[Math.floor(rand() * u.clusters.length)];
          let lon = c[0];
          let lat = c[1];
          for (let t = 0; t < 4; t++) {
            const x = c[0] + gaussian(rand) * c[2];
            const y = c[1] + gaussian(rand) * c[2];
            if (inShape(x, y, u.rings)) {
              lon = x;
              lat = y;
              break;
            }
          }
          const sensor = rand() < 0.68 ? "VIIRS" : "MODIS";
          hotspots.push({
            id: hotspots.length,
            lon: Math.round(lon * 1e4) / 1e4,
            lat: Math.round(lat * 1e4) / 1e4,
            date,
            sensor,
            confidence: pickConfidence(rand),
            frp: Math.round(Math.exp(2.2 + 0.9 * gaussian(rand)) * (sensor === "MODIS" ? 1.6 : 1) * 10) / 10,
            regionId: u.region.id,
          });
        }
      }
    }
  }
  return { hotspots, regions, start: DUMMY_START, end: DUMMY_END };
}
