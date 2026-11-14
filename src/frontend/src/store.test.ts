import { describe, expect, it } from "vitest";
import { hottestCell, pointInPolygon } from "./store";
import type { Hotspot } from "./types";

const at = (lon: number, lat: number): Hotspot => ({ id: 0, lon, lat, date: "2015-09-01", sensor: "VIIRS", confidence: "high", frp: 10, regionId: "x" });

describe("pointInPolygon", () => {
  it("separates inside and outside points", () => {
    const square: [number, number][] = [[0, 0], [2, 0], [2, 2], [0, 2]];
    expect(pointInPolygon(1, 1, square)).toBe(true);
    expect(pointInPolygon(3, 1, square)).toBe(false);
  });
});

describe("hottestCell", () => {
  it("returns the centre of the busiest cell", () => {
    const cell = hottestCell([at(101.1, 0.1), at(101.2, 0.2), at(110, -2)]);
    expect(cell).toEqual({ lon: 101.125, lat: 0.125, count: 2 });
  });

  it("returns null without detections", () => {
    expect(hottestCell([])).toBeNull();
  });
});
