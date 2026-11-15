import { MONTHS, formatDay, fromDay, monthStart, parts, toDay } from "./dates";

/** Length of one step of the map timeline. */
export type Interval = "day" | "month" | "year";

/** One step of the map timeline: a period inside the selected dates, its label and its short tick label. */
export interface Frame {
  interval: Interval;
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
      frames.push({ interval, from: fromDay(d), to: fromDay(d), label: formatDay(d), tick: `${p.date} ${MONTHS[p.month]}` });
    }
    return frames;
  }
  const pa = parts(a);
  const pb = parts(b);
  const clip = (from: number, to: number, label: string, tick: string) =>
    frames.push({ interval, from: fromDay(Math.max(from, a)), to: fromDay(Math.min(to, b)), label, tick });
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
