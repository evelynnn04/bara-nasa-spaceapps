import { UNUSUAL_SD, annualTrend, anomalyForMonth, anomalyForYear, climatology, peakMonthOfYear, recordYears, type AnomalyResult, type Verdict } from "./analytics";
import { CHART, drawAtWidth, lineChart, profileChart, redrawOnResize } from "./charts";
import { MONTHS, MONTHS_LONG, parts } from "./dates";
import type { Cell } from "./export";
import { UNIT_SHORT, fmtCompact, fmtVal } from "./format";
import { RAMPS, type RampName } from "./ramps";
import { SelectMenu } from "./select-menu";
import type { Selection } from "./store";

const VERDICT: Record<Verdict, { label: string; tone: "critical" | "warning" | "good" }> = {
  unusual: { label: "Anomaly: unusually high fire activity", tone: "critical" },
  above: { label: "Above the median, within the usual range", tone: "warning" },
  usual: { label: "Within the usual range", tone: "good" },
};

/**
 * Historical patterns (yearly totals and fire-prone months) and the historical comparison, both over
 * the whole record, in two cards. The comparison has two charts: one month in every year, and the
 * months of one year, each against the same period in the other years. Hovering a point gives its
 * value and how it compares.
 */
export class AnomalyView {
  private sel: Selection | null = null;
  private ramp: RampName = "ember";
  private year = 0;
  private month = 0;
  private readonly monthMenu: SelectMenu;
  private readonly yearMenu: SelectMenu;
  private readonly monthChart: HTMLElement;
  private readonly yearChart: HTMLElement;
  /** Widths the charts were last drawn at. */
  private monthW = 0;
  private yearW = 0;
  private patternsW = 0;

  /** `patterns` is the separate Historical patterns card, drawn from the same record. */
  constructor(private readonly root: HTMLElement, private readonly patterns: HTMLElement) {
    root.innerHTML = `
      <section class="an-part" aria-label="One month in every year">
        <div class="an-bar"><p class="d-label">By month</p><div class="an-month"></div></div>
        <div class="chart an-chart-month"></div>
      </section>
      <section class="an-part" aria-label="The months of one year">
        <div class="an-bar"><p class="d-label">By year</p><div class="an-year"></div></div>
        <div class="chart an-chart-year"></div>
      </section>
      <p class="mini-note">Hover a point for its value. Unusual (ringed) means more than ${UNUSUAL_SD} standard deviations above the other years.</p>`;
    this.monthMenu = new SelectMenu(root.querySelector(".an-month")!, "Month", MONTHS_LONG.map((m, i) => ({ value: String(i), label: m })), "0", (value) => {
      this.month = +value;
      this.drawMonth();
    });
    this.yearMenu = new SelectMenu(root.querySelector(".an-year")!, "Year", [], "", (value) => {
      this.year = +value;
      this.drawYear();
    });
    this.monthChart = root.querySelector(".an-chart-month")!;
    this.yearChart = root.querySelector(".an-chart-year")!;
    redrawOnResize(this.monthChart, () => this.monthW, () => this.sel && this.drawMonth());
    redrawOnResize(this.yearChart, () => this.yearW, () => this.sel && this.drawYear());
    redrawOnResize(this.patterns, () => this.patternsW, () => this.sel && this.renderPatterns());
  }

  /** `resetPeriod` picks the record's last year and its busiest month. */
  render(sel: Selection, ramp: RampName, resetPeriod: boolean): void {
    this.sel = sel;
    this.ramp = ramp;
    this.renderPatterns();
    const years = recordYears(sel);
    if (resetPeriod || !this.year) {
      this.year = parts(sel.to).year;
      this.month = Math.max(0, peakMonthOfYear(sel, this.year).peak);
    }
    this.monthMenu.set(String(this.month));
    this.yearMenu.setOptions(years.map((y) => ({ value: String(y), label: String(y) })).reverse(), String(this.year));
    this.drawMonth();
    this.drawYear();
  }

