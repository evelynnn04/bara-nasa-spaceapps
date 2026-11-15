import { escapeXml, fmtCompact, fmtVal } from "./format";

/** Chart chrome colours. Keep in step with the tokens in style.css. */
export const CHART = {
  ink: "#f4e7d6",
  ink2: "#cdbba8",
  ink3: "#9a8878",
  line: "#3a2b22",
  bar: "#6b4330",
  panel: "#120c09",
  accent: "#ff7a2e",
  critical: "#ff6b5e",
  warning: "#ffc04d",
  good: "#7fd69a",
  median: "#9fc7ff",
  font: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
} as const;

export interface BarOptions {
  title: string;
  labels: string[];
  values: number[];
  /** Bars drawn in the accent colour. */
  highlight?: number[];
  /** Optional overlay line, e.g. a fitted trend. */
  overlay?: number[];
  /** Show every n-th x label. */
  labelEvery?: number;
  width?: number;
  height?: number;
}

export interface LineSeries {
  name: string;
  values: number[];
  color: string;
  dash?: string;
  width?: number;
}

export interface LineOptions {
  title: string;
  labels: string[];
  series: LineSeries[];
  /** Points of the first series flagged as unusually high. */
  flags?: boolean[];
  /** Index of the selected point, drawn with a guide line. */
  selected?: number;
  /** Shaded range drawn behind the lines, listed first in the legend. */
  band?: { name: string; lo: number[]; hi: number[]; color: string };
  width?: number;
  height?: number;
}

/** Content width of a chart container, or `fallback` while it is hidden. */
export function chartWidth(el: HTMLElement, fallback: number): number {
  const s = getComputedStyle(el);
  return Math.round(el.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight)) || fallback;
}

/**
 * Runs `draw(width)` at the container's width, then once more if inserting it changed that width
 * (a column gaining a scrollbar). Chart heights are fixed, so a second pass cannot change it again.
 * Returns the width the chart was drawn at.
 */
export function drawAtWidth(el: HTMLElement, fallback: number, draw: (width: number) => void): number {
  const first = chartWidth(el, fallback);
  draw(first);
  const settled = chartWidth(el, 0);
  if (!settled || Math.abs(settled - first) <= 2) return first;
  draw(settled);
  return settled;
}

/**
 * Redraws a chart whenever its container's width changes, so viewBox units keep matching screen
 * pixels and chart text stays at its intended size. `drawn` returns the width the chart was last drawn at.
 */
export function redrawOnResize(el: HTMLElement, drawn: () => number, redraw: () => void): void {
  new ResizeObserver(() => {
    const w = chartWidth(el, 0);
    if (w && Math.abs(w - drawn()) > 2) redraw();
  }).observe(el);
}

const M = { l: 40, r: 10, t: 14, b: 24 };
/** Chart text sizes in viewBox units; on-screen charts are drawn at about their shown width, so these read as px. */
const FS = { tick: 11, label: 11, value: 14 };
const LEGEND_ROW = 16;

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((k) => k * p).find((x) => x >= v) ?? v;
}

function axes(w: number, h: number, top: number, max: number, labels: string[], xAt: (i: number) => number, every: number): string {
  const ticks = [0, 0.5, 1].map((t) => {
    const y = top + (h - top - M.b) * (1 - t);
    return `<line x1="${M.l}" x2="${w - M.r}" y1="${y}" y2="${y}" stroke="${CHART.line}" stroke-width="1"/>
      <text x="${M.l - 6}" y="${y + 3.5}" text-anchor="end" fill="${CHART.ink3}" font-size="${FS.tick}">${fmtCompact(max * t)}</text>`;
  });
  const xl = labels
    .map((l, i) => (i % every === 0 ? `<text x="${xAt(i)}" y="${h - 7}" text-anchor="middle" fill="${CHART.ink3}" font-size="${FS.tick}">${escapeXml(l)}</text>` : ""))
    .join("");
  return ticks.join("") + xl;
}

