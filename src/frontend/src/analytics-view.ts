import { annualTrend, climatology, comparePeriod, peakDayOfMonth, peakMonthOfYear, recordYears, type Breakdown } from "./analytics";
import { CHART, barChart, profileChart } from "./charts";
import { MONTHS, MONTHS_LONG, formatRange, parts } from "./dates";
import { frame, place, svgHeight, type Cell } from "./export";
import { escapeXml, fmtCompact, fmtInt, fmtPct } from "./format";
import { countUp } from "./fx";
import { RAMPS, type RampName } from "./ramps";
import type { Selection } from "./store";

type PeakMode = "month" | "day";

export interface AnalyticsRoots {
  summary: HTMLElement;
  peak: HTMLElement;
  patterns: HTMLElement;
}

/** Total and deviation, peak, and historical-pattern readings for the selected area and dates, each in its own card. */
export class AnalyticsView {
  private sel: Selection | null = null;
  private ramp: RampName = "ember";
  private peakMode: PeakMode = "month";
  private peakYear = 0;
  private peakMonth = 0;
  private readonly peakText: HTMLElement;
  private readonly peakChart: HTMLElement;
  private readonly peakYearSel: HTMLSelectElement;
  private readonly peakMonthIn: HTMLInputElement;

  constructor(private readonly roots: AnalyticsRoots) {
    roots.peak.innerHTML = `
      <div class="seg seg-wide" role="group" aria-label="Peak granularity">
        <button type="button" class="seg-btn" data-peak="month" aria-pressed="true">Month in a year</button>
        <button type="button" class="seg-btn" data-peak="day" aria-pressed="false">Day in a month</button>
        <span class="seg-thumb" aria-hidden="true"></span>
      </div>
      <div class="peak-pick">
        <label class="field"><span>Year</span><select class="input peak-year"></select></label>
        <label class="field" hidden><span>Month</span><input class="input peak-month" type="month" /></label>
      </div>
      <p class="reading peak-text" aria-live="polite"></p>
      <div class="chart peak-chart"></div>`;
    this.peakText = roots.peak.querySelector(".peak-text")!;
    this.peakChart = roots.peak.querySelector(".peak-chart")!;
    this.peakYearSel = roots.peak.querySelector(".peak-year")!;
    this.peakMonthIn = roots.peak.querySelector(".peak-month")!;

    roots.peak.querySelector(".seg")!.addEventListener("click", (e) => {
      const btn = (e.target as Element).closest<HTMLButtonElement>("[data-peak]");
      if (!btn) return;
      this.peakMode = btn.dataset.peak as PeakMode;
      this.renderPeak();
    });
    this.peakYearSel.addEventListener("change", () => {
      this.peakYear = +this.peakYearSel.value;
      this.renderPeak();
    });
    this.peakMonthIn.addEventListener("change", () => {
      const v = this.peakMonthIn.value;
      if (!v) return;
      this.peakYear = +v.slice(0, 4);
      this.peakMonth = +v.slice(5, 7) - 1;
      this.renderPeak();
    });
  }

  /** Renders every reading. `resetPeak` moves the peak pickers to the end of the selected dates. */
  render(sel: Selection, resetPeak: boolean, ramp: RampName): void {
    this.sel = sel;
    this.ramp = ramp;
    const years = recordYears(sel);
    if (resetPeak || !this.peakYear) {
      const end = parts(sel.to);
      this.peakYear = end.year;
      this.peakMonth = Math.max(0, peakMonthOfYear(sel, end.year).peak);
    }
    this.peakYearSel.innerHTML = years.map((y) => `<option value="${y}">${y}</option>`).join("");
    this.peakMonthIn.min = `${years[0]}-01`;
    this.peakMonthIn.max = `${years[years.length - 1]}-12`;
    this.renderSummary();
    this.renderPeak();
    this.renderPatterns();
  }

