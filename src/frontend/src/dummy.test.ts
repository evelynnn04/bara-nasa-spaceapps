import { describe, expect, it } from "vitest";
import { generateDummy } from "./dummy";
import { regionsFromBoundaries, type Boundaries } from "./regions";
import { pointInPolygon } from "./store";
import raw from "../public/boundaries.geojson?raw";

const boundaries = JSON.parse(raw) as Boundaries;
const { regions, shapes } = regionsFromBoundaries(boundaries);

describe("regionsFromBoundaries", () => {
  it("builds the country, province and city/regency tree", () => {
    const byId = new Map(regions.map((r) => [r.id, r]));
    expect(regions.filter((r) => r.level === "country").map((r) => r.name)).toEqual(["Indonesia"]);
    expect(regions.filter((r) => r.level === "province").length).toBe(34);
    for (const r of regions.filter((x) => x.level === "regency")) expect(byId.get(r.parentId!)?.level).toBe("province");
  });
});

describe("generateDummy", () => {
  const data = generateDummy(regions, shapes);

  it("is deterministic", () => {
    expect(generateDummy(regions, shapes).hotspots.length).toBe(data.hotspots.length);
  });

  it("places detections inside the real outline of their city/regency", () => {
    let inside = 0;
    const sample = data.hotspots.filter((_, i) => i % 50 === 0);
    for (const h of sample) if (shapes.get(h.regionId)!.some((ring) => pointInPolygon(h.lon, h.lat, ring))) inside++;
    expect(inside / sample.length).toBeGreaterThan(0.97);
  });

  it("makes 2015 a much bigger fire year than 2016", () => {
    const count = (y: string) => data.hotspots.filter((h) => h.date.startsWith(y)).length;
    expect(count("2015")).toBeGreaterThan(count("2016") * 4);
  });
});
