import { describe, expect, it } from "vitest";
import { RAMPS, SURFACE, breaksFrom, contrast, inkOn, luminance, quantileBreaks, stepFor } from "./ramps";

describe("sequential ramps", () => {
  for (const [name, ramp] of Object.entries(RAMPS)) {
    it(`${name} gets brighter at every step`, () => {
      const lum = ramp.steps.map(luminance);
      for (let i = 1; i < lum.length; i++) expect(lum[i]).toBeGreaterThan(lum[i - 1]);
    });

    it(`${name} forecast colour stands out on the surface and apart from the record's accent`, () => {
      expect(contrast(ramp.forecast, SURFACE)).toBeGreaterThanOrEqual(3);
      expect(ramp.forecast).not.toBe(ramp.accent);
      if (name === "grey") expect(contrast(ramp.forecast, ramp.accent)).toBeGreaterThan(1.5);
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

describe("quantileBreaks", () => {
  it("never repeats a break, even when many values are equal", () => {
    for (const v of [0.07, 0.14, 0.3, 0.7, 1.1, 2.3]) {
      const b = quantileBreaks(Array(100).fill(v), 8);
      expect(b).toEqual([0, v]);
    }
  });

  it("returns strictly increasing breaks for skewed values", () => {
    const values = Array.from({ length: 1000 }, (_, i) => 0.1 * 1.01 ** i);
    const b = quantileBreaks(values, 8);
    expect(b.length).toBe(8);
    for (let i = 1; i < b.length; i++) expect(b[i]).toBeGreaterThan(b[i - 1]);
  });

  it("has a single class without positive values", () => {
    expect(quantileBreaks([0, 0], 8)).toEqual([0]);
  });
});

describe("breaksFrom", () => {
  it("rounds quantiles from the backend the same way as quantileBreaks", () => {
    const values = Array.from({ length: 1000 }, (_, i) => 0.1 * 1.01 ** i);
    const qs = [0.35, 0.55, 0.7, 0.8, 0.88, 0.94, 0.98, 0.995].map((q) => values[Math.floor(q * values.length)]);
    expect(breaksFrom(qs, 8)).toEqual(quantileBreaks(values, 8));
    expect(breaksFrom([], 8)).toEqual([0]);
  });
});