  private renderSummary(): void {
    const sel = this.sel!;
    const c = comparePeriod(sel, sel.from, sel.to);
    const row = (label: string, value: string, note: string) =>
      `<li><span class="dev-k">${label}</span><span class="dev-v">${value}</span><span class="mini-note">${note}</span></li>`;
    this.roots.summary.innerHTML = `
      <p class="tile-label">Total fires</p>
      <p class="big" data-count></p>
      <p class="sub-line">${escapeXml(formatRange(sel.from, sel.to))}</p>
      <ul class="dev-list">
        ${row("vs previous period", fmtPct(c.vsPrevious), c.previous === null ? "Before the record starts" : `${fmtInt(c.previous)} in ${escapeXml(formatRange(c.previousFrom, c.previousTo))}`)}
        ${row("vs historical average", fmtPct(c.vsMean), c.historicalMean === null ? "No other years to compare" : `Average ${fmtInt(c.historicalMean)} over ${c.historicalWindows} other years`)}
        ${row("vs historical median", fmtPct(c.vsMedian), c.historicalMedian === null ? "No other years to compare" : `Median ${fmtInt(c.historicalMedian)}`)}
      </ul>`;
    countUp(this.roots.summary.querySelector<HTMLElement>("[data-count]")!, c.total, fmtInt);
  }

  private peakData(): { title: string; data: Breakdown; sentence: string } {
    const sel = this.sel!;
    if (this.peakMode === "month") {
      const data = peakMonthOfYear(sel, this.peakYear);
      const sentence = data.peak < 0 ? `No fires recorded in ${this.peakYear}.` : `Peak month of ${this.peakYear}: <strong>${MONTHS_LONG[data.peak]}</strong>, ${fmtInt(data.values[data.peak])} detections.`;
      return { title: `Detections per month in ${this.peakYear}`, data, sentence };
    }
    const data = peakDayOfMonth(sel, this.peakYear, this.peakMonth);
    const name = `${MONTHS_LONG[this.peakMonth]} ${this.peakYear}`;
    const sentence = data.peak < 0 ? `No fires recorded in ${name}.` : `Peak day of ${name}: <strong>${data.peak + 1} ${MONTHS[this.peakMonth]}</strong>, ${fmtInt(data.values[data.peak])} detections.`;
    return { title: `Detections per day in ${name}`, data, sentence };
  }

