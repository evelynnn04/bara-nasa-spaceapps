// Procedural rainforest trees. Each species follows growth rules rather than random shapes:
//  - emergent: a tall clear bole on buttress roots, a few heavy limbs near the top, and a flat umbrella crown;
//  - canopy: a shorter trunk that forks into 3–5 limbs, each ending in a rounded leaf clump;
//  - palm: a slender curving stem with a crown of arching, drooping fronds;
//  - shrub: understory with a low, dense crown.
// Wood is tapered tubes with bark UVs; foliage is leaf-cluster cards whose normals point out of
// their clump (so a crown shades like a volume, not like flat paper). Vertex colours carry a little
// ambient occlusion: darker low on the trunk and on the underside of a crown.

import { BufferAttribute, BufferGeometry, Vector3 } from "three";
import { rng } from "./common";

export type Species = "emergent" | "canopy" | "palm" | "shrub";

export interface TreeModel {
  species: Species;
  wood: BufferGeometry;
  leaves: BufferGeometry;
  /** Which foliage texture the leaves use: 0/1 broadleaf clusters, 2 palm frond. */
  foliage: 0 | 1 | 2;
  /** Height of the crown's centre, for placing flames and smoke. */
  crownY: number;
  crownR: number;
}

class Builder {
  pos: number[] = [];
  nor: number[] = [];
  uv: number[] = [];
  col: number[] = [];
  idx: number[] = [];

  /** A tapered tube through points, `radial` sides, bark UV repeating every 2 m. */
  tube(pts: Vector3[], radii: number[], radial: number, aoBase = 0): void {
    const base = this.pos.length / 3;
    let along = 0;
    const t = new Vector3(), n = new Vector3(), b = new Vector3(), up = new Vector3(0, 1, 0);
    for (let i = 0; i < pts.length; i++) {
      if (i > 0) along += pts[i].distanceTo(pts[i - 1]);
      t.subVectors(pts[Math.min(i + 1, pts.length - 1)], pts[Math.max(i - 1, 0)]).normalize();
      n.crossVectors(t, Math.abs(t.y) > 0.95 ? new Vector3(1, 0, 0) : up).normalize();
      b.crossVectors(t, n).normalize();
      for (let k = 0; k <= radial; k++) {
        const a = (k / radial) * Math.PI * 2;
        const dir = new Vector3().addScaledVector(n, Math.cos(a)).addScaledVector(b, Math.sin(a));
        const p = pts[i].clone().addScaledVector(dir, radii[i]);
        this.pos.push(p.x, p.y, p.z);
        this.nor.push(dir.x, dir.y, dir.z);
        this.uv.push(k / radial, along / 2);
        const ao = Math.min(1, 0.45 + (pts[i].y + aoBase) / 9);   // darker near the ground
        this.col.push(ao, ao, ao);
      }
    }
    const ring = radial + 1;
    for (let i = 0; i < pts.length - 1; i++) {
      for (let k = 0; k < radial; k++) {
        const a = base + i * ring + k, c = a + ring;
        this.idx.push(a, c, a + 1, a + 1, c, c + 1);
      }
    }
  }

