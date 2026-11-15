import { describe, expect, it } from "vitest";
import { badgeText, isCause, whySummary, type Attribution } from "./attribution";

/** The example of docs/attribution.md, trimmed to two indicators. */
const example: Attribution = {
  category: "wildfire",
  label: "Wildfire",
  confidence: "medium",
  scores: { land_clearing: 3, agricultural_burning: 0, wildfire: 4 },
  indicators: [
    { id: "forest_loss_strong", category: "land_clearing", points: 2, met: true, text: "Tree cover was lost", sources: ["hansen2013"] },
    { id: "dry_months", category: "wildfire", points: 1, met: null, text: "Rainfall under 4 mm/day", sources: ["imerg"] },
    { id: "forest_loss_some", category: "land_clearing", points: 1, met: false, text: "Some loss", sources: ["hansen2013"] },
    { id: "peatland", category: "wildfire", points: 1, met: true, text: "Peat", sources: ["gumbricht2017"] },
    { id: "climate_driver", category: "wildfire", points: 1, met: true, text: "El Nino", sources: ["oni", "saji1999"] },
    { id: "rain_deficit", category: "wildfire", points: 1, met: false, text: "Rain deficit", sources: ["imerg"] },
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

const sources = {
  hansen2013: { citation: "Hansen, M. C. et al. (2013). High-resolution global maps.", url: null },
  gumbricht2017: { citation: "Gumbricht, T. et al. (2017). An expert system model.", url: null },
  oni: { citation: "NOAA Climate Prediction Center. Oceanic Nino Index (ONI), ERSSTv5.", url: null },
};

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

describe("whySummary", () => {
  it("lists only the evidence met for the named cause, with its figures and the datasets behind it", () => {
    expect(whySummary(example, sources)).toBe(
      [
        "Points: wildfire 4 · clearing 3 · farming 0",
        "✓ Peat 47.6% of the area",
        "✓ El Niño or positive IOD (ONI 2.28, DMI 0.48)",
        "? No data: rainfall",
        "Data: Gumbricht 2017, NOAA Climate Prediction Center",
      ].join("\n"),
    );
  });

  it("shows missing data as missing, never as not met", () => {
    const text = whySummary(example, sources);
    expect(text).not.toContain("Rain deficit");
    expect(text).toContain("? No data: rainfall");
  });

  it("explains an unclear cause and lists what was met for every cause", () => {
    const text = whySummary({ ...example, category: "unknown", label: "Unknown", confidence: null }, sources);
    expect(text.split("\n")[0]).toBe("No cause has enough support, or two tie.");
    expect(text).toContain("✓ Forest loss 19.5% vs usual 5.7%");
    expect(text).toContain("✓ Peat 47.6% of the area");
    expect(text).toContain("Data: Hansen 2013, Gumbricht 2017, NOAA Climate Prediction Center");
  });

  it("does not claim a share of normal rainfall when the normal is unknown", () => {
    const rainfall = { mm_per_day: 0.4, normal_mm_per_day: null, share_of_normal: null, months: ["2015-08", "2015-10"] as [string, string], normal_years: [2001, 2020] as [number, number], source: "imerg" };
    const dry: Attribution = { ...example, indicators: [{ id: "dry_months", category: "wildfire", points: 1, met: true, text: "Dry", sources: ["imerg"] }], evidence: { ...example.evidence, rainfall } };
    expect(whySummary(dry, {})).toContain("✓ Dry: 0.4 mm/day");
    expect(whySummary(dry, {})).not.toContain("normal");
  });

  it("says so when nothing supports the cause", () => {
    const none: Attribution = { ...example, indicators: [] };
    expect(whySummary(none, {})).toContain("No indicator met");
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