  /** Yearly totals (each year's value on hover) and the five most fire-prone calendar months. */
  private renderPatterns(): void {
    const sel = this.sel!;
    const t = annualTrend(sel);
    const c = climatology(sel);
    const ranked = c.average.map((v, m) => ({ v, m })).sort((a, b) => b.v - a.v).slice(0, 5);
    const steps = RAMPS[this.ramp].steps;
    const max = ranked[0]?.v || 1;
    this.patternsW = drawAtWidth(this.patterns, 290, (width) => {
      this.patterns.innerHTML = `
      <div class="chart">${profileChart({ title: "Hotspots per year", labels: t.years.map(String), values: t.totals, labelEvery: 4, height: 130, width })}</div>
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

  /** A comparison chart: the values, the usual range, the average and median (labelled at the right end), and a hover label per point. */
  private chartSvg(a: AnomalyResult, pointLabel: (i: number) => string, xTitle: string, width: number, height: number): string {
    const last = a.values.length - 1;
    return lineChart({
      title: a.title,
      labels: a.kind === "month" ? a.labels.map((y) => `'${y.slice(2)}`) : a.labels,
      series: [
        { name: UNIT_SHORT[0].toUpperCase() + UNIT_SHORT.slice(1), values: a.values, color: CHART.accent, width: 2 },
        { name: "Historical average", values: a.mean, color: CHART.ink2, dash: "5 3", endLabel: `Average ${fmtVal(a.mean[last])}` },
        { name: "Historical median", values: a.median, color: CHART.median, dash: "1.5 3", endLabel: `Median ${fmtVal(a.median[last])}` },
      ],
      band: {
        name: "Usual range",
        lo: a.mean.map((m, i) => Math.max(0, 2 * m - a.threshold[i])),
        hi: a.threshold,
        color: "rgba(205, 187, 168, 0.13)",
      },
      flags: a.unusual,
      xTitle,
      yTitle: `${UNIT_SHORT[0].toUpperCase()}${UNIT_SHORT.slice(1)} per month`,
      hover: a.values.map((v, i) => {
        const verdict = VERDICT[a.verdicts[i]];
        return {
          title: pointLabel(i),
          lines: [
            { text: `${fmtVal(v)} ${UNIT_SHORT}` },
            { text: verdict.label, color: CHART[verdict.tone] },
          ],
        };
      }),
      width,
      height,
    });
  }

  /** Short in its column; taller when the card is open in the larger view. */
  private chartHeight(width: number): number {
    return this.root.closest(".is-expanded") ? Math.round(Math.min(320, Math.max(170, width * 0.34))) : 170;
  }

  private drawMonth(): void {
    if (!this.sel) return;
    const a = anomalyForMonth(this.sel, this.month);
    this.monthW = drawAtWidth(this.monthChart, 360, (width) => {
      this.monthChart.innerHTML = this.chartSvg(a, (i) => `${MONTHS_LONG[this.month]} ${a.labels[i]}`, "Year", width, this.chartHeight(width));
    });
  }

  private drawYear(): void {
    if (!this.sel) return;
    const a = anomalyForYear(this.sel, this.year);
    this.yearW = drawAtWidth(this.yearChart, 360, (width) => {
      this.yearChart.innerHTML = this.chartSvg(a, (i) => `${MONTHS_LONG[i]} ${this.year}`, "Month", width, this.chartHeight(width));
    });
  }

  csv(): { header: string[]; rows: Cell[][] } {
    const sel = this.sel!;
    const r = (n: number) => Math.round(n * 10) / 10;
    const byMonth = anomalyForMonth(sel, this.month);
    const byYear = anomalyForYear(sel, this.year);
    const rows = (section: string, a: AnomalyResult, key: (i: number) => string): Cell[][] =>
      a.labels.map((_, i) => [section, key(i), r(a.values[i]), r(a.mean[i]), r(a.median[i]), r(a.threshold[i]), a.verdicts[i]]);
    return {
      header: ["chart", "period", "hotspots", "historical_average", "historical_median", "unusual_threshold", "verdict"],
      rows: [
        ...rows("by_month", byMonth, (i) => `${MONTHS[this.month]} ${byMonth.labels[i]}`),
        ...rows("by_year", byYear, (i) => `${MONTHS[i]} ${this.year}`),
      ],
    };
  }
}
