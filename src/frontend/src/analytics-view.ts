import { annualTrend, climatology, comparePeriod } from "./analytics";
import { CHART, barChart, drawAtWidth, profileChart, redrawOnResize } from "./charts";
import { MONTHS, MONTHS_LONG, formatRange } from "./dates";
import { frame, place, svgHeight, type Cell } from "./export";
import { UNIT_SHORT, escapeXml, fmtCompact, fmtPct, fmtVal } from "./format";
import { countUp } from "./fx";
import { RAMPS, type RampName } from "./ramps";
import type { Selection } from "./store";

export interface AnalyticsRoots {
  summary: HTMLElement;
  patterns: HTMLElement;
}

/** Total and deviation, and historical-pattern readings for the selected area and dates, each in its own card. */
export class AnalyticsView {
  private sel: Selection | null = null;
  private ramp: RampName = "ember";
  /** Width the pattern charts were last drawn at. */
  private patternsW = 0;

  constructor(private readonly roots: AnalyticsRoots) {
    redrawOnResize(roots.patterns, () => this.patternsW, () => this.sel && this.renderPatterns());
  }

  /** Renders every reading. */
  render(sel: Selection, ramp: RampName): void {
    this.sel = sel;
    this.ramp = ramp;
    this.renderSummary();
    this.renderPatterns();
  }

  private renderSummary(): void {
    const sel = this.sel!;
    const c = comparePeriod(sel, sel.from, sel.to);
    const row = (label: string, value: string, note: string) =>
      `<li><span class="dev-k">${label}</span><span class="dev-v">${value}</span><span class="mini-note">${note}</span></li>`;
    this.roots.summary.innerHTML = `
      <p class="tile-label">Total fire cell-days</p>
      <p class="big" data-count></p>
      <p class="sub-line">${escapeXml(formatRange(sel.from, sel.to))}</p>
      <ul class="dev-list">
        ${row("vs previous period", fmtPct(c.vsPrevious), c.previous === null ? "Before the record starts" : `${fmtVal(c.previous)} in ${escapeXml(formatRange(c.previousFrom, c.previousTo))}`)}
        ${row("vs historical average", fmtPct(c.vsMean), c.historicalMean === null ? "No other years to compare" : `Average ${fmtVal(c.historicalMean)} over ${c.historicalWindows} other years`)}
        ${row("vs historical median", fmtPct(c.vsMedian), c.historicalMedian === null ? "No other years to compare" : `Median ${fmtVal(c.historicalMedian)}`)}
      </ul>`;
    countUp(this.roots.summary.querySelector<HTMLElement>("[data-count]")!, c.total, fmtVal);
  }

  private patternParts(): { trendText: string; trendSvg: string; climText: string; climSvg: string } {
    const sel = this.sel!;
    const t = annualTrend(sel);
    const c = climatology(sel);
    const dir = Math.abs(t.percentPerYear) < 1 ? "roughly flat" : t.percentPerYear > 0 ? "rising" : "falling";
    const peakYear = t.years[t.totals.indexOf(Math.max(...t.totals))];
    const trendText = `Annual fire activity is ${dir} (${fmtPct(t.percentPerYear)} per year, ${t.years[0]}–${t.years[t.years.length - 1]}). Biggest year: <strong>${peakYear}</strong>.`;
    const climText = c.season
      ? `Fire-prone months: <strong>${c.top.map((m) => MONTHS_LONG[m]).join(", ")}</strong>. Fires usually concentrate between ${MONTHS_LONG[c.season[0]]} and ${MONTHS_LONG[c.season[1]]}.`
      : "No fires recorded in this area.";
    return {
      trendText,
      trendSvg: barChart({ title: "Fire cell-days per year with trend", labels: t.years.map((y) => `'${String(y).slice(2)}`), values: t.totals, overlay: t.fitted, highlight: [t.years.indexOf(peakYear)], height: 150 }),
      climText,
      climSvg: barChart({ title: `Average ${UNIT_SHORT} per calendar month`, labels: MONTHS.map((m) => m[0]), values: c.average, highlight: c.top, height: 130 }),
    };
  }

