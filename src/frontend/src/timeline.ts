import type { CellsResponse } from "./api";
import { MONTHS, formatDay, fromDay, monthStart, parts, toDay } from "./dates";
import { quantileBreaks } from "./ramps";

/** Length of one step of the map timeline. */
export type Interval = "day" | "month" | "year";

/** One step of the map timeline: a period inside the selected dates, its label and its short tick label. */
export interface Frame {
  from: string;
  to: string;
  label: string;
  tick: string;
}

/** Longest range, in days, that opens the timeline in days. */
export const MAX_DAY_DEFAULT = 62;
/** Longest range, in calendar months, that opens the timeline in months. */
export const MAX_MONTH_DEFAULT = 36;

/** The interval the timeline opens with: days for up to two months, months for up to three years, else years. */
export function defaultInterval(start: string, end: string): Interval {
  const a = toDay(start);
  const b = toDay(end);
  if (b - a + 1 <= MAX_DAY_DEFAULT) return "day";
  const pa = parts(a);
  const pb = parts(b);
  return (pb.year - pa.year) * 12 + pb.month - pa.month + 1 <= MAX_MONTH_DEFAULT ? "month" : "year";
}

/** Splits the selected dates into timeline steps of one interval; the first and last steps are cut to the dates. */
export function timeFrames(start: string, end: string, interval: Interval): Frame[] {
  const a = toDay(start);
  const b = toDay(end);
  const frames: Frame[] = [];
  if (interval === "day") {
    for (let d = a; d <= b; d++) {
      const p = parts(d);
      frames.push({ from: fromDay(d), to: fromDay(d), label: formatDay(d), tick: `${p.date} ${MONTHS[p.month]}` });
    }
    return frames;
  }
  const pa = parts(a);
  const pb = parts(b);
  const clip = (from: number, to: number, label: string, tick: string) =>
    frames.push({ from: fromDay(Math.max(from, a)), to: fromDay(Math.min(to, b)), label, tick });
  if (interval === "month") {
    const months = (pb.year - pa.year) * 12 + pb.month - pa.month + 1;
    for (let i = 0; i < months; i++) {
      const y = pa.year + Math.floor((pa.month + i) / 12);
      const m = (pa.month + i) % 12;
      // The first step and every January carry the year, so a tick row spanning years stays readable
      clip(monthStart(y, m), monthStart(y, m + 1) - 1, `${MONTHS[m]} ${y}`, i === 0 || m === 0 ? `${MONTHS[m]} ${y}` : MONTHS[m]);
    }
    return frames;
  }
  for (let y = pa.year; y <= pb.year; y++) clip(monthStart(y, 0), monthStart(y + 1, 0) - 1, String(y), String(y));
  return frames;
}

/** Index of the step holding `date`, clamped to the first or last step when the date is outside them. */
export function frameAt(frames: Frame[], date: string): number {
  if (!frames.length) return 0;
  if (date < frames[0].from) return 0;
  for (let i = 0; i < frames.length; i++) if (date <= frames[i].to) return i;
  return frames.length - 1;
}

/** `date` moved by whole days, months or years; a day past the end of a shorter month lands on its last day. */
export function shiftDate(date: string, unit: Interval, by: number): string {
  const p = parts(toDay(date));
  if (unit === "day") return fromDay(toDay(date) + by);
  const months = p.year * 12 + p.month + (unit === "month" ? by : by * 12);
  const y = Math.floor(months / 12);
  const m = months - y * 12;
  const last = monthStart(y, m + 1) - monthStart(y, m);
  return fromDay(monthStart(y, m) + Math.min(p.date, last) - 1);
}

/** Indexes of the steps that get a tick label: the first, the last, and evenly spaced ones between, at most `max`. */
export function labelledTicks(count: number, max: number): number[] {
  if (count <= 0) return [];
  if (count <= max) return Array.from({ length: count }, (_, i) => i);
  const every = Math.ceil((count - 1) / (max - 1));
  const out: number[] = [];
  for (let i = 0; i < count - 1; i += every) out.push(i);
  // Drop a label that would crowd the last one
  if (count - 1 - out[out.length - 1] < every / 2) out.pop();
  out.push(count - 1);
  return out;
}

/** Colour classes shared by several steps, from all their cell values pooled, so an animation compares like with like. */
export function sharedScale(steps: CellsResponse[], classes: number): number[] {
  const values: number[] = [];
  for (const s of steps) for (const v of s.cells.value) values.push(v);
  return quantileBreaks(values, classes);
}

/** A tick on the timeline axis at the start of a day; major ticks get a label, in a bold part and a plain part. */
export interface AxisTick {
  day: number;
  major: boolean;
  strong?: string;
  rest?: string;
}

/**
 * Ticks of the timeline axis for days `from` to `to` at a zoom level: years with months between them, months with
 * days between them when days are at least `minorPx` apart, or every day with the month on each first day.
 * At the day zoom the two days after a month label stay unlabelled, so the labels do not run into each other.
 */
export function axisTicks(from: number, to: number, zoom: Interval, pxPerDay: number, minorPx = 4): AxisTick[] {
  const out: AxisTick[] = [];
  for (let d = from; d <= to; d++) {
    const p = parts(d);
    const month = MONTHS[p.month].toUpperCase();
    if (zoom === "year") {
      if (p.month === 0 && p.date === 1) out.push({ day: d, major: true, strong: String(p.year) });
      else if (p.date === 1) out.push({ day: d, major: false });
    } else if (zoom === "month") {
      if (p.date === 1) out.push({ day: d, major: true, strong: month, rest: String(p.year) });
      else if (pxPerDay >= minorPx) out.push({ day: d, major: false });
    } else if (p.date === 1) out.push({ day: d, major: true, strong: month, rest: String(p.year) });
    else out.push({ day: d, major: false, strong: p.date > 3 ? String(p.date) : undefined });
  }
  return out;
}
