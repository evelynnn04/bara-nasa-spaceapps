import { escapeXml } from "./format";

/** Likely cause of a fire event, from the environmental evidence the backend gathers (see docs/attribution.md). */

export type Cause = "land_clearing" | "agricultural_burning" | "wildfire" | "unknown";
export type Confidence = "high" | "medium" | "low";

/** Causes in display order. */
export const CAUSES: Cause[] = ["land_clearing", "agricultural_burning", "wildfire", "unknown"];

export interface Indicator {
  id: string;
  category: Exclude<Cause, "unknown">;
  points: number;
  /** null: the data needed to check it is unavailable. */
  met: boolean | null;
  text: string;
  sources: string[];
}

/** Each entry is null when its dataset is missing or does not cover the event. Shares are fractions 0-1. */
export interface Evidence {
  forest_cover_2000: { share: number; canopy_min_percent: number; source: string } | null;
  forest_loss: { share: number; expected_share: number; excess_share: number; years: [number, number]; source: string } | null;
  landcover: { year: number; source: string; shares: Record<string, number> } | null;
  peat: { share: number; source: string } | null;
  rainfall: {
    mm_per_day: number;
    /** null when there is no rainfall normal for the cell (a normal of 0). */
    normal_mm_per_day: number | null;
    share_of_normal: number | null;
    months: [string, string];
    normal_years: [number, number];
    source: string;
  } | null;
  climate: { month: string; oni: number | null; dmi: number | null; sources: string[] } | null;
}

export interface Attribution {
  category: Cause;
  label: string;
  /** null when the cause is unknown. */
  confidence: Confidence | null;
  scores: Partial<Record<Cause, number>>;
  indicators: Indicator[];
  evidence: Evidence;
}

/** The method as served by `/api/attribution`; only the fields the dashboard reads. */
export interface AttributionInfo {
  available: boolean;
  disclaimer: string | null;
  categories: { id: Cause; label: string }[];
  sources: Record<string, { citation: string; url: string | null }>;
}

const LABELS: Record<Cause, string> = {
  land_clearing: "Land clearing",
  agricultural_burning: "Agricultural burning",
  wildfire: "Wildfire",
  unknown: "Cause unclear",
};

export function isCause(v: string | null | undefined): v is Cause {
  return v != null && (CAUSES as string[]).includes(v);
}

export function causeLabel(c: Cause): string {
  return LABELS[c];
}

/** One line for an event's badge. */
export function badgeText(a: Attribution | null | undefined): string {
  if (!a) return "Cause not assessed yet";
  if (a.category === "unknown" || !a.confidence) return LABELS.unknown;
  return `${a.label || LABELS[a.category]} · ${a.confidence} confidence`;
}

const pct1 = (f: number) => `${Math.round(f * 1000) / 10}%`;
const pct0 = (f: number) => `${Math.round(f * 100)}%`;
const SHORT: Record<Cause, string> = { land_clearing: "clearing", agricultural_burning: "farming", wildfire: "wildfire", unknown: "unclear" };

/** Dataset an indicator needs, named for the "No data" line. */
const NEEDS: Record<string, string> = {
  forest_loss_strong: "forest loss",
  forest_loss_some: "forest loss",
  tree_cover_before: "forest loss",
  no_clearing: "forest loss",
  cropland_dominant: "land cover",
  cropland_present: "land cover",
  natural_vegetation: "land cover",
  dry_months: "rainfall",
  rain_deficit: "rainfall",
  climate_driver: "climate index",
  peatland: "peat",
};