  /** One leaf card centred at p, facing roughly `face`, normal bent outward from the clump centre. */
  card(p: Vector3, size: number, face: Vector3, clump: Vector3, clumpR: number, r: () => number): void {
    const base = this.pos.length / 3;
    const f = face.clone().normalize();
    const side = new Vector3(r() - 0.5, r() - 0.5, r() - 0.5).cross(f).normalize();
    const upv = new Vector3().crossVectors(f, side).normalize();
    const h = size / 2;
    const out = p.clone().sub(clump).add(new Vector3(0, clumpR * 0.6, 0)).normalize();
    const shade = 0.55 + 0.45 * Math.min(1, Math.max(0, (p.y - clump.y + clumpR) / (clumpR * 1.6)));
    const corners: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    for (const [sx, sy] of corners) {
      const v = p.clone().addScaledVector(side, sx * h).addScaledVector(upv, sy * h);
      this.pos.push(v.x, v.y, v.z);
      this.nor.push(out.x, out.y, out.z);
      this.uv.push((sx + 1) / 2, (sy + 1) / 2);
      this.col.push(shade, shade, shade);
    }
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  /** A clump of leaf cards filling a flattened ellipsoid. */
  clump(c: Vector3, rx: number, ry: number, n: number, size: number, r: () => number): void {
    for (let i = 0; i < n; i++) {
      const u = r() * Math.PI * 2, v = Math.acos(2 * r() - 1), k = Math.cbrt(r());
      const p = new Vector3(Math.sin(v) * Math.cos(u) * rx * k, Math.cos(v) * ry * k, Math.sin(v) * Math.sin(u) * rx * k).add(c);
      const face = p.clone().sub(c).add(new Vector3((r() - 0.5) * rx, ry * 1.5, (r() - 0.5) * rx));
      this.card(p, size * (0.75 + r() * 0.5), face, c, Math.max(rx, ry), r);
    }
  }

  /** A palm frond: an arching, drooping, slightly V-folded strip with UV v running base → tip. */
  frond(origin: Vector3, yaw: number, lift: number, len: number, width: number, r: () => number): void {
    const segs = 6;
    const base = this.pos.length / 3;
    const dir = new Vector3(Math.cos(yaw), 0, Math.sin(yaw));
    const side = new Vector3(-dir.z, 0, dir.x);
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const d = t * len;
      const y = Math.sin(lift) * d - (0.55 + r() * 0.1) * d * d / len * 1.4;   // rises, then droops
      const centre = origin.clone().addScaledVector(dir, Math.cos(lift) * d).add(new Vector3(0, y, 0));
      const w = width * Math.sin(Math.PI * Math.min(1, t * 1.1 + 0.05)) * 0.5;
      for (const s of [-1, 0, 1]) {
        const v = centre.clone().addScaledVector(side, s * w).add(new Vector3(0, s === 0 ? 0.12 : -0.05, 0));
        this.pos.push(v.x, v.y, v.z);
        this.nor.push(0, 1, 0);
        this.uv.push((s + 1) / 2, t);
        const shade = 0.7 + 0.3 * (1 - t * 0.4);
        this.col.push(shade, shade, shade);
      }
    }
    for (let i = 0; i < segs; i++) {
      for (let k = 0; k < 2; k++) {
        const a = base + i * 3 + k, c = a + 3;
        this.idx.push(a, c, a + 1, a + 1, c, c + 1);
      }
    }
  }

