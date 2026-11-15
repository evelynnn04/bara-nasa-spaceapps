const intFmt = new Intl.NumberFormat("en-US");

export function fmtInt(n: number): string {
  return intFmt.format(Math.round(n));
}

/** Unit of every harmonised value, in full and short. */
export const UNIT = "hotspots (Aqua MODIS-equivalent)";
export const UNIT_SHORT = "hotspots";

/** A harmonised value: whole numbers from 100 up, otherwise one decimal (0.4, 12.5). */
export function fmtVal(n: number): string {
  if (Math.abs(n) >= 100) return fmtInt(n);
  return String(Math.round(n * 10) / 10);
}

/** Short axis label: 950, 1.2k, 34k. */
export function fmtCompact(n: number): string {
  if (n < 10) return String(Math.round(n * 10) / 10);
  if (n < 1000) return String(Math.round(n));
  const k = n / 1000;
  return `${k < 10 ? k.toFixed(1).replace(/\.0$/, "") : Math.round(k)}k`;
}

/** A chance from 0 to 1 as a percentage: whole percents from 10 % up, else one decimal (0.4%, 3.5%, 62%). */
export function fmtChance(p: number): string {
  const pct = p * 100;
  return `${pct >= 10 ? Math.round(pct) : Math.round(pct * 10) / 10}%`;
}

/** Signed percentage, or an en dash when there is nothing to compare with. */
export function fmtPct(p: number | null): string {
  if (p === null || !Number.isFinite(p)) return "–";
  const r = Math.round(p * 10) / 10;
  return `${r > 0 ? "+" : ""}${r}%`;
}

export function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
