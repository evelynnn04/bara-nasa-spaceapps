import { describe, expect, it } from "vitest";
import { defaultInterval, labelledTicks, outlookFrames, stepShare, timeFrames } from "./timeline";

describe("defaultInterval", () => {
  it("opens in days, months or years by the length of the selected dates", () => {
    expect(defaultInterval("2015-09-01", "2015-10-31")).toBe("day");
    expect(defaultInterval("2026-01-01", "2026-11-14")).toBe("month");
    expect(defaultInterval("2024-01-01", "2026-12-31")).toBe("month");
    expect(defaultInterval("2002-07-04", "2026-11-14")).toBe("year");
  });
});

describe("timeFrames", () => {
  it("steps by day, each tick with its month", () => {
    expect(timeFrames("2015-08-31", "2015-09-02", "day")).toEqual([
      { interval: "day", from: "2015-08-31", to: "2015-08-31", label: "31 Aug 2015", tick: "31 Aug" },
      { interval: "day", from: "2015-09-01", to: "2015-09-01", label: "1 Sep 2015", tick: "1 Sep" },
      { interval: "day", from: "2015-09-02", to: "2015-09-02", label: "2 Sep 2015", tick: "2 Sep" },
    ]);
  });

  it("steps by calendar month, cutting the ends to the selected dates", () => {
    expect(timeFrames("2025-11-15", "2026-02-10", "month").map((f) => [f.from, f.to, f.label, f.tick])).toEqual([
      ["2025-11-15", "2025-11-30", "Nov 2025", "Nov 2025"],
      ["2025-12-01", "2025-12-31", "Dec 2025", "Dec"],
      ["2026-01-01", "2026-01-31", "Jan 2026", "Jan 2026"],
      ["2026-02-01", "2026-02-10", "Feb 2026", "Feb"],
    ]);
  });

  it("steps by calendar year", () => {
    const frames = timeFrames("2002-07-04", "2026-11-14", "year");
    expect(frames).toHaveLength(25);
    expect(frames[0]).toEqual({ interval: "year", from: "2002-07-04", to: "2002-12-31", label: "2002", tick: "2002" });
    expect(frames[24]).toEqual({ interval: "year", from: "2026-01-01", to: "2026-11-14", label: "2026", tick: "2026" });
  });
});

describe("labelledTicks", () => {
  it("labels every step when they fit, else evenly spaced ones ending on the last", () => {
    expect(labelledTicks(4, 6)).toEqual([0, 1, 2, 3]);
    expect(labelledTicks(11, 6)).toEqual([0, 2, 4, 6, 8, 10]);
    expect(labelledTicks(25, 6)).toEqual([0, 5, 10, 15, 20, 24]);
    expect(labelledTicks(23, 6)).toEqual([0, 5, 10, 15, 22]);
    expect(labelledTicks(0, 6)).toEqual([]);
  });
});

describe("stepShare", () => {
  it("is 1 for whole steps and the covered part for clipped ones", () => {
    expect(stepShare({ interval: "month", from: "2015-09-01", to: "2015-09-30", label: "", tick: "" })).toBe(1);
    expect(stepShare({ interval: "month", from: "2015-09-16", to: "2015-09-30", label: "", tick: "" })).toBeCloseTo(0.5);
    expect(stepShare({ interval: "year", from: "2016-01-01", to: "2016-06-30", label: "", tick: "" })).toBeCloseTo(182 / 366);
    expect(stepShare({ interval: "day", from: "2015-09-16", to: "2015-09-16", label: "", tick: "" })).toBe(1);
  });
});

describe("outlookFrames", () => {
  it("covers the whole target day, month or year of each lead and keeps its lead and label", () => {
    expect(outlookFrames("day", [{ lead: 1, target: "2026-11-15", label: "forecast" }])).toEqual([
      { interval: "day", from: "2026-11-15", to: "2026-11-15", label: "15 Nov 2026", tick: "15 Nov", lead: 1, outlook: "forecast" },
    ]);
    expect(outlookFrames("month", [{ lead: 3, target: "2027-02", label: "seasonal" }])[0]).toMatchObject({ from: "2027-02-01", to: "2027-02-28", label: "Feb 2027", lead: 3 });
    expect(outlookFrames("year", [{ lead: 1, target: "2027", label: "baseline" }])[0]).toMatchObject({ from: "2027-01-01", to: "2027-12-31", label: "2027", outlook: "baseline" });
  });
});
