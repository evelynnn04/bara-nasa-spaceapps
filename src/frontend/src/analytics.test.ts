import { describe, expect, it } from "vitest";
import {
  anomalyForMonth,
  anomalyForYear,
  annualTrend,
  climatology,
  comparePeriod,
  median,
  peakDayOfMonth,
  peakMonthOfYear,
  unusualMonths,
  type Series,
} from "./analytics";
import { monthStart, toDay } from "./dates";

/** Builds a series for 2012-2015 where every day of a month gets `perDay(year, month)` detections. */
function series(perDay: (year: number, month: number) => number): Series {
  const firstDay = toDay("2012-01-01");
  const lastDay = toDay("2015-12-31");
  const daily = new Int32Array(lastDay - firstDay + 1);
  for (let y = 2012; y <= 2015; y++) {
    for (let m = 0; m < 12; m++) {
      const a = monthStart(y, m);
      const b = monthStart(y, m + 1);
      for (let d = a; d < b; d++) daily[d - firstDay] = perDay(y, m);
    }
  }
  return { daily, firstDay, lastDay };
}

const fireSeason = (y: number, m: number) => (m >= 7 && m <= 9 ? (y === 2015 ? 10 : 2) : 0);

describe("median", () => {
  it("handles odd and even lengths", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });
});

describe("comparePeriod", () => {
  it("compares a range with the previous period and other years", () => {
    const s = series(fireSeason);
    const c = comparePeriod(s, toDay("2015-09-01"), toDay("2015-09-30"));
    expect(c.total).toBe(300);
    expect(c.previous).toBe(300);
    expect(c.historicalWindows).toBe(3);
    expect(c.historicalMean).toBe(60);
    expect(c.vsMean).toBeCloseTo(400);
  });

  it("returns null deviations when there is nothing before the range", () => {
    const s = series(fireSeason);
    const c = comparePeriod(s, toDay("2012-01-01"), toDay("2012-01-31"));
    expect(c.previous).toBeNull();
    expect(c.vsPrevious).toBeNull();
  });
});

describe("peaks", () => {
  it("finds the peak month and the peak day", () => {
    const s = series((_, m) => (m === 8 ? 5 : 1));
    expect(peakMonthOfYear(s, 2014).peak).toBe(8);
    const days = peakDayOfMonth(s, 2014, 8);
    expect(days.values).toHaveLength(30);
    expect(days.peak).toBe(0);
  });

  it("reports no peak when there are no fires", () => {
    expect(peakMonthOfYear(series(() => 0), 2013).peak).toBe(-1);
  });
});

describe("patterns", () => {
  it("finds a rising trend and the fire-prone months", () => {
    const s = series((y, m) => (m >= 7 && m <= 9 ? y - 2011 : 0));
    const t = annualTrend(s);
    expect(t.slope).toBeGreaterThan(0);
    const c = climatology(s);
    expect(c.top.sort()).toEqual([7, 8, 9]);
    expect(c.season).toEqual([7, 9]);
  });
});

describe("anomalies", () => {
  it("flags an unusually high month", () => {
    const s = series(fireSeason);
    const a = anomalyForMonth(s, 2015, 8);
    expect(a.verdict).toBe("unusual");
    expect(a.unusual[a.selectedIndex]).toBe(true);
    expect(anomalyForMonth(s, 2013, 8).verdict).not.toBe("unusual");
  });

  it("flags an unusually high year and its months", () => {
    const s = series(fireSeason);
    const a = anomalyForYear(s, 2015);
    expect(a.verdict).toBe("unusual");
    expect(a.unusual.filter(Boolean)).toHaveLength(3);
    expect(anomalyForYear(s, 2012).history).toEqual(["2015"]);
  });
});

describe("unusualMonths", () => {
  it("lists only the inflated months, strongest first", () => {
    const s = series(fireSeason);
    const list = unusualMonths(s);
    expect(list.map((u) => `${u.year}-${u.month}`)).toEqual(["2015-7", "2015-9", "2015-8"]);
    expect(list[0].ratio).toBeCloseTo(5);
    expect(list[2].value).toBeLessThan(list[1].value);
  });
});
