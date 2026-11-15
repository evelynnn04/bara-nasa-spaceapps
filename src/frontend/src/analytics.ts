import { MONTHS, daysInMonth, monthStart, parts } from "./dates";

/** Daily values over a continuous record; `daily[0]` is `firstDay`. */
export interface Series {
  daily: Float64Array;
  firstDay: number;
  lastDay: number;
}

export type Verdict = "usual" | "above" | "unusual";

/** How many standard deviations above the historical average counts as unusually high. */
export const UNUSUAL_SD = 1.5;

export function mean(v: number[]): number {
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
}

export function median(v: number[]): number {
  if (!v.length) return 0;
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Population standard deviation. */
export function std(v: number[]): number {
  if (v.length < 2) return 0;
  const m = mean(v);
  return Math.sqrt(mean(v.map((x) => (x - m) ** 2)));
}

/** Percentage change from `ref` to `value`, or null when there is no reference to compare with. */
export function deviation(value: number, ref: number | null): number | null {
  if (ref === null || ref === 0) return null;
  return ((value - ref) / ref) * 100;
}

/** Sum of daily counts between two days (inclusive), clamped to the record. */
export function sum(s: Series, from: number, to: number): number {
  const a = Math.max(from, s.firstDay) - s.firstDay;
  const b = Math.min(to, s.lastDay) - s.firstDay;
  let total = 0;
  for (let i = a; i <= b; i++) total += s.daily[i];
  return total;
}

/** Full calendar years covered by the record. */
export function recordYears(s: Series): number[] {
  const a = parts(s.firstDay);
  const b = parts(s.lastDay);
  const years: number[] = [];
  for (let y = a.year; y <= b.year; y++) years.push(y);
  return years;
}

/** Count for one zero-based month. */
export function monthCount(s: Series, year: number, month: number): number {
  const from = monthStart(year, month);
  return sum(s, from, from + daysInMonth(year, month) - 1);
}

/** True when a month lies entirely outside the record. */
export function monthOutsideRecord(s: Series, year: number, month: number): boolean {
  const from = monthStart(year, month);
  return from > s.lastDay || from + daysInMonth(year, month) - 1 < s.firstDay;
}

function shiftYears(day: number, years: number): number {
  const p = parts(day);
  return Math.round(Date.UTC(p.year + years, p.month, p.date) / 86_400_000);
}

/** A date range's total against the same dates one year earlier. */
export interface YearOnYear {
  total: number;
  /** Total over the same dates a year earlier, or null when they fall before the record. */
  previous: number | null;
  previousFrom: number;
  previousTo: number;
  /** Percentage change from the year before, or null when there is nothing to compare with. */
  change: number | null;
  /** True when the range is shorter than a year, the only case where the comparison is shown. */
  shorterThanYear: boolean;
}

/** Compares a date range with the same dates one year earlier (29 February maps to 1 March). */
export function yearOnYear(s: Series, from: number, to: number): YearOnYear {
  const total = sum(s, from, to);
  const previousFrom = shiftYears(from, -1);
  const previousTo = shiftYears(to, -1);
  const previous = previousFrom >= s.firstDay ? sum(s, previousFrom, previousTo) : null;
  return {
    total,
    previous,
    previousFrom,
    previousTo,
    change: deviation(total, previous),
    shorterThanYear: to < shiftYears(from, 1) - 1,
  };
}

export interface Breakdown {
  labels: string[];
  values: number[];
  /** Index of the highest value, or -1 when everything is zero. */
  peak: number;
}

function withPeak(labels: string[], values: number[]): Breakdown {
  let peak = -1;
  values.forEach((v, i) => {
    if (v > 0 && (peak < 0 || v > values[peak])) peak = i;
  });
  return { labels, values, peak };
}

/** Monthly counts of one year, used to find the peak month. */
export function peakMonthOfYear(s: Series, year: number): Breakdown {
  return withPeak(MONTHS, MONTHS.map((_, m) => monthCount(s, year, m)));
}

export interface Trend {
  years: number[];
  totals: number[];
  /** Fitted change per year, in hotspots. */
  slope: number;
  /** Fitted change per year relative to the average year, in percent. */
  percentPerYear: number;
  /** Fitted value for each year, for drawing the trend line. */
  fitted: number[];
}

/** Least-squares trend of annual totals. */
export function annualTrend(s: Series): Trend {
  const years = recordYears(s);
  const totals = years.map((y) => sum(s, monthStart(y, 0), monthStart(y + 1, 0) - 1));
  const xm = mean(years);
  const ym = mean(totals);
  let num = 0;
  let den = 0;
  years.forEach((x, i) => {
    num += (x - xm) * (totals[i] - ym);
    den += (x - xm) ** 2;
  });
  const slope = den ? num / den : 0;
  return {
    years,
    totals,
    slope,
    percentPerYear: ym ? (slope / ym) * 100 : 0,
    fitted: years.map((x) => ym + slope * (x - xm)),
  };
}

export interface Climatology {
  /** Average count for each calendar month across the record. */
  average: number[];
  /** The three most fire-prone months, highest first. */
  top: number[];
  /** First and last month of the typical fire season (may wrap past December), or null with no fires. */
  season: [number, number] | null;
}

/** Average fire activity per calendar month and the typical fire season. */
export function climatology(s: Series): Climatology {
  const years = recordYears(s);
  const average = MONTHS.map((_, m) => mean(years.map((y) => monthCount(s, y, m))));
  const top = average
    .map((v, m) => [v, m] as const)
    .filter(([v]) => v > 0)
    .sort((a, b) => b[0] - a[0])
    .slice(0, 3)
    .map(([, m]) => m);
  if (!top.length) return { average, top, season: null };
  const peak = top[0];
  const cut = average[peak] * 0.5;
  let a = peak;
  let b = peak;
  for (let i = 0; i < 11 && average[(a + 11) % 12] >= cut; i++) a = (a + 11) % 12;
  for (let i = 0; i < 11 && average[(b + 1) % 12] >= cut && (b + 1) % 12 !== a; i++) b = (b + 1) % 12;
  return { average, top, season: [a, b] };
}

export interface AnomalyResult {
  kind: "month" | "year";
  title: string;
  labels: string[];
  values: number[];
  /** Reference lines and the top of the usual range, per point. */
  mean: number[];
  median: number[];
  threshold: number[];
  unusual: boolean[];
  /** How each point compares with the same period in the other years. */
  verdicts: Verdict[];
}

function verdictFor(value: number, med: number, threshold: number): Verdict {
  if (value > threshold && value > 0) return "unusual";
  if (value > med) return "above";
  return "usual";
}

/** Leave-one-out reference values: each item is compared with all the other items. */
function leaveOneOut(values: number[]): { mean: number; median: number; threshold: number }[] {
  return values.map((_, i) => {
    const others = values.filter((__, j) => j !== i);
    const m = mean(others);
    return { mean: m, median: median(others), threshold: m + UNUSUAL_SD * std(others) };
  });
}

/**
 * One calendar month in every year of the record, each year against the other years (leave one out).
 * The average, median and usual range at each point are that year's references, the same ones its
 * reading uses, so a point drawn inside the usual range is never called unusual.
 */
export function anomalyForMonth(s: Series, month: number): AnomalyResult {
  const years = recordYears(s);
  const values = years.map((y) => monthCount(s, y, month));
  const refs = leaveOneOut(values);
  return {
    kind: "month",
    title: `${MONTHS[month]} in every year`,
    labels: years.map(String),
    values,
    mean: refs.map((r) => r.mean),
    median: refs.map((r) => r.median),
    threshold: refs.map((r) => r.threshold),
    unusual: values.map((v, i) => v > refs[i].threshold && v > 0),
    verdicts: values.map((v, i) => verdictFor(v, refs[i].median, refs[i].threshold)),
  };
}

/** Compares each month of one year with the same month in the other years. */
export function anomalyForYear(s: Series, year: number): AnomalyResult {
  const years = recordYears(s);
  const grid = years.map((y) => MONTHS.map((_, m) => monthCount(s, y, m)));
  const idx = Math.max(0, years.indexOf(year));
  const others = grid.filter((_, i) => i !== idx);
  const meanM: number[] = [];
  const medianM: number[] = [];
  const thresholdM: number[] = [];
  MONTHS.forEach((_, m) => {
    const col = others.map((row) => row[m]);
    const mu = mean(col);
    meanM.push(mu);
    medianM.push(median(col));
    thresholdM.push(mu + UNUSUAL_SD * std(col));
  });
  const values = grid[idx];
  return {
    kind: "year",
    title: `Months of ${years[idx]} against other years`,
    labels: MONTHS,
    values,
    mean: meanM,
    median: medianM,
    threshold: thresholdM,
    unusual: values.map((v, m) => v > thresholdM[m] && v > 0),
    verdicts: values.map((v, m) => verdictFor(v, medianM[m], thresholdM[m])),
  };
}
