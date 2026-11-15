import { describe, expect, it } from "vitest";
import { areaParams, parseSeries } from "./api";
import { peakMonth, describe as describeMetrics } from "./agreement-view";
import { toDay } from "./dates";
import { quantileBreaks, stepBounds } from "./ramps";
import { select, unobserved } from "./store";
import type { Filters } from "./types";

const filters: Filters = { mode: "area", regionIds: ["idn-riau", "idn-jambi"], polygon: null, start: "2015-09-01", end: "2015-09-30" };

describe("areaParams", () => {
  it("sends named areas, or the drawn polygon in polygon mode", () => {
    expect(areaParams(filters)).toEqual({ area: "idn-riau,idn-jambi" });
    expect(areaParams({ ...filters, mode: "polygon", polygon: [[101.12345, 0.5], [102, 0.5], [102, 1]] })).toEqual({ poly: "101.1235,0.5;102,0.5;102,1" });
  });

  it("falls back to the whole country while no polygon is drawn", () => {
    expect(areaParams({ ...filters, mode: "polygon" })).toEqual({ area: "idn" });
  });
});

describe("parseSeries", () => {
  const s = parseSeries({ start: "2015-09-01", end: "2015-09-04", values: [1.5, null, 0, 0.25] });

  it("keeps fractional values and marks unobserved days", () => {
    expect(Array.from(s.daily)).toEqual([1.5, 0, 0, 0.25]);
    expect(Array.from(s.missing)).toEqual([0, 1, 0, 0]);
    expect(s.firstDay).toBe(toDay("2015-09-01"));
    expect(s.lastDay).toBe(toDay("2015-09-04"));
  });

  it("counts unobserved days inside a selected range", () => {
    const sel = select(s, "2015-09-02", "2015-12-31");
    expect(sel.to).toBe(s.lastDay);
    expect(unobserved(sel, sel.from, sel.to)).toBe(1);
  });

  it("rejects a series whose length does not match its dates", () => {
    expect(() => parseSeries({ start: "2015-09-01", end: "2015-09-04", values: [1] })).toThrow();
  });
});

describe("agreement helpers", () => {
  it("finds the peak month and ignores empty years", () => {
    expect(peakMonth([0, 0, 0, 0, 0, 0, 0, 3, 9, 8, 1, 0])).toBe(8);
    expect(peakMonth(new Array(12).fill(0))).toBe(-1);
  });

  it("reads the metrics in plain terms", () => {
    const rows = describeMetrics({ n_months: 167, r_log: 0.9954, malr: 0.079, bias: 1.0036, peak_matches: 11, peak_years: 14, peak_agreement: 0.7857, peaks: {}, verdict: "partial" });
    expect(rows.map((r) => r.v)).toEqual(["0.995", "8 %", "1.00×", "11 of 14 years"]);
  });
});

describe("colour classes", () => {
  it("builds increasing quantile breaks for skewed cell values", () => {
    const values = Array.from({ length: 1000 }, (_, i) => (i < 900 ? 0.4 : i < 990 ? 3 : 40));
    const b = quantileBreaks(values, 8);
    expect(b[0]).toBe(0);
    for (let i = 1; i < b.length; i++) expect(b[i]).toBeGreaterThan(b[i - 1]);
    expect(b.length).toBeLessThanOrEqual(8);
  });

  it("gives tenths for small legend maxima", () => {
    expect(stepBounds(0.8, 4)).toEqual([0.1, 0.1, 0.2, 0.5]);
    expect(stepBounds(100, 4)[3]).toBe(57);
  });
});
