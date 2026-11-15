import { afterEach, describe, expect, it, vi } from "vitest";
import type { Meta } from "./api";
import { dataChanged, watchData } from "./freshness";

const meta = (end: string, updated: string | null): Meta =>
  ({ record: { start: "2002-07-04", end, splice: "2012-02-01", unobserved_days: 0 }, data: updated === null ? null : { updated, fetched: {} } }) as Meta;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("dataChanged", () => {
  it("is false for the same record end and update time", () => {
    expect(dataChanged(meta("2026-11-14", null), meta("2026-11-14", null))).toBe(false);
    expect(dataChanged(meta("2026-11-14", "2026-11-15T13:05:00+00:00"), meta("2026-11-14", "2026-11-15T13:05:00+00:00"))).toBe(false);
  });

  it("is true when the record ends later or the tables were replaced", () => {
    expect(dataChanged(meta("2026-11-14", null), meta("2026-11-15", null))).toBe(true);
    expect(dataChanged(meta("2026-11-14", null), meta("2026-11-14", "2026-11-15T13:05:00+00:00"))).toBe(true);
    expect(dataChanged(meta("2026-11-14", "2026-11-15T13:05:00+00:00"), meta("2026-11-14", "2026-11-15T14:05:00+00:00"))).toBe(true);
  });
});

describe("watchData", () => {
  it("reports each change once, skips hidden tabs, survives a failed check and stops on request", async () => {
    vi.useFakeTimers();
    const tab = { visibilityState: "hidden" };
    vi.stubGlobal("document", tab);
    const answers: (() => Promise<Meta>)[] = [
      async () => meta("2026-11-14", null),
      async () => { throw new Error("down"); },
      async () => meta("2026-11-15", "2026-11-16T13:05:00+00:00"),
      async () => meta("2026-11-15", "2026-11-16T13:05:00+00:00"),
      async () => meta("2026-11-16", "2026-11-17T13:05:00+00:00"),
      async () => meta("2026-11-17", "2026-11-18T13:05:00+00:00"),
    ];
    const fetchMeta = vi.fn(() => answers.shift()!());
    const seen: string[] = [];
    const stop = watchData(fetchMeta, meta("2026-11-14", null), (now) => seen.push(now.record.end), 1000);

    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMeta).not.toHaveBeenCalled();
    tab.visibilityState = "visible";
    await vi.advanceTimersByTimeAsync(3000);
    expect(seen).toEqual(["2026-11-15"]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(seen).toEqual(["2026-11-15", "2026-11-16"]);
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchMeta).toHaveBeenCalledTimes(5);
    expect(seen).toEqual(["2026-11-15", "2026-11-16"]);
  });
});
