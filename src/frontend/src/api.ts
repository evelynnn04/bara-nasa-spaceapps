import type { Attribution, AttributionInfo, Cause } from "./attribution";
import { toDay } from "./dates";
import type { DayNight, Filters, Hotspots } from "./types";

/** Base URL of the backend; empty means the same origin (the dev server proxies `/api`). */
const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";

export interface Metrics {
  n_months: number;
  r_log: number | null;
  malr: number | null;
  bias: number | null;
  peak_matches: number;
  peak_years: number;
  peak_agreement: number | null;
  /** Peak month (1-12) per year: [MODIS, VIIRS]. */
  peaks: Record<string, [number, number]>;
  verdict: string;
}

/** Fitted factors of one half of the day. */
export interface Factors {
  base_factor: number;
  region_factor: Record<string, number>;
  month_factor: Record<string, number>;
  iterations: number;
}

/** A year in which MODIS and harmonised VIIRS name a different peak month. */
export interface PeakMiss {
  year: number;
  modis_peak: number;
  viirs_peak: number;
  modis_margin: number;
  viirs_margin: number;
  /** Share of resamples of MODIS's own days in which MODIS names the VIIRS month. */
  modis_resampled_share: number;
}

/** Factors and national evaluation of one hotspot type setting. */
export interface SettingMeta {
  factors: Record<"day" | "night", Factors>;
  verdict: string;
  evaluation: {
    leave_one_year_out: Metrics;
    day_only: Metrics;
    night_only: Metrics;
    peak_misses: PeakMiss[];
    story_2015: Record<string, number>;
    control_snpp_vs_noaa20: Metrics;
  };
}

export interface Meta {
  record: { start: string; end: string; splice: string; unobserved_days: number };
  last_observed: Record<string, string | null>;
  unit: string;
  grid_deg: number;
  method: { summary: string; fit_window: [string, string]; fitted: string; n0: number };
  default_hotspots: Hotspots;
  verdict: string;
  settings: Partial<Record<Hotspots, SettingMeta>>;
  /** When the tables were last replaced by an update and each stream last fetched (UTC); null for data built by hand. */
  data: { updated: string | null; fetched: Record<string, string> | null } | null;
}

export interface SeriesResponse {
  start: string;
  end: string;
  values: (number | null)[];
}

export interface CellsResponse {
  res_deg: number;
  count: number;
  active_cells: number;
  total: number;
  cells: { lon: number[]; lat: number[]; value: number[]; modis_px: number[]; viirs_px: number[]; frp_max: number[] };
  top: { lon: number; lat: number; size_deg: number; value: number; region_id: string } | null;
}

export interface AgreementMonth {
  year: number;
  month: number;
  paired_days: number;
  modis: number;
  viirs: number;
  modis_px: number;
  viirs_px: number;
}

export interface AgreementResponse {
  window: [string, string];
  months: AgreementMonth[];
  harmonised: Metrics;
  raw: Metrics;
}

export interface FireEvent {
  event: number;
  start: string;
  end: string;
  duration_days: number;
  peak_day: string;
  cells: number;
  cell_days: number;
  harmonised: number;
  /** Raw hotspots in the event. */
  pixels: number;
  frp_max: number;
  lon: number;
  lat: number;
  bbox: [number, number, number, number];
  regency_id: string | null;
  province_id: string | null;
  /** Likely cause; null when the attribution has not been built, absent from older backends. */
  attribution?: Attribution | null;
}

export interface EventsResponse {
  events: FireEvent[];
  /** null when the attribution has not been built. */
  attribution_disclaimer?: string | null;
}

/** Daily harmonised values over the record; unobserved days are 0 in `daily` and 1 in `missing`. */
export interface DailySeries {
  daily: Float64Array;
  missing: Uint8Array;
  firstDay: number;
  lastDay: number;
}

/** Query parameters selecting the area of the filters: `poly` for a drawn polygon, else `area` (the whole country while no polygon is drawn). */
export function areaParams(f: Filters): Record<string, string> {
  if (f.mode === "polygon") {
    if (!f.polygon || f.polygon.length < 3) return { area: "idn" };
    return { poly: f.polygon.map(([lon, lat]) => `${+lon.toFixed(4)},${+lat.toFixed(4)}`).join(";") };
  }
  return { area: f.regionIds.length ? f.regionIds.join(",") : "idn" };
}

/** URL of an API path with query parameters. */
export function apiUrl(path: string, params: Record<string, string> = {}): string {
  const q = new URLSearchParams(params).toString();
  return `${BASE}/api/${path}${q ? `?${q}` : ""}`;
}

