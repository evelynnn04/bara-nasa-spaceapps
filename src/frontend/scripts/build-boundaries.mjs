/**
 * Builds public/boundaries.geojson: Indonesia and every province and city/regency in it,
 * with ids, names, levels and parent ids, taken from geoBoundaries (gbOpen, simplified).
 * Cities/regencies are matched to the province that contains them, or the nearest one for a few coastal areas.
 *
 * Source: https://www.geoboundaries.org (github.com/wmgeolab/geoBoundaries, release 9469f09)
 * Licences: ADM0/ADM1 ODbL 1.0, ADM2 CC BY 3.0 IGO.
 *
 * Usage: node scripts/build-boundaries.mjs <folder with IDN-ADM0.geojson, IDN-ADM1.geojson and IDN-ADM2.geojson>
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const COUNTRIES = [{ iso: "IDN", id: "idn", name: "Indonesia" }];

const LEVELS = { ADM0: "country", ADM1: "province", ADM2: "regency" };

/** Island regencies whose nearest province border is not their province. */
const PARENT_OVERRIDES = { "Kepulauan Seribu": /jakarta/i };

/** Simplification tolerance in degrees: countries are seen zoomed out, regencies zoomed in. */
const TOLERANCE = { ADM0: 0.02, ADM1: 0.01, ADM2: 0.005 };

/** Rings smaller than this (square degrees) are dropped, e.g. tiny islets. */
const MIN_AREA = { ADM0: 0.004, ADM1: 0.002, ADM2: 0.0005 };

function perpDistance(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  if (dx === 0 && dy === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  return Math.abs(dy * p[0] - dx * p[1] + b[0] * a[1] - b[1] * a[0]) / Math.hypot(dx, dy);
}

/** Douglas-Peucker line simplification. */
function simplify(points, tol) {
  if (points.length < 3) return points;
  let max = 0;
  let index = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpDistance(points[i], points[0], points[points.length - 1]);
    if (d > max) {
      max = d;
      index = i;
    }
  }
  if (max <= tol) return [points[0], points[points.length - 1]];
  return [...simplify(points.slice(0, index + 1), tol).slice(0, -1), ...simplify(points.slice(index), tol)];
}

function ringArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  return Math.abs(a / 2);
}

function inRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function cleanRing(ring, level) {
  if (ringArea(ring) < MIN_AREA[level]) return null;
  const out = simplify(ring, TOLERANCE[level]).map(([x, y]) => [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000]);
  if (out.length < 4) return null;
  out[out.length - 1] = out[0];
  return out;
}

/** Outer rings only: the map draws outlines and the dummy data samples inside them, so holes are not needed. */
function outerRings(geometry) {
  const list = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  return list.map((poly) => poly[0]);
}

/** A point inside the largest ring, used to find which province a regency belongs to. */
function anchorPoint(rings) {
  const ring = rings.reduce((a, b) => (ringArea(b) > ringArea(a) ? b : a));
  const xs = ring.map((p) => p[0]);
  const ys = ring.map((p) => p[1]);
  const [w, e, s, n] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  for (let gy = 1; gy < 20; gy++) {
    for (let gx = 1; gx < 20; gx++) {
      const x = w + ((e - w) * gx) / 20;
      const y = s + ((n - s) * gy) / 20;
      if (inRing(x, y, ring)) return [x, y];
    }
  }
  return ring[0];
}

function slug(s) {
  return s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

const dir = process.argv[2];
if (!dir) {
  console.error("Usage: node scripts/build-boundaries.mjs <folder with geoBoundaries files>");
  process.exit(1);
}

const load = (file) => JSON.parse(readFileSync(join(dir, `${file}.geojson`), "utf8"));
const features = [];
const used = new Set();
const uniqueId = (base) => {
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
  used.add(id);
  return id;
};
const feature = (id, name, adm, parentId, rawRings) => {
  let rings = rawRings.map((r) => cleanRing(r, adm)).filter(Boolean);
  if (!rings.length) {
    const largest = rawRings.reduce((x, y) => (ringArea(y) > ringArea(x) ? y : x));
    rings = [largest.map(([x, y]) => [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000])];
  }
  const f = { type: "Feature", properties: { id, name, level: LEVELS[adm], parentId }, geometry: { type: "MultiPolygon", coordinates: rings.map((r) => [r]) } };
  features.push(f);
  return f;
};

for (const c of COUNTRIES) {
  const adm0 = load(`${c.iso}-ADM0`).features[0];
  feature(uniqueId(c.id), c.name, "ADM0", null, outerRings(adm0.geometry));

  const provinces = load(`${c.iso}-ADM1`)
    .features.map((f) => {
      const rings = outerRings(f.geometry);
      return { id: uniqueId(`${c.id}-${slug(f.properties.shapeName)}`), name: f.properties.shapeName, rings };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const p of provinces) feature(p.id, p.name, "ADM1", c.id, p.rings);

  const regencies = load(`${c.iso}-ADM2`).features.map((f) => ({ name: f.properties.shapeName, rings: outerRings(f.geometry) }));
  const nearest = (x, y) => {
    let best = provinces[0];
    let bestD = Infinity;
    for (const p of provinces) {
      for (const ring of p.rings) {
        for (const [px, py] of ring) {
          const d = (px - x) ** 2 + (py - y) ** 2;
          if (d < bestD) {
            bestD = d;
            best = p;
          }
        }
      }
    }
    return best;
  };
  const nearestUsed = [];
  for (const r of regencies.sort((a, b) => a.name.localeCompare(b.name))) {
    const [x, y] = anchorPoint(r.rings);
    const override = PARENT_OVERRIDES[r.name];
    let parent = override ? provinces.find((p) => override.test(p.name)) : provinces.find((p) => p.rings.some((ring) => inRing(x, y, ring)));
    if (!parent) {
      parent = nearest(x, y);
      nearestUsed.push(`${r.name} -> ${parent.name}`);
    }
    feature(uniqueId(`${parent.id}-${slug(r.name)}`), r.name, "ADM2", parent.id, r.rings);
  }
  if (nearestUsed.length) console.log(`${c.iso}: matched by nearest province border: ${nearestUsed.join(", ")}`);
}

const out = join(import.meta.dirname, "..", "public", "boundaries.geojson");
writeFileSync(out, JSON.stringify({ type: "FeatureCollection", features }));
const count = (level) => features.filter((f) => f.properties.level === level).length;
console.log(`Wrote ${count("country")} country, ${count("province")} provinces, ${count("regency")} cities/regencies to ${out}`);
