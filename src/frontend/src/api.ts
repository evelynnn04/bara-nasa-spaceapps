import { toDay } from "./dates";
import type { DayNight, Filters } from "./types";

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

export interface Meta {
  record: { start: string; end: string; splice: string; unobserved_days: number };
  last_observed: Record<string, string | null>;
  unit: string;
  grid_deg: number;
  method: {
    summary: string;
    base_factor: number;
    region_factor: Record<string, number>;
    month_factor: Record<string, number>;
    fit_window: [string, string];
    fitted: string;
  };
  verdict: string;
  evaluation: {
    leave_one_year_out: Metrics;
    story_2015: Record<string, number>;
    control_snpp_vs_noaa20: Metrics;
  };
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
  pixels: number;
  frp_max: number;
  lon: number;
  lat: number;
  bbox: [number, number, number, number];
  regency_id: string | null;
  province_id: string | null;
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

/** Fetchers for the backend endpoints. Responses that depend only on area and day/night are cached. */
export class Api {
  private readonly seriesCache = new Map<string, Promise<DailySeries>>();
  private readonly agreementCache = new Map<string, Promise<AgreementResponse>>();

  meta(): Promise<Meta> {
    return getJson("meta", {});
  }

  series(f: Filters, daynight: DayNight): Promise<DailySeries> {
    const params = { ...areaParams(f), daynight };
    return this.cached(this.seriesCache, params, () => getJson<SeriesResponse>("series", params).then(parseSeries));
  }

  agreement(f: Filters, daynight: DayNight): Promise<AgreementResponse> {
    const params = { ...areaParams(f), daynight };
    return this.cached(this.agreementCache, params, () => getJson<AgreementResponse>("agreement", params));
  }

  cells(f: Filters, daynight: DayNight, signal?: AbortSignal): Promise<CellsResponse> {
    return getJson("cells", { ...areaParams(f), from: f.start, to: f.end, daynight }, signal);
  }

  events(f: Filters, signal?: AbortSignal, limit = 5): Promise<{ events: FireEvent[] }> {
    return getJson("events", { ...areaParams(f), from: f.start, to: f.end, limit: String(limit) }, signal);
  }

  /** Downloads raw detections as CSV; returns the file, its name and how many rows matched in total. */
  async detections(f: Filters, daynight: DayNight): Promise<{ blob: Blob; name: string; total: number; limit: number }> {
    const res = await fetch(apiUrl("detections.csv", { ...areaParams(f), from: f.start, to: f.end, daynight }));
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(typeof body.detail === "string" ? body.detail : `HTTP ${res.status}`);
    }
    const name = res.headers.get("Content-Disposition")?.match(/filename="([^"]+)"/)?.[1] ?? "detections.csv";
    return { blob: await res.blob(), name, total: Number(res.headers.get("X-Total-Rows") ?? 0), limit: Number(res.headers.get("X-Row-Limit") ?? 0) };
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