/** A met indicator in a few words, with the figure behind it when the evidence has one. */
function shortIndicator(ind: Indicator, e: Evidence): string {
  const share = (keys: string[]) => (e.landcover ? keys.reduce((sum, k) => sum + (e.landcover!.shares[k] ?? 0), 0) : null);
  switch (ind.id) {
    case "forest_loss_strong":
    case "forest_loss_some":
      return e.forest_loss ? `Forest loss ${pct1(e.forest_loss.share)} vs usual ${pct1(e.forest_loss.expected_share)}` : "Forest loss above usual";
    case "tree_cover_before":
      return e.forest_cover_2000 ? `Forested in 2000 (${pct0(e.forest_cover_2000.share)})` : "Forested in 2000";
    case "cropland_dominant":
    case "cropland_present": {
      const f = share(["cropland", "mosaic"]);
      return f !== null ? `Cropland ${pct0(f)} of the area` : "Cropland";
    }
    case "small_short":
      return "Small, short fire";
    case "no_clearing":
      return "No sign of forest clearing";
    case "dry_months":
      return e.rainfall ? `Dry: ${e.rainfall.mm_per_day.toFixed(1)} mm/day` : "Dry months";
    case "rain_deficit":
      return e.rainfall?.share_of_normal != null ? `Rain ${pct0(e.rainfall.share_of_normal)} of normal` : "Rain below normal";
    case "climate_driver": {
      const c = e.climate;
      const v = [c?.oni != null ? `ONI ${c.oni.toFixed(2)}` : "", c?.dmi != null ? `DMI ${c.dmi.toFixed(2)}` : ""].filter(Boolean).join(", ");
      return `El Niño or positive IOD${v ? ` (${v})` : ""}`;
    }
    case "peatland":
      return e.peat ? `Peat ${pct1(e.peat.share)} of the area` : "Peatland";
    case "natural_vegetation": {
      const f = share(["forest", "shrub_savanna", "grassland", "wetland"]);
      return f !== null ? `Natural vegetation ${pct0(f)}` : "Natural vegetation";
    }
    case "large_long":
      return "Large or long-lasting fire";
    default:
      return ind.text;
  }
}

/** "Hansen 2013" from "Hansen, M. C. et al. (2013). ...", else the citation's first sentence, else the key. */
function shortSource(key: string, sources: AttributionInfo["sources"]): string {
  const c = sources[key]?.citation;
  if (!c) return key;
  const m = c.match(/^([^,(]+)[^(]*\((\d{4})\)/);
  return m ? `${m[1].trim()} ${m[2]}` : c.split(".")[0].trim();
}

/** Datasets the causes are read from, credited on the map. */
const CAUSE_DATA = ["hansen2013", "mcd12q1", "gumbricht2017", "imerg", "oni"];

/** Credit line for the map's credits: each dataset behind the causes, linked to its source. Empty without sources. */
export function causeCredit(sources: AttributionInfo["sources"]): string {
  const items = CAUSE_DATA.filter((k) => sources[k]).map((k) => {
    const name = escapeXml(shortSource(k, sources));
    const url = sources[k].url;
    return url ? `<a href="${escapeXml(url)}" target="_blank" rel="noopener">${name}</a>` : name;
  });
  return items.length ? `Fire causes: ${items.join(", ")}` : "";
}

/**
 * The reason for a cause in a few short lines, for the hover card: the cause and its confidence, the points per
 * cause, the evidence met for the named cause (for every cause when it is unclear) and the datasets that were
 * missing. Unavailable indicators are listed as missing data, never as not met; indicators that were checked and
 * not met are left out.
 */
export function whySummary(a: Attribution): string {
  const unclear = a.category === "unknown";
  const shown = a.indicators.filter((i) => unclear || i.category === a.category);
  const met = shown.filter((i) => i.met === true);
  const missing = [...new Set(shown.filter((i) => i.met === null).map((i) => NEEDS[i.id] ?? i.id))];
  const order = unclear ? CAUSES.filter((c) => c !== "unknown") : [a.category, ...CAUSES.filter((c) => c !== a.category && c !== "unknown")];
  const points = order.map((c) => `${SHORT[c]} ${a.scores[c] ?? 0}`).join(" · ");
  return [
    badgeText(a),
    unclear ? "No cause has enough support, or two tie." : "",
    `Points: ${points}`,
    ...(met.length ? met.map((i) => `✓ ${shortIndicator(i, a.evidence)}`) : ["No indicator met"]),
    missing.length ? `? No data: ${missing.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