function open(w: number, h: number, title: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="${escapeXml(title)}" font-family="${CHART.font}">`;
}

/** Bar chart as an SVG string. Bars grow from the axis on fresh data through `--i`. */
export function barChart(o: BarOptions): string {
  const w = o.width ?? 480;
  const h = o.height ?? 170;
  const n = o.values.length;
  const max = niceMax(Math.max(...o.values, ...(o.overlay ?? [0])));
  const band = (w - M.l - M.r) / n;
  const xAt = (i: number) => M.l + band * (i + 0.5);
  const yAt = (v: number) => M.t + (h - M.t - M.b) * (1 - v / max);
  const hi = new Set(o.highlight ?? []);
  const bars = o.values
    .map((v, i) => {
      const y = yAt(v);
      const bw = Math.max(1, band * 0.72);
      return `<rect class="bar" style="--i:${i}" x="${xAt(i) - bw / 2}" y="${y}" width="${bw}" height="${Math.max(0, h - M.b - y)}" rx="2" fill="${hi.has(i) ? CHART.accent : CHART.bar}"><title>${escapeXml(o.labels[i])}: ${fmtVal(v)}</title></rect>`;
    })
    .join("");
  const overlay = o.overlay
    ? `<path class="draw" pathLength="1" d="${o.overlay.map((v, i) => `${i ? "L" : "M"}${xAt(i)},${yAt(v)}`).join("")}" fill="none" stroke="${CHART.ink}" stroke-width="1.5" stroke-dasharray="4 3"/>`
    : "";
  return `${open(w, h, o.title)}${axes(w, h, M.t, max, o.labels, xAt, o.labelEvery ?? 1)}${bars}${overlay}</svg>`;
}

/** Line chart as an SVG string, with a legend row, unusual-point markers and a selected-point guide. */
export function lineChart(o: LineOptions): string {
  const w = o.width ?? 480;
  const h = o.height ?? 210;
  // Legend entries flow left to right and wrap onto a new row when the next one would not fit.
  let lx = M.l;
  let row = 0;
  const entries = [...(o.band ? [{ name: o.band.name, color: o.band.color, area: true, dash: undefined }] : []), ...o.series.map((s) => ({ ...s, area: false }))];
  const legend = entries
    .map((s) => {
      const itemW = 21 + s.name.length * FS.label * 0.56;
      if (lx > M.l && lx + itemW > w - M.r) {
        lx = M.l;
        row++;
      }
      const x = lx;
      const y = 9 + row * LEGEND_ROW;
      lx += itemW + 14;
      const key = s.area
        ? `<rect x="${x}" y="${y - 5}" width="16" height="10" rx="2" fill="${s.color}"/>`
        : `<line x1="${x}" x2="${x + 16}" y1="${y}" y2="${y}" stroke="${s.color}" stroke-width="2" ${s.dash ? `stroke-dasharray="${s.dash}"` : ""}/>`;
      return `${key}<text x="${x + 21}" y="${y + 3.5}" fill="${CHART.ink2}" font-size="${FS.label}">${escapeXml(s.name)}</text>`;
    })
    .join("");

  const top = M.t + 22 + row * LEGEND_ROW;
  const n = o.labels.length;
  const max = niceMax(Math.max(...o.series.flatMap((s) => s.values), ...(o.band?.hi ?? [])));
  const step = (w - M.l - M.r - 12) / Math.max(1, n - 1);
  const xAt = (i: number) => M.l + 6 + step * i;
  const yAt = (v: number) => top + (h - top - M.b) * (1 - v / max);
  const every = n > 12 ? 2 : 1;

  const guide =
    o.selected !== undefined && o.selected >= 0
      ? `<line x1="${xAt(o.selected)}" x2="${xAt(o.selected)}" y1="${top}" y2="${h - M.b}" stroke="${CHART.ink3}" stroke-dasharray="2 3"/>`
      : "";

  const band = o.band
    ? `<path d="${o.band.hi.map((v, i) => `${i ? "L" : "M"}${xAt(i)},${yAt(v)}`).join("")}${o.band.lo
        .map((v, i) => `L${xAt(i)},${yAt(v)}`)
        .reverse()
        .join("")}Z" fill="${o.band.color}"/>`
    : "";

  const lines = o.series
    .map(
      (s) =>
        `<path class="draw" pathLength="1" d="${s.values.map((v, i) => `${i ? "L" : "M"}${xAt(i)},${yAt(v)}`).join("")}" fill="none" stroke="${s.color}" stroke-width="${s.width ?? 1.5}" ${s.dash ? `stroke-dasharray="${s.dash}"` : ""} stroke-linejoin="round"/>`,
    )
    .join("");

  const first = o.series[0];
  const dots = first.values
    .map((v, i) => {
      const flagged = o.flags?.[i];
      const sel = i === o.selected;
      const r = flagged || sel ? 4.5 : 2.5;
      const fill = flagged ? CHART.critical : first.color;
      const ring = flagged ? `<circle cx="${xAt(i)}" cy="${yAt(v)}" r="8" fill="none" stroke="${CHART.critical}" stroke-width="1.5"/>` : "";
      return `${ring}<circle cx="${xAt(i)}" cy="${yAt(v)}" r="${r}" fill="${fill}" stroke="${sel ? CHART.ink : "none"}" stroke-width="1.5"><title>${escapeXml(o.labels[i])}: ${fmtVal(v)}${flagged ? " (unusually high)" : ""}</title></circle>`;
    })
    .join("");

  return `${open(w, h, o.title)}${legend}${axes(w, h, top, max, o.labels, xAt, every)}${band}${guide}${lines}${dots}</svg>`;
}

