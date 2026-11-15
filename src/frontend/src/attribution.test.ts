import { describe, expect, it } from "vitest";
import { badgeText, evidenceRows, groupIndicators, indicatorState, isCause, type Attribution, type Evidence } from "./attribution";

/** The example of docs/attribution.md, trimmed to two indicators. */
const example: Attribution = {
  category: "wildfire",
  label: "Wildfire",
  confidence: "medium",
  scores: { land_clearing: 3, agricultural_burning: 0, wildfire: 4 },
  indicators: [
    { id: "forest_loss_strong", category: "land_clearing", points: 2, met: true, text: "Tree cover was lost", sources: ["hansen2013"] },
    { id: "dry_months", category: "wildfire", points: 1, met: null, text: "Rainfall under 4 mm/day", sources: ["imerg"] },
    { id: "forest_loss_any", category: "land_clearing", points: 1, met: false, text: "Some loss", sources: ["hansen2013"] },
  ],
  evidence: {
    forest_cover_2000: { share: 0.867, canopy_min_percent: 30, source: "hansen2013" },
    forest_loss: { share: 0.1952, expected_share: 0.0566, excess_share: 0.1386, years: [2014, 2016], source: "hansen2013" },
    landcover: { year: 2014, source: "mcd12q1", shares: { forest: 0.61, shrub_savanna: 0.2, grassland: 0, wetland: 0.12, cropland: 0, urban: 0, mosaic: 0.07, other: 0 } },
    peat: { share: 0.476, source: "gumbricht2017" },
    rainfall: { mm_per_day: 2.1, normal_mm_per_day: 5.8, share_of_normal: 0.362, months: ["2015-08", "2015-10"], normal_years: [2001, 2020], source: "imerg" },
    climate: { month: "2015-10", oni: 2.28, dmi: 0.48, sources: ["oni", "saji1999"] },
  },
};

const noEvidence: Evidence = { forest_cover_2000: null, forest_loss: null, landcover: null, peat: null, rainfall: null, climate: null };

describe("indicatorState", () => {
  it("never shows missing data as not met", () => {
    expect(indicatorState(null)).toEqual({ mark: "?", word: "data unavailable" });
    expect(indicatorState(false)).toEqual({ mark: "✗", word: "not met" });
    expect(indicatorState(true)).toEqual({ mark: "✓", word: "met" });
  });
});

describe("badgeText", () => {
  it("names the cause with its confidence", () => {
    expect(badgeText(example)).toBe("Wildfire · medium confidence");
  });

  it("says plainly when the cause is unclear or not assessed", () => {
    expect(badgeText({ ...example, category: "unknown", label: "Unknown", confidence: null })).toBe("Cause unclear");
    expect(badgeText(null)).toBe("Cause not assessed yet");
    expect(badgeText(undefined)).toBe("Cause not assessed yet");
  });
});

describe("groupIndicators", () => {
  it("groups by cause in order of first appearance", () => {
    const g = groupIndicators(example.indicators);
    expect(g.map((x) => x.category)).toEqual(["land_clearing", "wildfire"]);
    expect(g[0].items.map((i) => i.id)).toEqual(["forest_loss_strong", "forest_loss_any"]);
  });
});

describe("evidenceRows", () => {
  it("writes each evidence entry in plain figures", () => {
    const rows = Object.fromEntries(evidenceRows(example.evidence).map((r) => [r.label, r.value]));
    expect(Object.keys(rows)).toHaveLength(6);
    expect(rows["Forest cover in 2000"]).toBe("86.7%");
    expect(rows["Forest loss"]).toBe("19.5% (expected 5.7%), 2014–2016");
    expect(rows["Land cover"]).toBe("forest 61%, shrub/savanna 20%, wetland 12%, mosaic 7% (2014)");
    expect(rows["Peat"]).toBe("47.6%");
    expect(rows["Rainfall"]).toBe("2.1 mm/day, 36% of normal (2015-08 to 2015-10)");
    expect(rows["Climate"]).toBe("ONI 2.28, DMI 0.48 (2015-10)");
  });

  it("marks missing evidence as unavailable", () => {
    const rows = evidenceRows(noEvidence);
    expect(rows).toHaveLength(6);
    expect(rows.every((r) => r.value === "unavailable")).toBe(true);
  });
});

describe("isCause", () => {
  it("accepts only known causes", () => {
    expect(isCause("wildfire")).toBe(true);
    expect(isCause("unknown")).toBe(true);
    expect(isCause("x")).toBe(false);
    expect(isCause(null)).toBe(false);
  });
});