/** Turns the series response into typed arrays indexed from its first day. */
export function parseSeries(body: SeriesResponse): DailySeries {
  const firstDay = toDay(body.start);
  const lastDay = toDay(body.end);
  const n = lastDay - firstDay + 1;
  if (body.values.length !== n) throw new Error(`series has ${body.values.length} values for ${n} days`);
  const daily = new Float64Array(n);
  const missing = new Uint8Array(n);
  body.values.forEach((v, i) => {
    if (v === null) missing[i] = 1;
    else daily[i] = v;
  });
  return { daily, missing, firstDay, lastDay };
}

async function getJson<T>(path: string, params: Record<string, string>, signal?: AbortSignal): Promise<T> {
  const res = await fetch(apiUrl(path, params), { signal });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (typeof body.detail === "string") detail = body.detail;
    } catch {
      /* keep the status text */
    }
    throw new Error(detail);
  }
  return res.json() as Promise<T>;
}

/** Which detections and hotspot types count, sent with every data request. */
export interface Counting {
  daynight: DayNight;
  hotspots: Hotspots;
}

/** Fetchers for the backend endpoints. Responses that depend only on area and counting are cached. */
export class Api {
  private readonly seriesCache = new Map<string, Promise<DailySeries>>();
  private readonly agreementCache = new Map<string, Promise<AgreementResponse>>();
  private attributionInfo: Promise<AttributionInfo> | null = null;

  meta(): Promise<Meta> {
    return getJson("meta", {});
  }

  series(f: Filters, c: Counting): Promise<DailySeries> {
    const params = { ...areaParams(f), ...c };
    return this.cached(this.seriesCache, params, () => getJson<SeriesResponse>("series", params).then(parseSeries));
  }

  agreement(f: Filters, c: Counting): Promise<AgreementResponse> {
    const params = { ...areaParams(f), ...c };
    return this.cached(this.agreementCache, params, () => getJson<AgreementResponse>("agreement", params));
  }

  cells(f: Filters, c: Counting, signal?: AbortSignal): Promise<CellsResponse> {
    return getJson("cells", { ...areaParams(f), from: f.start, to: f.end, ...c }, signal);
  }

  /** Value quantiles of one cell over one timeline step, pooled over the whole record of the area. */
  cellScale(f: Filters, interval: string, c: Counting): Promise<{ quantiles: number[]; values: number[] }> {
    return getJson("cells/scale", { ...areaParams(f), interval, ...c });
  }

  events(f: Filters, hotspots: Hotspots, signal?: AbortSignal, limit = 5, cause: Cause | null = null): Promise<EventsResponse> {
    const params: Record<string, string> = { ...areaParams(f), from: f.start, to: f.end, hotspots, limit: String(limit) };
    if (cause) params.cause = cause;
    return getJson("events", params, signal);
  }

  /**
   * How causes are attributed, with labels and citations. Reads as not available when the request fails or takes
   * longer than 8 s, so the events never wait on it; a failure is not kept, the next call asks again.
   */
  attribution(): Promise<AttributionInfo> {
    if (!this.attributionInfo) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 8000);
      this.attributionInfo = getJson<AttributionInfo>("attribution", {}, ctl.signal)
        .finally(() => clearTimeout(timer))
        .catch((): AttributionInfo => {
          this.attributionInfo = null;
          return { available: false, disclaimer: null, categories: [], sources: {} };
        });
    }
    return this.attributionInfo;
  }

  /**
   * Address of the raw detections CSV. The browser downloads it straight from the API, streaming to
   * disk, because a long period runs to hundreds of megabytes.
   */
  detectionsUrl(f: Filters, c: Counting): string {
    return apiUrl("detections.csv", { ...areaParams(f), from: f.start, to: f.end, ...c });
  }

  /**
   * Asks for the raw detections and stops once the response starts, throwing the API's message when it
   * refuses (a bad area, missing data), so the page can report it before starting the real download.
   */
  async checkDetections(f: Filters, c: Counting): Promise<void> {
    const ctl = new AbortController();
    const res = await fetch(this.detectionsUrl(f, c), { signal: ctl.signal });
    if (res.ok) {
      ctl.abort();
      return;
    }
    const body = await res.json().catch(() => ({}));
    throw new Error(typeof body.detail === "string" ? body.detail : `HTTP ${res.status}`);
  }

  private cached<T>(cache: Map<string, Promise<T>>, params: Record<string, string>, load: () => Promise<T>): Promise<T> {
    const key = new URLSearchParams(params).toString();
    let hit = cache.get(key);
    if (!hit) {
      hit = load();
      hit.catch(() => cache.delete(key));
      cache.set(key, hit);
      if (cache.size > 40) cache.delete(cache.keys().next().value!);
    }
    return hit;
  }
}
