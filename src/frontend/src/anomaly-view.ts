import { UNUSUAL_SD, annualTrend, anomalyForMonth, anomalyForYear, climatology, peakMonthOfYear, recordYears, type AnomalyResult, type Verdict } from "./analytics";
import { CHART, barChart, drawAtWidth, lineChart, profileChart, redrawOnResize } from "./charts";
import { MONTHS, MONTHS_LONG, parts } from "./dates";
import { frame, place, svgHeight, type Cell } from "./export";
import { UNIT_SHORT, escapeXml, fmtCompact, fmtPct, fmtVal } from "./format";
import { RAMPS, type RampName } from "./ramps";
import type { Selection } from "./store";

type Kind = "month" | "year";

const VERDICT: Record<Verdict, { label: string; tone: "critical" | "warning" | "good" }> = {
  unusual: { label: "Anomaly: unusually high fire activity", tone: "critical" },
  above: { label: "Above the median, within the usual range", tone: "warning" },
  usual: { label: "Within the usual range", tone: "good" },
};

/**
 * Historical patterns (yearly trend and fire-prone months) and the historical comparison of a chosen
 * month or year against its average and median, both over the whole record, in two cards.
 */
export class AnomalyView {
  private sel: Selection | null = null;
  private ramp: RampName = "ember";
  private kind: Kind = "month";
  private year = 0;
  private month = 0;
  private readonly yearSel: HTMLSelectElement;
  private readonly monthIn: HTMLInputElement;
  private readonly verdict: HTMLElement;
  private readonly chart: HTMLElement;
  private readonly notes: HTMLElement;
  /** Width the comparison chart was last drawn at. */
  private chartW = 0;
  /** Width the pattern chart was last drawn at. */
  private patternsW = 0;

  /** `patterns` is the separate Historical patterns card, drawn from the same record. */
  constructor(private readonly root: HTMLElement, private readonly patterns: HTMLElement) {
    root.innerHTML = `
      <div class="an-bar">
        <div class="seg" role="group" aria-label="Compare a month or a year">
          <button type="button" class="seg-btn" data-kind="month" aria-pressed="true">Month</button>
          <button type="button" class="seg-btn" data-kind="year" aria-pressed="false">Year</button>
          <span class="seg-thumb" aria-hidden="true"></span>
        </div>
        <label class="field field-inline"><span class="visually-hidden">Month</span><input class="input an-month" type="month" /></label>
        <label class="field field-inline" hidden><span class="visually-hidden">Year</span><select class="input an-year"></select></label>
        <p class="verdict" role="status"></p>
      </div>
      <div class="chart an-chart"></div>
      <div class="an-notes"></div>`;
    this.yearSel = root.querySelector(".an-year")!;
    this.monthIn = root.querySelector(".an-month")!;
    this.verdict = root.querySelector(".verdict")!;
    this.chart = root.querySelector(".an-chart")!;
    this.notes = root.querySelector(".an-notes")!;

    root.querySelector(".seg")!.addEventListener("click", (e) => {
      const btn = (e.target as Element).closest<HTMLButtonElement>("[data-kind]");
      if (!btn) return;
      this.kind = btn.dataset.kind as Kind;
      this.draw();
    });
    this.yearSel.addEventListener("change", () => {
      this.year = +this.yearSel.value;
      this.draw();
    });
    this.monthIn.addEventListener("change", () => {
      const v = this.monthIn.value;
      if (!v) return;
      this.year = +v.slice(0, 4);
      this.month = +v.slice(5, 7) - 1;
      this.draw();
    });
    redrawOnResize(this.chart, () => this.chartW, () => this.sel && this.draw());
    redrawOnResize(this.patterns, () => this.patternsW, () => this.sel && this.renderPatterns());
  }

  /** `resetPeriod` picks the busiest month of the record's last year as the period to compare. */
  render(sel: Selection, ramp: RampName, resetPeriod: boolean): void {
    this.sel = sel;
    this.ramp = ramp;
    this.renderPatterns();
    const years = recordYears(sel);
    if (resetPeriod || !this.year) {
      this.year = parts(sel.to).year;
      this.month = Math.max(0, peakMonthOfYear(sel, this.year).peak);
    }
    this.yearSel.innerHTML = years.map((y) => `<option value="${y}">${y}</option>`).join("");
    this.monthIn.min = `${years[0]}-01`;
    this.monthIn.max = `${years[years.length - 1]}-12`;
    this.draw();
  }

  /** Pattern readings and charts sized for the PNG export. */
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

