const DAY_MS = 86_400_000;

export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const MONTHS_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** Converts YYYY-MM-DD to whole days since 1970-01-01 (UTC). */
export function toDay(date: string): number {
  return Math.round(Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10)) / DAY_MS);
}

/** Converts days since 1970-01-01 back to YYYY-MM-DD. */
export function fromDay(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/** Returns the UTC year, zero-based month and day of month for a day number. */
export function parts(day: number): { year: number; month: number; date: number } {
  const d = new Date(day * DAY_MS);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth(), date: d.getUTCDate() };
}

/** Day number of the first day of a zero-based month. */
export function monthStart(year: number, month: number): number {
  return Math.round(Date.UTC(year, month, 1) / DAY_MS);
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/** Day of week with Monday as 0. */
export function weekdayMon(day: number): number {
  return (new Date(day * DAY_MS).getUTCDay() + 6) % 7;
}

/** Formats a day number as "3 Aug 2015". */
export function formatDay(day: number): string {
  const p = parts(day);
  return `${p.date} ${MONTHS[p.month]} ${p.year}`;
}

export function formatRange(from: number, to: number): string {
  return `${formatDay(from)} - ${formatDay(to)}`;
}
