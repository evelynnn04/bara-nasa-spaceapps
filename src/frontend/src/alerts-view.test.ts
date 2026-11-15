import { describe, expect, it } from "vitest";
import { matchRegions } from "./alerts-view";
import type { Region } from "./types";

const region = (id: string, name: string, level: Region["level"], parentId: string | null = null): Region =>
  ({ id, name, level, parentId, bbox: [0, 0, 1, 1] });

const regions = [
  region("idn", "Indonesia", "country"),
  region("idn-riau", "Riau", "province", "idn"),
  region("idn-riau-islands", "Riau Islands", "province", "idn"),
  region("idn-riau-pelalawan", "Pelalawan", "regency", "idn-riau"),
  region("idn-sumsel-ogan", "Ogan Komering Ilir", "regency", "idn-riau"),
];

describe("matchRegions", () => {
  it("matches the start of the name or of any word, provinces first", () => {
    expect(matchRegions(regions, "ri", new Set()).map((r) => r.id)).toEqual(["idn-riau", "idn-riau-islands"]);
    expect(matchRegions(regions, "kom", new Set()).map((r) => r.id)).toEqual(["idn-sumsel-ogan"]);
    expect(matchRegions(regions, "  PEL ", new Set()).map((r) => r.id)).toEqual(["idn-riau-pelalawan"]);
  });

  it("leaves out chosen regions, empty queries and anything past the limit", () => {
    expect(matchRegions(regions, "riau", new Set(["idn-riau"])).map((r) => r.id)).toEqual(["idn-riau-islands"]);
    expect(matchRegions(regions, "", new Set())).toEqual([]);
    expect(matchRegions(regions, "i", new Set(), 2)).toHaveLength(2);
  });
});
