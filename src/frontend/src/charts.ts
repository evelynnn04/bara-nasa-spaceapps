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
};

/** Sets the palette's colours in the charts: the main series, unusual points and the median line. */
export function setChartPalette(c: { accent: string; alert: string; ref: string }): void {
  CHART.accent = c.accent;
  CHART.critical = c.alert;
  CHART.median = c.ref;
}

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
  /** Text written above the line's right end, e.g. "Average 924". */
  endLabel?: string;
}

/** What a point's hover label says: a title, then lines of text, each optionally coloured. */
export interface HoverTip {
  title: string;
  lines: { text: string; color?: string }[];
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
  /** Axis titles, e.g. "Year" and "Hotspots". */
  xTitle?: string;
  yTitle?: string;
  /** One label per point of the first series, shown while its column is hovered. */
  hover?: HoverTip[];
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

function axes(w: number, h: number, top: number, max: number, labels: string[], xAt: (i: number) => number, every: number, left = M.l, bottom = M.b): string {
  const ticks = [0, 0.5, 1].map((t) => {
    const y = top + (h - top - bottom) * (1 - t);
    return `<line x1="${left}" x2="${w - M.r}" y1="${y}" y2="${y}" stroke="${CHART.line}" stroke-width="1"/>
      <text x="${left - 6}" y="${y + 3.5}" text-anchor="end" fill="${CHART.ink3}" font-size="${FS.tick}">${fmtCompact(max * t)}</text>`;
  });
  const xl = labels
    .map((l, i) => (i % every === 0 ? `<text x="${xAt(i)}" y="${h - bottom + 17}" text-anchor="middle" fill="${CHART.ink3}" font-size="${FS.tick}">${escapeXml(l)}</text>` : ""))
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

/**
 * Line chart as an SVG string, with a legend row, unusual-point markers, a selected-point guide,
 * optional axis titles, end labels on lines and per-point hover labels (CSS only).
 */
export function lineChart(o: LineOptions): string {
  const w = o.width ?? 480;
  const h = o.height ?? 210;
  const left = M.l + (o.yTitle ? 14 : 0);
  const bottom = M.b + (o.xTitle ? 16 : 0);
  // Legend entries flow left to right and wrap onto a new row when the next one would not fit.
  let lx = left;
  let row = 0;
  const entries = [...(o.band ? [{ name: o.band.name, color: o.band.color, area: true, dash: undefined }] : []), ...o.series.map((s) => ({ ...s, area: false }))];
  const legend = entries
    .map((s) => {
      const itemW = 21 + s.name.length * FS.label * 0.56;
      if (lx > left && lx + itemW > w - M.r) {
        lx = left;
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
  const step = (w - left - M.r - 12) / Math.max(1, n - 1);
  const xAt = (i: number) => left + 6 + step * i;
  const yAt = (v: number) => top + (h - top - bottom) * (1 - v / max);
  const every = n > 12 ? 2 : 1;

  const xTitle = o.xTitle
    ? `<text x="${(left + w - M.r) / 2}" y="${h - 3}" text-anchor="middle" fill="${CHART.ink3}" font-size="${FS.label}">${escapeXml(o.xTitle)}</text>`
    : "";
  const yTitle = o.yTitle
    ? `<text transform="rotate(-90)" x="${-(top + (h - bottom - top) / 2)}" y="11" text-anchor="middle" fill="${CHART.ink3}" font-size="${FS.label}">${escapeXml(o.yTitle)}</text>`
    : "";

  const guide =
    o.selected !== undefined && o.selected >= 0
      ? `<line x1="${xAt(o.selected)}" x2="${xAt(o.selected)}" y1="${top}" y2="${h - bottom}" stroke="${CHART.ink3}" stroke-dasharray="2 3"/>`
      : "";

  const band = o.band
    ? `<path d="${o.band.hi.map((v, i) => `${i ? "L" : "M"}${xAt(i)},${yAt(v)}`).join("")}${o.band.lo
        .map((v, i) => `L${xAt(i)},${yAt(v)}`)
        .reverse()
        .join("")}Z" fill="${o.band.color}"/>`
    : "";

  // Dashed lines skip the draw-in animation: its pathLength would stretch their dashes past the line's length.
  const lines = o.series
    .map((s) => {
      const d = s.values.map((v, i) => `${i ? "L" : "M"}${xAt(i)},${yAt(v)}`).join("");
      const look = s.dash ? `stroke-dasharray="${s.dash}"` : `class="draw" pathLength="1"`;
      return `<path ${look} d="${d}" fill="none" stroke="${s.color}" stroke-width="${s.width ?? 1.5}" stroke-linejoin="round"/>`;
    })
    .join("");

  // End labels sit just above each line's last point, nudged apart when they would overlap.
  const ends = o.series
    .filter((s) => s.endLabel)
    .map((s) => ({ s, y: yAt(s.values[n - 1]) - 5 }))
    .sort((a, b) => a.y - b.y);
  for (let k = ends.length - 2; k >= 0; k--) ends[k].y = Math.min(ends[k].y, ends[k + 1].y - 12);
  const endLabels = ends
    .map(
      ({ s, y }) =>
        `<text x="${w - M.r}" y="${Math.max(top - 2, y)}" text-anchor="end" fill="${s.color}" font-size="${FS.tick}">${escapeXml(s.endLabel ?? "")}</text>`,
    )
    .join("");

  const first = o.series[0];
  const dots = first.values
    .map((v, i) => {
      const flagged = o.flags?.[i];
      const sel = i === o.selected;
      const r = flagged || sel ? 4.5 : 2.5;
      const fill = flagged ? CHART.critical : first.color;
      // Unusual points: a fixed ring, plus one that keeps pulsing outwards
      const ring = flagged
        ? `<circle cx="${xAt(i)}" cy="${yAt(v)}" r="8" fill="none" stroke="${CHART.critical}" stroke-width="1.5"/>
          <circle class="lc-pulse" cx="${xAt(i)}" cy="${yAt(v)}" r="8" fill="none" stroke="${CHART.critical}" stroke-width="1.5"/>`
        : "";
      const title = o.hover ? "" : `<title>${escapeXml(o.labels[i])}: ${fmtVal(v)}${flagged ? " (unusually high)" : ""}</title>`;
      return `${ring}<circle cx="${xAt(i)}" cy="${yAt(v)}" r="${r}" fill="${fill}" stroke="${sel ? CHART.ink : "none"}" stroke-width="1.5">${title}</circle>`;
    })
    .join("");

  const hover = (o.hover ?? [])
    .map((tip, i) => {
      const x = xAt(i);
      const y = yAt(first.values[i]);
      const longest = Math.max(tip.title.length, ...tip.lines.map((l) => l.text.length)) * 6.2;
      const bw = Math.min(w - left - M.r, longest + 20);
      const bh = 22 + tip.lines.length * 15;
      // Beside the point, on whichever side has room
      const bx = x + 12 + bw <= w - M.r ? x + 12 : Math.max(left, x - 12 - bw);
      const by = Math.max(0, Math.min(h - bottom - bh, y - bh / 2));
      const text = tip.lines
        .map((l, k) => `<text x="${bx + 10}" y="${by + 32 + k * 15}" fill="${l.color ?? CHART.ink2}" font-size="${FS.label}">${escapeXml(l.text)}</text>`)
        .join("");
      return `<g class="pf-pt"><rect x="${x - step / 2}" y="0" width="${step}" height="${h - bottom}" fill="transparent"/>
        <g class="pf-hover"><line x1="${x}" x2="${x}" y1="${top}" y2="${h - bottom}" stroke="${CHART.ink3}" stroke-dasharray="2 3"/>
        <circle cx="${x}" cy="${y}" r="4.5" fill="${CHART.ink}" stroke="${first.color}" stroke-width="2"/>
        <rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="8" fill="${CHART.panel}" fill-opacity="0.95" stroke="${CHART.line}"/>
        <text x="${bx + 10}" y="${by + 16}" fill="${CHART.ink}" font-size="${FS.label}" font-weight="700">${escapeXml(tip.title)}</text>${text}</g></g>`;
    })
    .join("");

  return `${open(w, h, o.title)}${legend}${axes(w, h, top, max, o.labels, xAt, every, left, bottom)}${xTitle}${yTitle}${band}${guide}${lines}${endLabels}${dots}${hover}</svg>`;
}

export interface ProfileOptions {
  title: string;
  labels: string[];
  values: number[];
  width?: number;
  height?: number;
  labelEvery?: number;
}

/**
 * Single-series area line for the fire profile card. Hovering a column marks its point and shows its
 * value and label (CSS only: each point has an invisible hit column holding its marker and label).
 */
export function profileChart(o: ProfileOptions): string {
  const w = o.width ?? 620;
  const h = o.height ?? 190;
  const top = M.t;
  const n = o.values.length;
  const max = niceMax(Math.max(...o.values) * 1.05);
  const step = (w - M.l - M.r - 12) / Math.max(1, n - 1);
  const xAt = (i: number) => M.l + 6 + step * i;
  const yAt = (v: number) => top + (h - top - M.b) * (1 - v / max);
  const pts = o.values.map((v, i) => `${xAt(i)},${yAt(v)}`);
  const line = `M${pts.join("L")}`;
  const area = `${line}L${xAt(n - 1)},${h - M.b}L${xAt(0)},${h - M.b}Z`;
  const hover = o.values
    .map((v, i) => {
      const x = xAt(i);
      const y = yAt(v);
      const value = fmtVal(v);
      const bw = Math.max(value.length * 8, o.labels[i].length * 6.5) + 20;
      const bh = 38;
      const bx = Math.min(w - M.r - bw, Math.max(M.l, x - bw / 2));
      // Above the point, or below it when the point is too near the top
      const by = y - bh - 10 >= 0 ? y - bh - 10 : y + 10;
      return `<g class="pf-pt"><rect x="${x - step / 2}" y="0" width="${step}" height="${h - M.b}" fill="transparent"/>
        <g class="pf-hover"><line x1="${x}" x2="${x}" y1="${y}" y2="${h - M.b}" stroke="${CHART.ink3}" stroke-dasharray="2 3"/>
        <circle cx="${x}" cy="${y}" r="4" fill="${CHART.ink}" stroke="${CHART.accent}" stroke-width="2"/>
        <rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="8" fill="${CHART.panel}" fill-opacity="0.94" stroke="${CHART.line}"/>
        <text x="${bx + bw / 2}" y="${by + 16}" text-anchor="middle" fill="${CHART.ink}" font-size="${FS.value - 1}" font-weight="700">${value}</text>
        <text x="${bx + bw / 2}" y="${by + 30}" text-anchor="middle" fill="${CHART.ink3}" font-size="${FS.label}">${escapeXml(o.labels[i])}</text></g></g>`;
    })
    .join("");
  return `${open(w, h, o.title)}
    <defs><linearGradient id="pf-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${CHART.accent}" stop-opacity="0.32"/><stop offset="1" stop-color="${CHART.accent}" stop-opacity="0"/></linearGradient></defs>
    ${axes(w, h, top, max, o.labels, xAt, o.labelEvery ?? 1)}
    <path d="${area}" fill="url(#pf-fill)"/>
    <path class="draw" pathLength="1" d="${line}" fill="none" stroke="${CHART.accent}" stroke-width="2" stroke-linejoin="round"/>
    ${hover}</svg>`;
}