  build(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute("normal", new BufferAttribute(new Float32Array(this.nor), 3));
    g.setAttribute("uv", new BufferAttribute(new Float32Array(this.uv), 2));
    g.setAttribute("color", new BufferAttribute(new Float32Array(this.col), 3));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

/** A gently bending line from a to b with `n` points. */
function bend(a: Vector3, b: Vector3, n: number, sag: number, r: () => number): Vector3[] {
  const pts: Vector3[] = [];
  const wob = new Vector3((r() - 0.5) * sag, 0, (r() - 0.5) * sag);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    pts.push(a.clone().lerp(b, t).addScaledVector(wob, Math.sin(Math.PI * t)));
  }
  return pts;
}
const taper = (n: number, r0: number, r1: number) => Array.from({ length: n }, (_, i) => r0 + (r1 - r0) * (i / (n - 1)) ** 0.8);

function emergent(seed: number): TreeModel {
  const r = rng(seed), w = new Builder(), l = new Builder();
  const H = 38 + r() * 8, R0 = 0.9 + r() * 0.3;
  const top = new Vector3((r() - 0.5) * 1.5, H, (r() - 0.5) * 1.5);
  w.tube(bend(new Vector3(0, -1, 0), top, 7, 1.2, r), taper(7, R0, R0 * 0.35), 7);
  for (let i = 0; i < 5; i++) {                                    // buttress roots
    const a = (i / 5) * Math.PI * 2 + r() * 0.5;
    const out = new Vector3(Math.cos(a), 0, Math.sin(a));
    w.tube([new Vector3(0, 4 + r() * 2, 0).addScaledVector(out, R0 * 0.5), new Vector3(0, 1.2, 0).addScaledVector(out, 2.2), new Vector3(0, -0.6, 0).addScaledVector(out, 3.6 + r())],
      [0.45, 0.32, 0.12], 3);
  }
  const limbs = 4 + Math.floor(r() * 3);
  const crownR = 11 + r() * 5;
  for (let i = 0; i < limbs; i++) {
    const a = (i / limbs) * Math.PI * 2 + r() * 0.6;
    const start = new Vector3(0, H * (0.82 + r() * 0.1), 0).lerp(top, 0.5);
    const end = start.clone().add(new Vector3(Math.cos(a) * crownR * (0.6 + r() * 0.3), 3 + r() * 4, Math.sin(a) * crownR * (0.6 + r() * 0.3)));
    w.tube(bend(start, end, 4, 1.5, r), taper(4, R0 * 0.32, 0.12), 4);
    l.clump(end.clone().add(new Vector3(0, 1.2, 0)), 5.5 + r() * 2, 2.2 + r(), 16, 4.4, r);
  }
  l.clump(top.clone().add(new Vector3(0, 2.5, 0)), 6, 2.4, 14, 4.4, r);
  return { species: "emergent", wood: w.build(), leaves: l.build(), foliage: 0, crownY: H + 3, crownR };
}

function canopyTree(seed: number): TreeModel {
  const r = rng(seed), w = new Builder(), l = new Builder();
  const H = 19 + r() * 8, R0 = 0.45 + r() * 0.2, fork = H * (0.5 + r() * 0.15);
  const forkP = new Vector3((r() - 0.5) * 1.2, fork, (r() - 0.5) * 1.2);
  w.tube(bend(new Vector3(0, -1, 0), forkP, 5, 0.8, r), taper(5, R0, R0 * 0.7), 6);
  const limbs = 3 + Math.floor(r() * 3);
  const spread = 5 + r() * 3;
  for (let i = 0; i < limbs; i++) {
    const a = (i / limbs) * Math.PI * 2 + r() * 0.8;
    const end = forkP.clone().add(new Vector3(Math.cos(a) * spread * (0.6 + r() * 0.5), H - fork - 1 + r() * 3, Math.sin(a) * spread * (0.6 + r() * 0.5)));
    w.tube(bend(forkP, end, 4, 1.2, r), taper(4, R0 * 0.6, 0.1), 4);
    l.clump(end, 3.6 + r() * 1.6, 2.6 + r(), 13, 3.6, r);
  }
  l.clump(new Vector3(forkP.x, H + 1, forkP.z), 4.5, 3, 12, 3.8, r);
  return { species: "canopy", wood: w.build(), leaves: l.build(), foliage: r() < 0.5 ? 0 : 1, crownY: H, crownR: spread + 3 };
}

function palm(seed: number): TreeModel {
  const r = rng(seed), w = new Builder(), l = new Builder();
  const H = 9 + r() * 8;
  const lean = new Vector3((r() - 0.5) * 3, 0, (r() - 0.5) * 3);
  const pts = Array.from({ length: 7 }, (_, i) => {
    const t = i / 6;
    return new Vector3(lean.x * t * t, -0.5 + H * t, lean.z * t * t);
  });
  w.tube(pts, taper(7, 0.32, 0.24), 6);
  const crown = pts[6].clone().add(new Vector3(0, 0.3, 0));
  const n = 13 + Math.floor(r() * 4);
  for (let i = 0; i < n; i++) {
    const tier = i % 3;
    l.frond(crown, (i / n) * Math.PI * 2 + r() * 0.3, 0.9 - tier * 0.35 + r() * 0.15, 5.5 + r() * 1.8, 2.2 + r() * 0.4, r);
  }
  return { species: "palm", wood: w.build(), leaves: l.build(), foliage: 2, crownY: H, crownR: 5 };
}

function shrub(seed: number): TreeModel {
  const r = rng(seed), w = new Builder(), l = new Builder();
  const H = 4 + r() * 4;
  w.tube(bend(new Vector3(0, -0.5, 0), new Vector3(0, H, 0), 4, 0.6, r), taper(4, 0.18, 0.08), 5);
  l.clump(new Vector3(0, H * 0.85, 0), 2.6 + r(), 2 + r(), 10, 2.8, r);
  l.clump(new Vector3(1.4, H * 0.55, 0.6), 1.8, 1.4, 5, 2.4, r);
  return { species: "shrub", wood: w.build(), leaves: l.build(), foliage: r() < 0.5 ? 1 : 0, crownY: H * 0.8, crownR: 3 };
}

/** The species set: a few seeded individuals of each, so neighbours differ. */
export function buildModels(): TreeModel[] {
  return [emergent(101), emergent(102), canopyTree(201), canopyTree(202), canopyTree(203), palm(301), palm(302), shrub(401), shrub(402)];
}