  /** Yearly totals with the biggest year, and the five most fire-prone calendar months. */
  private renderPatterns(): void {
    const sel = this.sel!;
    const p = this.patternParts();
    const t = annualTrend(sel);
    const c = climatology(sel);
    const ranked = c.average.map((v, m) => ({ v, m })).sort((a, b) => b.v - a.v).slice(0, 5);
    const steps = RAMPS[this.ramp].steps;
    const max = ranked[0]?.v || 1;
    this.patternsW = drawAtWidth(this.patterns, 290, (width) => {
      this.patterns.innerHTML = `
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

  private result(): AnomalyResult {
    return this.kind === "month" ? anomalyForMonth(this.sel!, this.year, this.month) : anomalyForYear(this.sel!, this.year);
  }

  /** Builds the comparison chart; the card draws it near its shown width, the export at its own. */
  private chartSvg(a: AnomalyResult, width = 360, height = 140): string {
    return lineChart({
      title: a.title,
      labels: a.kind === "month" ? a.labels.map((y) => `'${y.slice(2)}`) : a.labels,
      series: [
        { name: a.kind === "month" ? "Fire cell-days" : `${a.selected.label}`, values: a.values, color: CHART.accent, width: 2 },
        { name: "Historical average", values: a.mean, color: CHART.ink2, dash: "5 3" },
        { name: "Historical median", values: a.median, color: CHART.median, dash: "1.5 3" },
      ],
      band: {
        name: "Usual range",
        lo: a.mean.map((m, i) => Math.max(0, 2 * m - a.threshold[i])),
        hi: a.threshold,
        color: "rgba(205, 187, 168, 0.13)",
      },
      flags: a.unusual,
      selected: a.selectedIndex,
      width,
      height,
    });
  }

  /** Short in its column; taller when the card is open in the larger view. */
  private chartHeight(width: number): number {
    return this.root.closest(".is-expanded") ? Math.round(Math.min(340, Math.max(160, width * 0.38))) : 140;
  }

  private draw(): void {
    this.root.querySelectorAll<HTMLButtonElement>("[data-kind]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.kind === this.kind)));
    this.monthIn.closest("label")!.hidden = this.kind !== "month";
    this.yearSel.closest("label")!.hidden = this.kind !== "year";
    this.monthIn.value = `${this.year}-${String(this.month + 1).padStart(2, "0")}`;
    this.yearSel.value = String(this.year);

    const a = this.result();
    const v = VERDICT[a.verdict];
    this.verdict.className = `verdict is-${v.tone}`;
    this.verdict.title = `Unusual means more than ${UNUSUAL_SD} standard deviations above the other years. Ringed points on the chart are unusual.`;
    this.verdict.innerHTML = `<span class="verdict-k">${escapeXml(a.selected.label)}</span> ${v.label}`;
    this.chartW = drawAtWidth(this.chart, 360, (width) => (this.chart.innerHTML = this.chartSvg(a, width, this.chartHeight(width))));
    const unusualMonths = a.kind === "year" ? a.labels.filter((_, i) => a.unusual[i]) : [];
    this.notes.innerHTML = `<p class="mini-note">
      <strong>${fmtVal(a.selected.value)}</strong> ${UNIT_SHORT}, average ${fmtVal(a.selected.mean)}, median ${fmtVal(a.selected.median)}.
      ${unusualMonths.length ? `Unusual months: <strong>${unusualMonths.join(", ")}</strong>.` : ""}
      Other unusual ${a.kind === "month" ? "years for this month" : "years"}: ${a.history.length ? a.history.join(", ") : "none"}.</p>`;
  }

  csv(): { header: string[]; rows: Cell[][] } {
    const a = this.result();
    const r = (n: number) => Math.round(n * 10) / 10;
    const t = annualTrend(this.sel!);
    const c = climatology(this.sel!);
    return {
      header: ["section", "key", "fire_cell_days", "historical_average", "historical_median", "unusual_threshold", "unusual"],
      rows: [
        ...t.years.map<Cell[]>((y, i) => ["annual_total", y, r(t.totals[i])]),
        ["annual_trend_pct_per_year", "", r(t.percentPerYear)],
        ...c.average.map<Cell[]>((v, m) => ["monthly_average", MONTHS[m], r(v)]),
        ...a.labels.map<Cell[]>((l, i) => ["comparison", l, r(a.values[i]), r(a.mean[i]), r(a.median[i]), r(a.threshold[i]), a.unusual[i] ? "yes" : "no"]),
      ],
    };
  }

  svg(subtitle: string): { svg: string; width: number; height: number } {
    const a = this.result();
    const width = 720;
    const cw = width - 48;
    const p = this.patternParts();
    const strip = (html: string) => escapeXml(html.replace(/<[^>]+>/g, ""));
    const blocks: string[] = [];
    let y = 14;
    for (const [text, svg] of [[p.trendText, p.trendSvg], [p.climText, p.climSvg]]) {
      blocks.push(`<text x="24" y="${y}" fill="${CHART.ink2}" font-size="12">${strip(text)}</text>`, place(svg, 24, y + 10, cw));
      y += 32 + svgHeight(svg, cw);
    }
    const chart = this.chartSvg(a, 760, 170);
    const tone = CHART[VERDICT[a.verdict].tone];
    blocks.push(`<text x="24" y="${y}" fill="${tone}" font-size="13">${escapeXml(`${a.selected.label}: ${VERDICT[a.verdict].label}`)}</text>
      <text x="24" y="${y + 20}" fill="${CHART.ink2}" font-size="12">${escapeXml(`${fmtVal(a.selected.value)} ${UNIT_SHORT}. Average ${fmtVal(a.selected.mean)}, median ${fmtVal(a.selected.median)}.`)}</text>
      ${place(chart, 24, y + 32, cw)}`);
    const f = frame("Historical comparison", subtitle, blocks.join(""), width, y + 42 + svgHeight(chart, cw));
    return { svg: f.svg, width, height: f.height };
  }
}