  private renderPeak(): void {
    this.roots.peak.querySelectorAll<HTMLButtonElement>("[data-peak]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.peak === this.peakMode)));
    this.peakYearSel.closest("label")!.hidden = this.peakMode !== "month";
    this.peakMonthIn.closest("label")!.hidden = this.peakMode !== "day";
    this.peakYearSel.value = String(this.peakYear);
    this.peakMonthIn.value = `${this.peakYear}-${String(this.peakMonth + 1).padStart(2, "0")}`;
    const { title, data, sentence } = this.peakData();
    this.peakText.innerHTML = sentence;
    this.peakChart.innerHTML = barChart({
      title,
      labels: data.labels,
      values: data.values,
      highlight: data.peak >= 0 ? [data.peak] : [],
      labelEvery: this.peakMode === "day" ? 5 : 1,
      height: 130,
    });
  }

  private patternParts(): { trendText: string; trendSvg: string; climText: string; climSvg: string } {
    const sel = this.sel!;
    const t = annualTrend(sel);
    const c = climatology(sel);
    const dir = Math.abs(t.percentPerYear) < 1 ? "roughly flat" : t.percentPerYear > 0 ? "rising" : "falling";
    const peakYear = t.years[t.totals.indexOf(Math.max(...t.totals))];
    const trendText = `Annual detections are ${dir} (${fmtPct(t.percentPerYear)} per year, ${t.years[0]}–${t.years[t.years.length - 1]}). Biggest year: <strong>${peakYear}</strong>.`;
    const climText = c.season
      ? `Fire-prone months: <strong>${c.top.map((m) => MONTHS_LONG[m]).join(", ")}</strong>. Fires usually concentrate between ${MONTHS_LONG[c.season[0]]} and ${MONTHS_LONG[c.season[1]]}.`
      : "No fires recorded in this area.";
    return {
      trendText,
      trendSvg: barChart({ title: "Detections per year with trend", labels: t.years.map((y) => `'${String(y).slice(2)}`), values: t.totals, overlay: t.fitted, highlight: [t.years.indexOf(peakYear)], height: 150 }),
      climText,
      climSvg: barChart({ title: "Average detections per calendar month", labels: MONTHS.map((m) => m[0]), values: c.average, highlight: c.top, height: 130 }),
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
    this.roots.patterns.innerHTML = `
      <p class="reading">${p.trendText}</p>
      <div class="chart">${profileChart({ title: "Detections per year", labels: t.years.map(String), values: t.totals, labelEvery: 4, height: 130, width: 420, peakCaption: (i) => String(t.years[i]) })}</div>
      <p class="d-label">Fire-prone months</p>
      <ol class="rank">${ranked
        .map(
          (r, i) => `<li><span class="rank-n${i === 0 ? " is-top" : ""}">${i + 1}</span><span class="rank-name">${MONTHS_LONG[r.m]}</span>
            <span class="rank-v">${fmtCompact(r.v)}</span><span class="dot" style="background:${steps[Math.max(0, Math.round((r.v / max) * (steps.length - 1)))]}"></span></li>`,
        )
        .join("")}</ol>
      <p class="mini-note">${c.season ? `Average detections per month. Fires usually concentrate between ${MONTHS_LONG[c.season[0]]} and ${MONTHS_LONG[c.season[1]]}.` : "No fires recorded in this area."}</p>`;
  }

  csv(): { header: string[]; rows: Cell[][] } {
    const sel = this.sel!;
    const c = comparePeriod(sel, sel.from, sel.to);
    const { data } = this.peakData();
    const t = annualTrend(sel);
    const cl = climatology(sel);
    const r = (n: number | null) => (n === null ? "" : Math.round(n * 10) / 10);
    const rows: Cell[][] = [
      ["total", "detections", c.total],
      ["total", "previous_period", r(c.previous)],
      ["total", "vs_previous_pct", r(c.vsPrevious)],
      ["total", "historical_mean", r(c.historicalMean)],
      ["total", "vs_mean_pct", r(c.vsMean)],
      ["total", "historical_median", r(c.historicalMedian)],
      ["total", "vs_median_pct", r(c.vsMedian)],
      ...data.values.map<Cell[]>((v, i) => [`peak_${this.peakMode === "month" ? `months_${this.peakYear}` : `days_${this.peakYear}-${String(this.peakMonth + 1).padStart(2, "0")}`}`, data.labels[i], v]),
      ...t.years.map<Cell[]>((y, i) => ["annual_total", y, t.totals[i]]),
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
      ["TOTAL FIRES", fmtInt(c.total)],
      ["VS PREVIOUS PERIOD", fmtPct(c.vsPrevious)],
      ["VS HISTORICAL AVERAGE", fmtPct(c.vsMean)],
      ["VS HISTORICAL MEDIAN", fmtPct(c.vsMedian)],
    ]
      .map(([k, v], i) => `<g transform="translate(${24 + i * 170} 0)"><text y="12" fill="${CHART.accent}" font-size="10" letter-spacing="1">${k}</text><text y="44" fill="${CHART.ink}" font-size="26" font-weight="700">${escapeXml(v)}</text></g>`)
      .join("");
    const peak = this.peakData();
    const p = this.patternParts();
    const strip = (html: string) => escapeXml(html.replace(/<[^>]+>/g, ""));
    const cw = width - 48;
    let y = 72;
    const blocks: string[] = [tiles];
    for (const [text, chart] of [[peak.sentence, barChart({ title: peak.title, labels: peak.data.labels, values: peak.data.values, highlight: peak.data.peak >= 0 ? [peak.data.peak] : [], labelEvery: this.peakMode === "day" ? 5 : 1, height: 150 })], [p.trendText, p.trendSvg], [p.climText, p.climSvg]]) {
      blocks.push(`<text x="24" y="${y}" fill="${CHART.ink2}" font-size="12">${strip(text)}</text>`);
      blocks.push(place(chart, 24, y + 10, cw));
      y += 22 + svgHeight(chart, cw);
    }
    const f = frame("Historical analytics", subtitle, blocks.join(""), width, y);
    return { svg: f.svg, width, height: f.height };
  }
}
