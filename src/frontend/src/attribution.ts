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
    normal_mm_per_day: number;
    share_of_normal: number;
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

/** How an indicator reads: missing data is its own state, never "not met". */
export function indicatorState(met: boolean | null): { mark: "✓" | "✗" | "?"; word: "met" | "not met" | "data unavailable" } {
  if (met === null) return { mark: "?", word: "data unavailable" };
  return met ? { mark: "✓", word: "met" } : { mark: "✗", word: "not met" };
}

/** Indicators grouped by the cause they support, keeping the order they come in. */
export function groupIndicators(list: Indicator[]): { category: Cause; items: Indicator[] }[] {
  const groups: { category: Cause; items: Indicator[] }[] = [];
  for (const ind of list) {
    let g = groups.find((x) => x.category === ind.category);
    if (!g) groups.push((g = { category: ind.category, items: [] }));
    g.items.push(ind);
  }
  return groups;
}

const pct1 = (f: number) => `${Math.round(f * 1000) / 10}%`;
const pct0 = (f: number) => `${Math.round(f * 100)}%`;
const range = (a: string | number, b: string | number, sep: string) => (a === b ? String(a) : `${a}${sep}${b}`);
const LANDCOVER: Record<string, string> = { shrub_savanna: "shrub/savanna" };

/** The evidence as label and plain-figure value, one row per dataset, "unavailable" where it is missing. */
export function evidenceRows(e: Evidence): { label: string; value: string }[] {
  const na = "unavailable";
  const fc = e.forest_cover_2000;
  const fl = e.forest_loss;
  const lc = e.landcover;
  const rf = e.rainfall;
  const cl = e.climate;
  const lcValue = () => {
    const parts = Object.entries(lc!.shares)
      .filter(([, s]) => Math.round(s * 100) > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([k, s]) => `${LANDCOVER[k] ?? k} ${pct0(s)}`);
    return `${parts.join(", ") || "no classified land"} (${lc!.year})`;
  };
  const clValue = () => {
    const parts = [cl!.oni != null ? `ONI ${cl!.oni.toFixed(2)}` : null, cl!.dmi != null ? `DMI ${cl!.dmi.toFixed(2)}` : null].filter(Boolean);
    return parts.length ? `${parts.join(", ")} (${cl!.month})` : na;
  };
  return [
    { label: "Forest cover in 2000", value: fc ? pct1(fc.share) : na },
    { label: "Forest loss", value: fl ? `${pct1(fl.share)} (expected ${pct1(fl.expected_share)}), ${range(fl.years[0], fl.years[1], "–")}` : na },
    { label: "Land cover", value: lc ? lcValue() : na },
    { label: "Peat", value: e.peat ? pct1(e.peat.share) : na },
    {
      label: "Rainfall",
      value: rf ? `${rf.mm_per_day.toFixed(1)} mm/day, ${pct0(rf.share_of_normal)} of normal (${range(rf.months[0], rf.months[1], " to ")})` : na,
    },
    { label: "Climate", value: cl ? clValue() : na },
  ];
}
