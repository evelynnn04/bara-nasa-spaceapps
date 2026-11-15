import { isCause, type Cause } from "./attribution";
import { RAMPS, type RampName } from "./ramps";
import type { Interval } from "./timeline";
import type { DayNight, Filters, Hotspots, LngLat } from "./types";

export interface ViewState {
  filters: Filters;
  ramp: RampName;
  daynight: DayNight;
  hotspots: Hotspots;
  /** Show only fire events attributed to this cause; null shows every event. */
  cause: Cause | null;
  /** Timeline interval the viewer picked; null follows the default for the length of the dates. */
  step: Interval | null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Reads filters, palette, the day/night filter, the hotspot types and the fire cause from the page URL, falling back to `defaults` for anything missing or invalid.
 * Region ids are kept only when `hasRegion` knows them, and dates are clamped to `[minDate, maxDate]`.
 */
export function readUrlState(
  defaults: ViewState,
  hasRegion: (id: string) => boolean,
  minDate: string,
  maxDate: string,
): ViewState {
  const q = new URLSearchParams(location.search);
  const f: Filters = { ...defaults.filters };

  const mode = q.get("mode");
  if (mode === "area" || mode === "polygon") f.mode = mode;

  const areas = q.get("area")?.split(",").filter(hasRegion);
  if (areas?.length) f.regionIds = areas;

  const clamp = (d: string) => (d < minDate ? minDate : d > maxDate ? maxDate : d);
  const from = q.get("from");
  const to = q.get("to");
  if (from && DATE_RE.test(from)) f.start = clamp(from);
  if (to && DATE_RE.test(to)) f.end = clamp(to);
  if (f.start > f.end) [f.start, f.end] = [f.end, f.start];

  const ring = parseRing(q.get("poly"));
  if (ring) f.polygon = ring;

  const palette = q.get("palette");
  const ramp = palette && palette in RAMPS ? (palette as RampName) : defaults.ramp;
  const dn = q.get("dn");
  const daynight = dn === "day" || dn === "night" || dn === "all" ? dn : defaults.daynight;
  const ht = q.get("ht");
  const hotspots = ht === "all" || ht === "vegetation" ? ht : defaults.hotspots;
  const c = q.get("cause");
  const cause = isCause(c) ? c : defaults.cause;
  const st = q.get("step");
  const step = st === "day" || st === "month" || st === "year" ? st : defaults.step;
  return { filters: f, ramp, daynight, hotspots, cause, step };
}

/** Writes the state into the URL query, leaving out values equal to `defaults`, without adding a history entry. */
export function writeUrlState(state: ViewState, defaults: ViewState): void {
  const { filters: f, ramp, daynight, hotspots, cause, step } = state;
  const d = defaults.filters;
  const q = new URLSearchParams();
  if (f.mode !== d.mode) q.set("mode", f.mode);
  if (f.regionIds.join(",") !== d.regionIds.join(",")) q.set("area", f.regionIds.join(","));
  if (f.start !== d.start) q.set("from", f.start);
  if (f.end !== d.end) q.set("to", f.end);
  if (f.polygon) q.set("poly", f.polygon.map(([lon, lat]) => `${+lon.toFixed(4)},${+lat.toFixed(4)}`).join(";"));
  if (ramp !== defaults.ramp) q.set("palette", ramp);
  if (daynight !== defaults.daynight) q.set("dn", daynight);
  if (hotspots !== defaults.hotspots) q.set("ht", hotspots);
  if (cause && cause !== defaults.cause) q.set("cause", cause);
  if (step && step !== defaults.step) q.set("step", step);
  const search = q.toString();
  const url = `${location.pathname}${search ? `?${search.replace(/%2C/g, ",").replace(/%3B/g, ";")}` : ""}${location.hash}`;
  if (url !== `${location.pathname}${location.search}${location.hash}`) history.replaceState(null, "", url);
}

/** Parses "lon,lat;lon,lat;..." into a ring of at least three valid corners, or null. */
function parseRing(raw: string | null): LngLat[] | null {
  if (!raw) return null;
  const ring: LngLat[] = [];
  for (const pair of raw.split(";")) {
    const [lon, lat] = pair.split(",").map(Number);
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 90) return null;
    ring.push([lon, lat]);
  }
  return ring.length >= 3 ? ring : null;
}
