import { comparePeriod } from "./analytics";
import { CHART } from "./charts";
import { formatRange } from "./dates";
import { frame, type Cell } from "./export";
import { escapeXml, fmtPct, fmtVal } from "./format";
import { countUp } from "./fx";
import type { Selection } from "./store";

/** Total for the selected area and dates, and how it compares with the previous period and other years. */
export class AnalyticsView {
  private sel: Selection | null = null;

  constructor(private readonly root: HTMLElement) {}

  render(sel: Selection): void {
    this.sel = sel;
    const c = comparePeriod(sel, sel.from, sel.to);
    const row = (label: string, value: string, note: string) =>
      `<li><span class="dev-k">${label}</span><span class="dev-v">${value}</span><span class="mini-note">${note}</span></li>`;
    this.root.innerHTML = `
      <p class="tile-label">Total fire cell-days</p>
      <p class="big" data-count></p>
      <ul class="dev-list">
        ${row("vs previous period", fmtPct(c.vsPrevious), c.previous === null ? "Before the record starts" : `${fmtVal(c.previous)} in ${escapeXml(formatRange(c.previousFrom, c.previousTo))}`)}
        ${row("vs historical average", fmtPct(c.vsMean), c.historicalMean === null ? "No other years to compare" : `Average ${fmtVal(c.historicalMean)} over ${c.historicalWindows} other years`)}
        ${row("vs historical median", fmtPct(c.vsMedian), c.historicalMedian === null ? "No other years to compare" : `Median ${fmtVal(c.historicalMedian)}`)}
      </ul>`;
    countUp(this.root.querySelector<HTMLElement>("[data-count]")!, c.total, fmtVal);
  }

  csv(): { header: string[]; rows: Cell[][] } {
    const sel = this.sel!;
    const c = comparePeriod(sel, sel.from, sel.to);
    const r = (n: number | null) => (n === null ? "" : Math.round(n * 10) / 10);
    const rows: Cell[][] = [
      ["total", "fire_cell_days", Math.round(c.total * 1e4) / 1e4],
      ["total", "previous_period", r(c.previous)],
      ["total", "vs_previous_pct", r(c.vsPrevious)],
      ["total", "historical_mean", r(c.historicalMean)],
      ["total", "vs_mean_pct", r(c.vsMean)],
      ["total", "historical_median", r(c.historicalMedian)],
      ["total", "vs_median_pct", r(c.vsMedian)],
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
    const f = frame("Historical analytics", subtitle, tiles, width, 56);
    return { svg: f.svg, width, height: f.height };
  }
}
