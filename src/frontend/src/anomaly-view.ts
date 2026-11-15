import { UNUSUAL_SD, anomalyForMonth, anomalyForYear, peakMonthOfYear, recordYears, type AnomalyResult, type Verdict } from "./analytics";
import { CHART, drawAtWidth, lineChart, redrawOnResize } from "./charts";
import { parts } from "./dates";
import { frame, place, svgHeight, type Cell } from "./export";
import { UNIT_SHORT, escapeXml, fmtVal } from "./format";
import type { Selection } from "./store";

type Kind = "month" | "year";

const VERDICT: Record<Verdict, { label: string; tone: "critical" | "warning" | "good" }> = {
  unusual: { label: "Anomaly: unusually high fire activity", tone: "critical" },
  above: { label: "Above the median, within the usual range", tone: "warning" },
  usual: { label: "Within the usual range", tone: "good" },
};

/**
 * Compares a chosen month or year with its historical average and median and flags unusual activity.
 */
export class AnomalyView {
  private sel: Selection | null = null;
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

  constructor(private readonly root: HTMLElement) {
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
  }

  /** `resetPeriod` picks the busiest month of the last selected year as the period to compare. */
  render(sel: Selection, resetPeriod: boolean): void {
    this.sel = sel;
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
    this.chartW = drawAtWidth(this.chart, 360, (width) => (this.chart.innerHTML = this.chartSvg(a, width)));
    const unusualMonths = a.kind === "year" ? a.labels.filter((_, i) => a.unusual[i]) : [];
    this.notes.innerHTML = `<p class="mini-note">
      <strong>${fmtVal(a.selected.value)}</strong> ${UNIT_SHORT}, average ${fmtVal(a.selected.mean)}, median ${fmtVal(a.selected.median)}.
      ${unusualMonths.length ? `Unusual months: <strong>${unusualMonths.join(", ")}</strong>.` : ""}
      Other unusual ${a.kind === "month" ? "years for this month" : "years"}: ${a.history.length ? a.history.join(", ") : "none"}.</p>`;
  }

  csv(): { header: string[]; rows: Cell[][] } {
    const a = this.result();
    const r = (n: number) => Math.round(n * 10) / 10;
    return {
      header: [a.kind === "month" ? "year" : "month", "fire_cell_days", "historical_average", "historical_median", "unusual_threshold", "unusual"],
      rows: a.labels.map((l, i) => [l, r(a.values[i]), r(a.mean[i]), r(a.median[i]), r(a.threshold[i]), a.unusual[i] ? "yes" : "no"]),
    };
  }

  svg(subtitle: string): { svg: string; width: number; height: number } {
    const a = this.result();
    const width = 720;
    const cw = width - 48;
    const chart = this.chartSvg(a, 760, 170);
    const tone = CHART[VERDICT[a.verdict].tone];
    const body = `<text x="24" y="14" fill="${tone}" font-size="13">${escapeXml(`${a.selected.label}: ${VERDICT[a.verdict].label}`)}</text>
      <text x="24" y="34" fill="${CHART.ink2}" font-size="12">${escapeXml(`${fmtVal(a.selected.value)} ${UNIT_SHORT}. Average ${fmtVal(a.selected.mean)}, median ${fmtVal(a.selected.median)}.`)}</text>
      ${place(chart, 24, 46, cw)}`;
    const f = frame("Historical anomaly comparison", subtitle, body, width, 56 + svgHeight(chart, cw));
    return { svg: f.svg, width, height: f.height };
  }
}
