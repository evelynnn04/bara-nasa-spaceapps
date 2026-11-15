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

export interface PeriodComparison {
  total: number;
  previous: number | null;
  previousFrom: number;
  previousTo: number;
  historicalMean: number | null;
  historicalMedian: number | null;
  /** How many same-length windows from other years the historical values use. */
  historicalWindows: number;
  vsPrevious: number | null;
  vsMean: number | null;
  vsMedian: number | null;
}

/**
 * Compares a date range with the period just before it and with the same calendar window
 * in other years of the record.
 */
export function comparePeriod(s: Series, from: number, to: number): PeriodComparison {
  const total = sum(s, from, to);
  const len = to - from + 1;
  const previousFrom = from - len;
  const previousTo = from - 1;
  const previous = previousFrom >= s.firstDay ? sum(s, previousFrom, previousTo) : null;

  const span = Math.max(1, Math.ceil(len / 366));
  const windows: number[] = [];
  for (const dir of [-1, 1]) {
    for (let k = 1; ; k++) {
      const a = shiftYears(from, dir * k * span);
      const b = a + len - 1;
      if (a < s.firstDay || b > s.lastDay) break;
      windows.push(sum(s, a, b));
    }
  }
  const historicalMean = windows.length ? mean(windows) : null;
  const historicalMedian = windows.length ? median(windows) : null;
  return {
    total,
    previous,
    previousFrom,
    previousTo,
    historicalMean,
    historicalMedian,
    historicalWindows: windows.length,
    vsPrevious: deviation(total, previous),
    vsMean: deviation(total, historicalMean),
    vsMedian: deviation(total, historicalMedian),
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

/** Daily counts of one month, used to find the peak day. */
export function peakDayOfMonth(s: Series, year: number, month: number): Breakdown {
  const start = monthStart(year, month);
  const n = daysInMonth(year, month);
  const values = Array.from({ length: n }, (_, i) => sum(s, start + i, start + i));
  return withPeak(values.map((_, i) => String(i + 1)), values);
}

export interface Trend {
  years: number[];
  totals: number[];
  /** Fitted change per year, in fire cell-days. */
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
  mean: number[];
  median: number[];
  threshold: number[];
  unusual: boolean[];
  /** Index of the selected period in `labels`, or -1 when the chart shows the months of one year. */
  selectedIndex: number;
  selected: { label: string; value: number; mean: number; median: number; threshold: number };
  verdict: Verdict;
  /** Other periods in the record that were unusually high. */
  history: string[];
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

/** Compares one month with the same month in every other year of the record. */
export function anomalyForMonth(s: Series, year: number, month: number): AnomalyResult {
  const years = recordYears(s);
  const values = years.map((y) => monthCount(s, y, month));
  const refs = leaveOneOut(values);
  const unusual = values.map((v, i) => v > refs[i].threshold && v > 0);
  const idx = Math.max(0, years.indexOf(year));
  const ref = refs[idx];
  return {
    kind: "month",
    title: `${MONTHS[month]} in every year`,
    labels: years.map(String),
    values,
    mean: values.map(() => ref.mean),
    median: values.map(() => ref.median),
    threshold: values.map(() => ref.threshold),
    unusual,
    selectedIndex: idx,
    selected: { label: `${MONTHS[month]} ${years[idx]}`, value: values[idx], ...ref },
    verdict: verdictFor(values[idx], ref.median, ref.threshold),
    history: years.filter((_, i) => unusual[i] && i !== idx).map((y) => `${MONTHS[month]} ${y}`),
  };
}

/** Compares each month of one year with the same month in the other years, and the year total with other years. */
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
  const totals = grid.map((row) => row.reduce((a, b) => a + b, 0));
  const refs = leaveOneOut(totals);
  return {
    kind: "year",
    title: `Months of ${years[idx]} against other years`,
    labels: MONTHS,
    values,
    mean: meanM,
    median: medianM,
    threshold: thresholdM,
    unusual: values.map((v, m) => v > thresholdM[m] && v > 0),
    selectedIndex: -1,
    selected: { label: String(years[idx]), value: totals[idx], ...refs[idx] },
    verdict: verdictFor(totals[idx], refs[idx].median, refs[idx].threshold),
    history: years.filter((_, i) => i !== idx && totals[i] > refs[i].threshold && totals[i] > 0).map(String),
  };
}

export interface UnusualMonth {
  year: number;
  month: number;
  value: number;
  /** Median of the same calendar month in the other years. */
  usual: number;
  /** How many times the usual level, or Infinity when the usual level is zero. */
  ratio: number;
}

/** Every month in the record that was unusually high for its calendar month, strongest first. */
export function unusualMonths(s: Series): UnusualMonth[] {
  const out: UnusualMonth[] = [];
  for (let m = 0; m < 12; m++) {
    const a = anomalyForMonth(s, recordYears(s)[0], m);
    a.labels.forEach((y, i) => {
      if (!a.unusual[i]) return;
      const others = a.values.filter((_, j) => j !== i);
      const usual = median(others);
      out.push({ year: +y, month: m, value: a.values[i], usual, ratio: usual ? a.values[i] / usual : Infinity });
    });
  }
  return out.sort((x, y) => y.ratio - x.ratio || y.value - x.value);
}
