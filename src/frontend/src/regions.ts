import type { BBox, Level, LngLat, Region } from "./types";

/** Properties of each outline in public/boundaries.geojson (built by scripts/build-boundaries.mjs). */
export interface BoundaryProps {
  id: string;
  name: string;
  level: Level;
  parentId: string | null;
}

export type Boundaries = GeoJSON.FeatureCollection<GeoJSON.MultiPolygon, BoundaryProps>;

/** Outer rings of every area, keyed by region id. */
export type Shapes = Map<string, LngLat[][]>;

export const LEVEL_LABEL: Record<Level, string> = {
  country: "Country",
  province: "Province",
  regency: "City / regency",
};

/** Returns the smallest box that contains all the given boxes. */
export function unionBBox(boxes: BBox[]): BBox {
  return boxes.reduce<BBox>(
    (acc, b) => [Math.min(acc[0], b[0]), Math.min(acc[1], b[1]), Math.max(acc[2], b[2]), Math.max(acc[3], b[3])],
    [Infinity, Infinity, -Infinity, -Infinity],
  );
}

function ringsBBox(rings: LngLat[][]): BBox {
  let [w, so, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const ring of rings) {
    for (const [x, y] of ring) {
      if (x < w) w = x;
      if (x > e) e = x;
      if (y < so) so = y;
      if (y > n) n = y;
    }
  }
  return [w, so, e, n];
}

/** Region list and outer rings from the boundary file. The file is ordered country, provinces, then cities/regencies. */
export function regionsFromBoundaries(fc: Boundaries): { regions: Region[]; shapes: Shapes } {
  const shapes: Shapes = new Map();
  const regions = fc.features.map((f) => {
    const rings = f.geometry.coordinates.map((poly) => poly[0] as LngLat[]);
    shapes.set(f.properties.id, rings);
    return { ...f.properties, bbox: ringsBBox(rings) };
  });
  return { regions, shapes };
}

/** Lookup helpers over a region list. */
export class RegionIndex {
  readonly byId = new Map<string, Region>();
  readonly children = new Map<string, Region[]>();
  readonly roots: Region[] = [];

  constructor(readonly regions: Region[]) {
    for (const r of regions) {
      this.byId.set(r.id, r);
      if (r.parentId === null) this.roots.push(r);
      else {
        const list = this.children.get(r.parentId) ?? [];
        list.push(r);
        this.children.set(r.parentId, list);
      }
    }
  }

  /** Ids of the region itself and every ancestor, finest first. */
  lineage(id: string): string[] {
    const ids: string[] = [];
    let cur = this.byId.get(id);
    while (cur) {
      ids.push(cur.id);
      cur = cur.parentId ? this.byId.get(cur.parentId) : undefined;
    }
    return ids;
  }

  /** Drops ids already covered by a selected ancestor, so each area is counted once. */
  normalise(ids: string[]): string[] {
    const set = new Set(ids);
    return ids.filter((id) => !this.lineage(id).slice(1).some((a) => set.has(a)));
  }

  /** Short label for a selection, e.g. "Riau, Jambi" or "Riau +3 more". */
  label(ids: string[]): string {
    const names = this.normalise(ids).map((id) => this.byId.get(id)?.name ?? id);
    if (names.length === 0) return "All areas";
    if (names.length <= 2) return names.join(", ");
    return `${names[0]} +${names.length - 1} more`;
  }
}
