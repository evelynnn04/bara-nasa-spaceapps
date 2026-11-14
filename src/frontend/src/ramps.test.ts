import { describe, expect, it } from "vitest";
import { RAMPS, SURFACE, contrast, inkOn, luminance, stepFor } from "./ramps";

describe("sequential ramps", () => {
  for (const [name, ramp] of Object.entries(RAMPS)) {
    it(`${name} gets brighter at every step`, () => {
      const lum = ramp.steps.map(luminance);
      for (let i = 1; i < lum.length; i++) expect(lum[i]).toBeGreaterThan(lum[i - 1]);
    });

    it(`${name} lowest step stands apart from the surface`, () => {
      expect(contrast(ramp.steps[0], SURFACE)).toBeGreaterThan(1.1);
    });

    it(`${name} cell text keeps 4.5:1 contrast on every step`, () => {
      for (const fill of ramp.steps) expect(contrast(fill, inkOn(fill))).toBeGreaterThanOrEqual(4.5);
    });
  }
});

describe("stepFor", () => {
  it("keeps zero and missing values off the ramp", () => {
    expect(stepFor(0, 100, 8)).toBe(-1);
    expect(stepFor(5, 0, 8)).toBe(-1);
  });

  it("puts the maximum on the brightest step", () => {
    expect(stepFor(100, 100, 8)).toBe(7);
    expect(stepFor(1, 100, 8)).toBe(0);
  });
});
