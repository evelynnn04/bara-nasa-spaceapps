import type { AgreementMonth, AgreementResponse, Metrics } from "./api";
import { CHART, drawAtWidth, lineChart, redrawOnResize } from "./charts";
import { MONTHS, MONTHS_LONG } from "./dates";
import { UNIT, UNIT_SHORT, escapeXml, fmtInt, fmtVal } from "./format";
import { SelectMenu } from "./select-menu";

type Mode = "harmonised" | "raw";

const DOCS_URL = "https://github.com/evelynnn04/bara-nasa-spaceapps/blob/main/docs/harmonisation.md";

const TONE: Record<string, string> = { converged: "is-good", partial: "is-warning", "did not converge": "is-critical" };

/** Peak month (0-11) of twelve monthly values, or -1 when all are zero. */
export function peakMonth(values: number[]): number {
  let best = -1;
  values.forEach((v, i) => {
    if (v > 0 && (best < 0 || v > values[best])) best = i;
  });
  return best;
}

/** Plain-language reading of the agreement metrics, e.g. "typical monthly difference 8 %". */
export function describe(m: Metrics): { k: string; v: string; note: string }[] {
  if (m.r_log === null) return [];
  const diff = m.malr === null ? "–" : `${Math.round((Math.exp(m.malr) - 1) * 100)} %`;
  const bias = m.bias === null ? "–" : `${m.bias.toFixed(2)}×`;
  return [
    { k: "Correlation", v: m.r_log.toFixed(3), note: `Monthly values on a log scale, ${m.n_months} months` },
    { k: "Typical monthly difference", v: diff, note: "Median gap between the two sensors in months with activity" },
    { k: "VIIRS ÷ MODIS overall", v: bias, note: "1.00× means neither sensor reads higher" },
    { k: "Same peak month", v: `${m.peak_matches} of ${m.peak_years} years`, note: "Years with at least ten observed months" },
  ];
}

/**
 * "Do MODIS and VIIRS agree here?": monthly MODIS cell-days against harmonised VIIRS (or raw pixels
 * of both) for one year, on days both satellites observed, with the area's agreement metrics.
 */
export class AgreementView {
  private data: AgreementResponse | null = null;
  private nationalVerdict = "";
  private mode: Mode = "harmonised";
  private year = 0;
  private chartW = 0;
  private readonly yearMenu: SelectMenu;
  private readonly reading: HTMLElement;
  private readonly chart: HTMLElement;
  private readonly stats: HTMLElement;
  private readonly note: HTMLElement;

  constructor(private readonly root: HTMLElement) {
    root.innerHTML = `
      <div class="an-bar">
        <div class="seg" role="group" aria-label="Values compared">
          <button type="button" class="seg-btn" data-ag="harmonised" aria-pressed="true">Harmonised</button>
          <button type="button" class="seg-btn" data-ag="raw" aria-pressed="false">Raw pixels</button>
          <span class="seg-thumb" aria-hidden="true"></span>
        </div>
        <div class="ag-year"></div>
      </div>
      <p class="reading ag-reading" aria-live="polite"></p>
      <div class="chart ag-chart"></div>
      <ul class="dev-list ag-stats"></ul>
      <p class="mini-note ag-note"></p>`;
    this.yearMenu = new SelectMenu(root.querySelector(".ag-year")!, "Year", [], "", (value) => {
      this.year = +value;
      this.draw();
    });
    this.reading = root.querySelector(".ag-reading")!;
    this.chart = root.querySelector(".ag-chart")!;
    this.stats = root.querySelector(".ag-stats")!;
    this.note = root.querySelector(".ag-note")!;
    root.querySelector(".seg")!.addEventListener("click", (e) => {
      const btn = (e.target as Element).closest<HTMLButtonElement>("[data-ag]");
      if (!btn) return;
      this.mode = btn.dataset.ag as Mode;
      this.draw();
    });
    redrawOnResize(this.chart, () => this.chartW, () => this.data && this.drawChart());
  }

  /** Shows an area's agreement data; `year` is preselected when the area has it. */
  render(data: AgreementResponse, nationalVerdict: string, year: number): void {
    this.data = data;
    this.nationalVerdict = nationalVerdict;
    const years = [...new Set(data.months.map((m) => m.year))];
    if (!years.includes(this.year)) this.year = years.includes(year) ? year : years[years.length - 1] ?? year;
    this.yearMenu.setOptions(years.map((y) => ({ value: String(y), label: String(y) })).reverse(), String(this.year));
    this.draw();
  }

