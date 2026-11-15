import { afterEach, describe, expect, it, vi } from "vitest";
import { nationalReading } from "./agreement-view";
import type { SettingMeta } from "./api";
import { UNIT, UNIT_SHORT } from "./format";
import { readUrlState, writeUrlState, type ViewState } from "./url-state";

const defaults: ViewState = {
  filters: { mode: "area", regionIds: ["idn"], polygon: null, start: "2026-01-01", end: "2026-11-14" },
  ramp: "ember",
  daynight: "all",
  hotspots: "vegetation",
};

/** Points `location` and `history` at a fake page URL and returns what `replaceState` was given. */
function fakePage(search: string): { replaced: string[] } {
  const replaced: string[] = [];
  vi.stubGlobal("location", { search, pathname: "/", hash: "" });
  vi.stubGlobal("history", { replaceState: (_: unknown, __: string, url: string) => replaced.push(url) });
  return { replaced };
}

afterEach(() => vi.unstubAllGlobals());

describe("unit", () => {
  it("is Aqua MODIS-equivalent hotspots", () => {
    expect(UNIT).toBe("hotspots (Aqua MODIS-equivalent)");
    expect(UNIT_SHORT).toBe("hotspots");
  });
});

describe("hotspot type in the URL", () => {
  it("reads ht=all and falls back to the default otherwise", () => {
    fakePage("?ht=all&dn=night");
    expect(readUrlState(defaults, () => true, "2002-07-04", "2026-11-14")).toMatchObject({ hotspots: "all", daynight: "night" });
    fakePage("?ht=volcanoes");
    expect(readUrlState(defaults, () => true, "2002-07-04", "2026-11-14").hotspots).toBe("vegetation");
  });

  it("writes ht only when it differs from the default", () => {
    const page = fakePage("");
    writeUrlState({ ...defaults, hotspots: "all" }, defaults);
    writeUrlState(defaults, defaults);
    expect(page.replaced).toEqual(["/?ht=all"]);
  });
});

function setting(misses: { share: number }[]): SettingMeta {
  const metrics = { n_months: 167, r_log: 0.996, malr: 0.074, bias: 1.01, peak_matches: 14 - misses.length, peak_years: 14, peak_agreement: null, peaks: {}, verdict: "partial" };
  return {
    factors: {} as SettingMeta["factors"],
    verdict: "partial",
    evaluation: {
      leave_one_year_out: metrics,
      day_only: metrics,
      night_only: metrics,
      story_2015: {},
      control_snpp_vs_noaa20: metrics,
      peak_misses: misses.map((m, i) => ({ year: 2013 + i, modis_peak: 8, viirs_peak: 9, modis_margin: 0.05, viirs_margin: 0.05, modis_resampled_share: m.share })),
    },
  };
}

describe("national verdict reading", () => {
  it("says when every peak-month miss is a near-tie", () => {
    expect(nationalReading(setting([{ share: 0.27 }, { share: 0.38 }, { share: 0.18 }]))).toBe(
      "Across Indonesia, predicting each year from the other years, the agreement is rated <strong>partial</strong>: the peak month differs in 3 of 14 years, all near-ties within MODIS's own day-to-day sampling noise.",
    );
  });

  it("counts only the misses that are near-ties", () => {
    expect(nationalReading(setting([{ share: 0.3 }, { share: 0.01 }]))).toContain("differs in 2 of 14 years, 1 of them near-ties");
    expect(nationalReading(setting([{ share: 0.01 }]))).toMatch(/differs in 1 of 14 years\.$/);
  });
});