export interface ProfileOptions {
  title: string;
  labels: string[];
  values: number[];
  /** Caption shown under the peak value, e.g. the year. */
  peakCaption?: (i: number) => string;
  width?: number;
  height?: number;
  labelEvery?: number;
}

/** Single-series area line with the peak ringed and labelled, for the fire profile card. */
export function profileChart(o: ProfileOptions): string {
  const w = o.width ?? 620;
  const h = o.height ?? 190;
  const top = M.t + 30;
  const n = o.values.length;
  const max = niceMax(Math.max(...o.values) * 1.05);
  const step = (w - M.l - M.r - 12) / Math.max(1, n - 1);
  const xAt = (i: number) => M.l + 6 + step * i;
  const yAt = (v: number) => top + (h - top - M.b) * (1 - v / max);
  const pts = o.values.map((v, i) => `${xAt(i)},${yAt(v)}`);
  const line = `M${pts.join("L")}`;
  const area = `${line}L${xAt(n - 1)},${h - M.b}L${xAt(0)},${h - M.b}Z`;
  const peak = o.values.indexOf(Math.max(...o.values));
  const px = xAt(peak);
  const py = yAt(o.values[peak]);
  const label = fmtVal(o.values[peak]);
  const cap = o.peakCaption?.(peak) ?? o.labels[peak];
  const bw = Math.max(64, label.length * 9 + 22);
  const bx = Math.min(w - M.r - bw, Math.max(M.l, px + 10));
  const by = Math.max(2, py - 50);
  const mark =
    o.values[peak] > 0
      ? `<line x1="${px}" x2="${px}" y1="${py}" y2="${h - M.b}" stroke="${CHART.ink3}" stroke-dasharray="2 3"/>
        <circle cx="${px}" cy="${py}" r="7" fill="none" stroke="${CHART.accent}" stroke-width="1.5"/>
        <circle cx="${px}" cy="${py}" r="3" fill="${CHART.ink}"/>
        <rect x="${bx}" y="${by}" width="${bw}" height="40" rx="9" fill="${CHART.panel}" fill-opacity="0.92" stroke="${CHART.line}"/>
        <text x="${bx + 11}" y="${by + 18}" fill="${CHART.ink}" font-size="${FS.value}" font-weight="700">${label}</text>
        <text x="${bx + 11}" y="${by + 32}" fill="${CHART.ink3}" font-size="${FS.label}">${escapeXml(cap)}</text>`
      : "";
  return `${open(w, h, o.title)}
    <defs><linearGradient id="pf-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${CHART.accent}" stop-opacity="0.32"/><stop offset="1" stop-color="${CHART.accent}" stop-opacity="0"/></linearGradient></defs>
    ${axes(w, h, top, max, o.labels, xAt, o.labelEvery ?? 1)}
    <path d="${area}" fill="url(#pf-fill)"/>
    <path class="draw" pathLength="1" d="${line}" fill="none" stroke="${CHART.accent}" stroke-width="2" stroke-linejoin="round"/>
    ${mark}</svg>`;
}
