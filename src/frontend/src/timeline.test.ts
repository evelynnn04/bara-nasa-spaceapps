import { describe, expect, it } from "vitest";
import type { CellsResponse } from "./api";
import { axisTicks, defaultInterval, frameAt, labelledTicks, sharedScale, shiftDate, timeFrames } from "./timeline";
import { toDay } from "./dates";

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
      { from: "2015-08-31", to: "2015-08-31", label: "31 Aug 2015", tick: "31 Aug" },
      { from: "2015-09-01", to: "2015-09-01", label: "1 Sep 2015", tick: "1 Sep" },
      { from: "2015-09-02", to: "2015-09-02", label: "2 Sep 2015", tick: "2 Sep" },
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
    expect(frames[0]).toEqual({ from: "2002-07-04", to: "2002-12-31", label: "2002", tick: "2002" });
    expect(frames[24]).toEqual({ from: "2026-01-01", to: "2026-11-14", label: "2026", tick: "2026" });
  });
});

describe("frameAt", () => {
  const frames = timeFrames("2026-01-15", "2026-04-10", "month");
  it("finds the step holding a date and clamps dates outside the steps", () => {
    expect(frameAt(frames, "2026-02-28")).toBe(1);
    expect(frameAt(frames, "2026-01-15")).toBe(0);
    expect(frameAt(frames, "2025-12-01")).toBe(0);
    expect(frameAt(frames, "2026-05-01")).toBe(3);
  });
});

describe("shiftDate", () => {
  it("moves by days, months or years and keeps the day inside shorter months", () => {
    expect(shiftDate("2026-02-28", "day", 1)).toBe("2026-03-01");
    expect(shiftDate("2026-01-31", "month", 1)).toBe("2026-02-28");
    expect(shiftDate("2026-03-15", "month", -3)).toBe("2025-12-15");
    expect(shiftDate("2024-02-29", "year", 1)).toBe("2025-02-28");
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

describe("axisTicks", () => {
  const d = toDay;
  it("marks years with months between them", () => {
    const t = axisTicks(d("2025-11-01"), d("2026-02-01"), "year", 0.5);
    expect(t.map((x) => [x.day, x.major, x.strong])).toEqual([
      [d("2025-11-01"), false, undefined],
      [d("2025-12-01"), false, undefined],
      [d("2026-01-01"), true, "2026"],
      [d("2026-02-01"), false, undefined],
    ]);
  });

  it("marks months, with days between them only when they are far enough apart", () => {
    expect(axisTicks(d("2026-09-29"), d("2026-10-02"), "month", 3).map((x) => [x.major, x.strong, x.rest])).toEqual([[true, "OCT", "2026"]]);
    expect(axisTicks(d("2026-09-30"), d("2026-10-01"), "month", 5).map((x) => x.major)).toEqual([false, true]);
  });

  it("marks every day, leaving the two days after a month label bare", () => {
    expect(axisTicks(d("2026-10-31"), d("2026-11-04"), "day", 28).map((x) => x.strong ?? "")).toEqual(["31", "NOV", "", "", "4"]);
  });
});

describe("sharedScale", () => {
  const layer = (value: number[]): CellsResponse => ({
    res_deg: 0.05, count: value.length, active_cells: value.length, total: 0, top: null,
    cells: { lon: value.map(() => 100), lat: value.map(() => 0), value, modis_px: [], viirs_px: [], frp_max: [] },
  });
  it("pools the cell values of every step", () => {
    const one = sharedScale([layer([1, 2, 3])], 8);
    const both = sharedScale([layer([1, 2, 3]), layer([100, 200, 300])], 8);
    expect(one[0]).toBe(0);
    expect(both[both.length - 1]).toBeGreaterThan(one[one.length - 1]);
  });
});
