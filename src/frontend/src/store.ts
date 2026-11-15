import type { DailySeries } from "./api";
import { toDay } from "./dates";

/** The harmonised daily record of the selected area plus the selected date range. */
export interface Selection extends DailySeries {
  /** Selected date range as day numbers, clamped to the record. */
  from: number;
  to: number;
}

/** Combines an area's daily record with a date range. */
export function select(series: DailySeries, start: string, end: string): Selection {
  return {
    ...series,
    from: Math.max(series.firstDay, toDay(start)),
    to: Math.min(series.lastDay, toDay(end)),
  };
}

/** Number of days between two days (inclusive) that the record's satellite did not observe. */
export function unobserved(sel: DailySeries, from: number, to: number): number {
  let n = 0;
  for (let d = Math.max(from, sel.firstDay); d <= Math.min(to, sel.lastDay); d++) n += sel.missing[d - sel.firstDay];
  return n;
}
