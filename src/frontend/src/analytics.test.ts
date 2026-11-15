import { describe, expect, it } from "vitest";
import {
  anomalyForMonth,
  anomalyForYear,
  annualTrend,
  climatology,
  median,
  peakMonthOfYear,
  type Series,
  yearOnYear,
} from "./analytics";
import { monthStart, toDay } from "./dates";

/** Builds a series for 2012-2015 where every day of a month gets `perDay(year, month)` fire cell-days. */
function series(perDay: (year: number, month: number) => number): Series {
  const firstDay = toDay("2012-01-01");
  const lastDay = toDay("2015-12-31");
  const daily = new Float64Array(lastDay - firstDay + 1);
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

describe("yearOnYear", () => {
  it("compares a range with the same dates a year earlier", () => {
    const s = series(fireSeason);
    const c = yearOnYear(s, toDay("2015-09-01"), toDay("2015-09-30"));
    expect(c.total).toBe(300);
    expect(c.previous).toBe(60);
    expect(c.previousFrom).toBe(toDay("2014-09-01"));
    expect(c.change).toBeCloseTo(400);
    expect(c.shorterThanYear).toBe(true);
  });

  it("has nothing to compare with in the first year, and a full year is not shorter than a year", () => {
    const s = series(fireSeason);
    expect(yearOnYear(s, toDay("2012-09-01"), toDay("2012-09-30")).change).toBeNull();
    expect(yearOnYear(s, toDay("2014-01-01"), toDay("2014-12-31")).shorterThanYear).toBe(false);
    expect(yearOnYear(s, toDay("2014-01-01"), toDay("2014-12-30")).shorterThanYear).toBe(true);
  });
});

describe("peaks", () => {
  it("finds the peak month", () => {
    const s = series((_, m) => (m === 8 ? 5 : 1));
    expect(peakMonthOfYear(s, 2014).peak).toBe(8);
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
  it("reads one month in every year, each year against the others", () => {
    const s = series(fireSeason);
    const a = anomalyForMonth(s, 8);
    expect(a.labels).toEqual(["2012", "2013", "2014", "2015"]);
    expect(a.verdicts[a.labels.indexOf("2015")]).toBe("unusual");
    expect(a.unusual[a.labels.indexOf("2015")]).toBe(true);
    expect(a.verdicts[a.labels.indexOf("2013")]).not.toBe("unusual");
    // Each point's references leave out its own year
    expect(a.mean[0]).toBeCloseTo((60 + 60 + 300) / 3);
    expect(a.median[0]).toBe(60);
    // Never unusual inside its own usual range
    a.values.forEach((v, i) => expect(a.unusual[i]).toBe(v > a.threshold[i] && v > 0));
  });

  it("reads each month of a year against the same month in other years", () => {
    const s = series(fireSeason);
    const a = anomalyForYear(s, 2015);
    expect(a.unusual.filter(Boolean)).toHaveLength(3);
    expect(a.verdicts.filter((v) => v === "unusual")).toHaveLength(3);
    expect(anomalyForYear(s, 2012).verdicts).not.toContain("unusual");
  });
});