  private renderPatterns(): void {
    const sel = this.sel!;
    const p = this.patternParts();
    const t = annualTrend(sel);
    const c = climatology(sel);
    const ranked = c.average.map((v, m) => ({ v, m })).sort((a, b) => b.v - a.v).slice(0, 5);
    const steps = RAMPS[this.ramp].steps;
    const max = ranked[0]?.v || 1;
    this.patternsW = drawAtWidth(this.roots.patterns, 290, (width) => {
      this.roots.patterns.innerHTML = `
      <p class="reading">${p.trendText}</p>
      <div class="chart">${profileChart({ title: "Fire cell-days per year", labels: t.years.map(String), values: t.totals, labelEvery: 4, height: 130, width, peakCaption: (i) => String(t.years[i]) })}</div>
      <p class="d-label">Fire-prone months</p>
      <ol class="rank">${ranked
        .map(
          (r, i) => `<li><span class="rank-n${i === 0 ? " is-top" : ""}">${i + 1}</span><span class="rank-name">${MONTHS_LONG[r.m]}</span>
            <span class="rank-v">${fmtCompact(r.v)}</span><span class="dot" style="background:${steps[Math.max(0, Math.round((r.v / max) * (steps.length - 1)))]}"></span></li>`,
        )
        .join("")}</ol>
      <p class="mini-note">${c.season ? `Average ${UNIT_SHORT} per month. Fires usually concentrate between ${MONTHS_LONG[c.season[0]]} and ${MONTHS_LONG[c.season[1]]}.` : "No fires recorded in this area."}</p>`;
    });
  }

  csv(): { header: string[]; rows: Cell[][] } {
    const sel = this.sel!;
    const c = comparePeriod(sel, sel.from, sel.to);
    const t = annualTrend(sel);
    const cl = climatology(sel);
    const r = (n: number | null) => (n === null ? "" : Math.round(n * 10) / 10);
    const rows: Cell[][] = [
      ["total", "fire_cell_days", Math.round(c.total * 1e4) / 1e4],
      ["total", "previous_period", r(c.previous)],
      ["total", "vs_previous_pct", r(c.vsPrevious)],
      ["total", "historical_mean", r(c.historicalMean)],
      ["total", "vs_mean_pct", r(c.vsMean)],
      ["total", "historical_median", r(c.historicalMedian)],
      ["total", "vs_median_pct", r(c.vsMedian)],
      ...t.years.map<Cell[]>((y, i) => ["annual_total", y, r(t.totals[i])]),
      ["annual_trend", "pct_per_year", r(t.percentPerYear)],
      ...cl.average.map<Cell[]>((v, m) => ["monthly_average", MONTHS[m], r(v)]),
    ];
    return { header: ["section", "key", "value"], rows };
  }

  svg(subtitle: string): { svg: string; width: number; height: number } {
    const sel = this.sel!;
    const c = comparePeriod(sel, sel.from, sel.to);
    const width = 720;
    const tiles = [
      ["TOTAL FIRE CELL-DAYS", fmtVal(c.total)],
      ["VS PREVIOUS PERIOD", fmtPct(c.vsPrevious)],
      ["VS HISTORICAL AVERAGE", fmtPct(c.vsMean)],
      ["VS HISTORICAL MEDIAN", fmtPct(c.vsMedian)],
    ]
      .map(([k, v], i) => `<g transform="translate(${24 + i * 170} 0)"><text y="12" fill="${CHART.accent}" font-size="10" letter-spacing="1">${k}</text><text y="44" fill="${CHART.ink}" font-size="26" font-weight="700">${escapeXml(v)}</text></g>`)
      .join("");
    const p = this.patternParts();
    const strip = (html: string) => escapeXml(html.replace(/<[^>]+>/g, ""));
    const cw = width - 48;
    let y = 72;
    const blocks: string[] = [tiles];
    for (const [text, chart] of [[p.trendText, p.trendSvg], [p.climText, p.climSvg]]) {
      blocks.push(`<text x="24" y="${y}" fill="${CHART.ink2}" font-size="12">${strip(text)}</text>`);
      blocks.push(place(chart, 24, y + 10, cw));
      y += 22 + svgHeight(chart, cw);
    }
    const f = frame("Historical analytics", subtitle, blocks.join(""), width, y);
    return { svg: f.svg, width, height: f.height };
  }
}