  /** Monthly MODIS and VIIRS values of the selected year in the current mode. */
  private values(): { modis: number[]; viirs: number[]; days: number[] } {
    const byMonth = new Map<number, AgreementMonth>();
    for (const m of this.data!.months) if (m.year === this.year) byMonth.set(m.month, m);
    const pick = (m: AgreementMonth | undefined, k: "modis" | "viirs") => (m ? (this.mode === "raw" ? m[`${k}_px`] : m[k]) : 0);
    return {
      modis: MONTHS.map((_, i) => pick(byMonth.get(i + 1), "modis")),
      viirs: MONTHS.map((_, i) => pick(byMonth.get(i + 1), "viirs")),
      days: MONTHS.map((_, i) => byMonth.get(i + 1)?.paired_days ?? 0),
    };
  }

  private draw(): void {
    if (!this.data) return;
    this.root.querySelectorAll<HTMLButtonElement>("[data-ag]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.ag === this.mode)));
    const { modis, viirs } = this.values();
    const pm = peakMonth(modis);
    const pv = peakMonth(viirs);
    const unit = this.mode === "raw" ? "pixels" : UNIT_SHORT;
    if (pm < 0 && pv < 0) this.reading.textContent = `Neither sensor recorded fire in ${this.year} on days both observed.`;
    else {
      const same = pm === pv;
      const ratio = (a: number[]) => (a[8] > 0 && a[9] > 0 ? (a[8] / a[9]).toFixed(2) : null);
      const story = this.year === 2015 && ratio(modis) && ratio(viirs)
        ? ` September ÷ October: MODIS ${ratio(modis)}, VIIRS ${ratio(viirs)}.`
        : "";
      this.reading.innerHTML = `In ${this.year}, MODIS peaks in <strong>${MONTHS_LONG[pm] ?? "–"}</strong> and VIIRS in <strong>${MONTHS_LONG[pv] ?? "–"}</strong>${
        same ? ": they agree." : `: they disagree${this.mode === "raw" ? "." : " (often a near-tie)."}`}${story}`;
    }
    this.drawChart();
    const m = this.mode === "raw" ? this.data.raw : this.data.harmonised;
    const rows = describe(m);
    const verdict = `<li><span class="dev-k">Verdict, ${this.data.window[0].slice(0, 4)}–${this.data.window[1].slice(0, 4)}</span><span class="dev-v ag-verdict ${TONE[m.verdict] ?? ""}">${escapeXml(m.verdict)}</span>
      <span class="mini-note">${this.mode === "raw" ? "Raw counts, before harmonisation" : `In ${unit}`}</span></li>`;
    this.stats.innerHTML = rows.length
      ? verdict + rows.map((r) => `<li><span class="dev-k">${r.k}</span><span class="dev-v">${escapeXml(r.v)}</span><span class="mini-note">${r.note}</span></li>`).join("")
      : `<li><span class="dev-k">Not enough months with activity to compare here.</span></li>`;
    this.note.innerHTML = `Values are ${UNIT}: a VIIRS cell counts the square root of its pixels divided by an island-group and month factor, and a MODIS cell counts once. Only days both satellites observed are compared. Across Indonesia, predicting each year from the other years, the agreement is rated <strong>${escapeXml(this.nationalVerdict)}</strong>. <a href="${DOCS_URL}" target="_blank" rel="noopener">How it works</a>`;
  }

  private drawChart(): void {
    const { modis, viirs, days } = this.values();
    const raw = this.mode === "raw";
    const labels = MONTHS.map((m, i) => (days[i] ? m[0] : `${m[0]}*`));
    this.chartW = drawAtWidth(this.chart, 340, (width) => {
      this.chart.innerHTML = lineChart({
        title: `MODIS and VIIRS by month, ${this.year}`,
        labels,
        series: [
          { name: raw ? "MODIS pixels" : "MODIS cell-days", values: modis, color: CHART.median, width: 2 },
          { name: raw ? "VIIRS pixels" : "VIIRS harmonised", values: viirs, color: CHART.accent, width: 2 },
        ],
        width,
        height: 190,
      });
    });
    const totals = `MODIS ${raw ? fmtInt(modis.reduce((a, b) => a + b, 0)) : fmtVal(modis.reduce((a, b) => a + b, 0))}, VIIRS ${raw ? fmtInt(viirs.reduce((a, b) => a + b, 0)) : fmtVal(viirs.reduce((a, b) => a + b, 0))} in ${this.year}`;
    this.chart.setAttribute("title", totals);
  }
}
