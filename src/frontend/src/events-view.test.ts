import { describe, expect, it } from "vitest";
import type { Attribution } from "./attribution";
import { whyPanel } from "./events-view";

const attribution: Attribution = {
  category: "wildfire",
  label: "Wildfire",
  confidence: "low",
  scores: { land_clearing: 0, wildfire: 2 },
  indicators: [
    { id: "peat", category: "wildfire", points: 2, met: true, text: "Peat under the fire", sources: ["gumbricht2017"] },
    { id: "dry_months", category: "wildfire", points: 1, met: null, text: "Dry months", sources: ["imerg", "mystery"] },
    { id: "forest_loss_strong", category: "land_clearing", points: 2, met: false, text: "Tree cover was lost", sources: ["gumbricht2017"] },
  ],
  evidence: { forest_cover_2000: null, forest_loss: null, landcover: null, peat: { share: 0.4, source: "gumbricht2017" }, rainfall: null, climate: null },
};
const sources = {
  gumbricht2017: { citation: "Gumbricht et al. 2017", url: "https://example.org/peat" },
  imerg: { citation: "IMERG", url: null },
};

describe("why panel", () => {
  const html = whyPanel(attribution, sources);

  it("shows unavailable indicators as data unavailable, never as not met", () => {
    expect(html).toMatch(/data-state="na"[^]*?data unavailable/);
    expect(html.match(/\(not met\)/g)).toHaveLength(1);
  });

  it("numbers each cited source once and keeps unknown keys as plain text", () => {
    expect(html).toContain(`<a href="https://example.org/peat" target="_blank" rel="noopener">Gumbricht et al. 2017</a>`);
    expect(html).toContain("<li>IMERG</li>");
    expect(html).toContain("<li>mystery</li>");
    expect(html.match(/Gumbricht et al\. 2017/g)).toHaveLength(1);
  });

  it("marks missing evidence as unavailable", () => {
    expect(html.match(/<dd class="ev-na">unavailable<\/dd>/g)).toHaveLength(5);
    expect(html).toContain("<dd>40%<sup");
  });
});
