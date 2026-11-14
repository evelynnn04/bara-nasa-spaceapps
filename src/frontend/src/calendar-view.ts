import { monthOutsideRecord, sum } from "./analytics";
import { CHART } from "./charts";
import { MONTHS, MONTHS_LONG, daysInMonth, fromDay, monthStart, parts, weekdayMon } from "./dates";
import type { Cell } from "./export";
import { escapeXml, fmtCompact, fmtInt } from "./format";
import { reducedMotion } from "./fx";
import { RAMPS, colorFor, inkOn, stepBounds, type RampName } from "./ramps";
import type { Selection } from "./store";

type Level = { kind: "years" } | { kind: "days"; year: number; month: number };

interface CellData {
  label: string;
  value: number;
  /** "data" has a count, "zero" has none, "none" is outside the record or the selected dates. */
  state: "data" | "zero" | "none";
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const SPRING = "cubic-bezier(0.34, 1.56, 0.64, 1)";
const EASE_OUT = "cubic-bezier(0.22, 1, 0.36, 1)";

/**
 * Burning activity calendar: a month-by-year heatmap that drills into a daily heatmap for one month,
 * with a back button and a label for the current granularity.
 */
export class CalendarView {
  private level: Level = { kind: "years" };
  private sel: Selection | null = null;
  private ramp: RampName = "ember";
  private readonly stage: HTMLElement;
  private readonly back: HTMLButtonElement;
  private readonly crumb: HTMLElement;
  private readonly legend: HTMLElement;

  constructor(root: HTMLElement) {
    root.innerHTML = `
      <div class="cal-bar">
        <button type="button" class="pill cal-back" hidden><span class="chev chev-left" aria-hidden="true"></span>Back to months</button>
        <p class="cal-crumb" aria-live="polite"></p>
      </div>
      <div class="cal-stage"></div>
      <div class="legend" aria-label="Colour legend"></div>`;
    this.stage = root.querySelector(".cal-stage")!;
    this.back = root.querySelector(".cal-back")!;
    this.crumb = root.querySelector(".cal-crumb")!;
    this.legend = root.querySelector(".legend")!;
    this.back.addEventListener("click", () => this.goBack());
    this.stage.addEventListener("click", (e) => {
      const cell = (e.target as Element).closest<HTMLButtonElement>("button.cell");
      if (cell) this.drill(+cell.dataset.y!, +cell.dataset.m!, cell);
    });
  }

  get granularity(): string {
    return this.level.kind === "years" ? "Month by year" : `Day, ${MONTHS_LONG[this.level.month]} ${this.level.year}`;
  }

  render(sel: Selection, ramp: RampName): void {
    this.sel = sel;
    this.ramp = ramp;
    this.stage.replaceChildren(this.buildLayer());
    this.syncChrome();
  }

  private syncChrome(): void {
    const days = this.level.kind === "days";
    this.back.hidden = !days;
    this.crumb.innerHTML = `<span class="crumb-k">Granularity</span> <strong>${escapeXml(this.granularity)}</strong>`;
    const { max } = this.cells();
    const steps = RAMPS[this.ramp].steps;
    const bounds = stepBounds(max, steps.length);
    this.legend.innerHTML = `
      <span class="legend-k">${days ? "Detections per day" : "Detections per month"}</span>
      <span class="legend-ramp">${steps.map((c, i) => `<span class="sw" style="background:${c}" title="${fmtInt(bounds[i])}+"></span>`).join("")}</span>
      <span class="legend-ends"><span>${fmtCompact(bounds[0])}</span><span>${fmtCompact(max)}</span></span>
      <span class="legend-item"><span class="sw sw-zero"></span>Zero</span>
      <span class="legend-item"><span class="sw sw-none"></span>No data or outside dates</span>`;
  }

  /** Cell values for the current level. Rows are years (or weeks), columns months (or weekdays). */
  private cells(): { rows: { label: string; cells: (CellData & { y: number; m: number; day?: number })[] }[]; max: number } {
    const sel = this.sel!;
    const rows: { label: string; cells: (CellData & { y: number; m: number; day?: number })[] }[] = [];
    let max = 0;
    if (this.level.kind === "years") {
      const a = parts(sel.from).year;
      const b = parts(sel.to).year;
      for (let y = a; y <= b; y++) {
        const cells = MONTHS.map((_, m) => {
          const start = monthStart(y, m);
          const end = start + daysInMonth(y, m) - 1;
          const outside = monthOutsideRecord(sel, y, m) || end < sel.from || start > sel.to;
          const value = outside ? 0 : sum(sel, Math.max(start, sel.from), Math.min(end, sel.to));
          if (!outside) max = Math.max(max, value);
          return { y, m, label: `${MONTHS_LONG[m]} ${y}`, value, state: outside ? "none" : value ? "data" : "zero" } as const;
        });
        rows.push({ label: String(y), cells });
      }
    } else {
      const { year, month } = this.level;
      const start = monthStart(year, month);
      const n = daysInMonth(year, month);
      const lead = weekdayMon(start);
      let week: (CellData & { y: number; m: number; day?: number })[] = [];
      for (let i = 0; i < lead; i++) week.push({ y: year, m: month, label: "", value: 0, state: "none" });
      for (let d = 0; d < n; d++) {
        const day = start + d;
        const outside = day < sel.from || day > sel.to || day < sel.firstDay || day > sel.lastDay;
        const value = outside ? 0 : sel.daily[day - sel.firstDay];
        if (!outside) max = Math.max(max, value);
        week.push({ y: year, m: month, day: d + 1, label: `${d + 1} ${MONTHS_LONG[month]} ${year}`, value, state: outside ? "none" : value ? "data" : "zero" });
        if (week.length === 7) {
          rows.push({ label: "", cells: week });
          week = [];
        }
      }
      if (week.length) rows.push({ label: "", cells: week });
    }
    return { rows, max };
  }

  private buildLayer(): HTMLElement {
    const { rows, max } = this.cells();
    const layer = document.createElement("div");
    const days = this.level.kind === "days";
    layer.className = `cal-layer ${days ? "is-days" : "is-years"}`;
    const head = (days ? WEEKDAYS : MONTHS).map((h) => `<span class="cal-h" aria-hidden="true">${h}</span>`).join("");
    const body = rows
      .map((row, r) => {
        const label = days ? "" : `<span class="cal-y">${row.label}</span>`;
        const cells = row.cells
          .map((c, i) => {
            const fill = c.state === "data" ? colorFor(c.value, max, this.ramp)! : "";
            const style = `--d:${r + i}${fill ? `;background:${fill};color:${inkOn(fill)}` : ""}`;
            const text = c.state === "none" ? "no data" : `${fmtInt(c.value)} detections`;
            if (days) {
              if (!c.day) return `<span class="cell is-blank" aria-hidden="true"></span>`;
              return `<span class="cell is-${c.state}" style="${style}" role="img" aria-label="${c.label}: ${text}" title="${c.label}: ${text}">
                <span class="cell-day">${c.day}</span><span class="cell-v">${c.state === "none" ? "" : fmtCompact(c.value)}</span></span>`;
            }
            if (c.state === "none") return `<span class="cell is-none" style="${style}" role="img" aria-label="${c.label}: outside the selected dates" title="${c.label}: outside the selected dates"></span>`;
            return `<button type="button" class="cell is-${c.state}" style="${style}" data-y="${c.y}" data-m="${c.m}" aria-label="${c.label}: ${text}. Show days" title="${c.label}: ${text}">
              <span class="cell-v">${fmtCompact(c.value)}</span></button>`;
          })
          .join("");
        return label + cells;
      })
      .join("");
    layer.innerHTML = `<div class="cal-grid" role="group" aria-label="${escapeXml(this.granularity)} heatmap">${days ? "" : '<span class="cal-h cal-corner"></span>'}${head}${body}</div>`;
    return layer;
  }

  private drill(year: number, month: number, from: HTMLElement): void {
    const origin = this.originOf(from);
    this.level = { kind: "days", year, month };
    this.swap(origin, "in");
    this.back.focus();
  }

  private goBack(): void {
    if (this.level.kind !== "days") return;
    const { year, month } = this.level;
    this.level = { kind: "years" };
    const next = this.swap(null, "out", `button.cell[data-y="${year}"][data-m="${month}"]`);
    next.querySelector<HTMLElement>(`button.cell[data-y="${year}"][data-m="${month}"]`)?.focus({ preventScroll: true });
  }

  private originOf(el: HTMLElement): { x: number; y: number; s: number } {
    const a = this.stage.getBoundingClientRect();
    const b = el.getBoundingClientRect();
    return { x: b.left - a.left + b.width / 2, y: b.top - a.top + b.height / 2, s: Math.max(0.08, b.width / a.width) };
  }

  /** Replaces the visible layer, zooming out of (or back into) the month cell that was clicked. */
  private swap(origin: { x: number; y: number; s: number } | null, dir: "in" | "out", returnTo = ""): HTMLElement {
    const old = this.stage.firstElementChild as HTMLElement | null;
    const next = this.buildLayer();
    this.stage.append(next);
    this.syncChrome();
    if (!old) return next;

    const done = () => old.remove();
    if (reducedMotion()) {
      old.remove();
      next.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: EASE_OUT });
      return next;
    }
    old.classList.add("is-leaving");
    if (dir === "in" && origin) {
      const o = `${origin.x}px ${origin.y}px`;
      next.style.transformOrigin = o;
      old.style.transformOrigin = o;
      next.animate([{ transform: `scale(${origin.s})`, opacity: 0 }, { transform: "scale(1)", opacity: 1 }], { duration: 420, easing: SPRING });
      old.animate([{ transform: "scale(1)", opacity: 1 }, { transform: "scale(2.4)", opacity: 0 }], { duration: 300, easing: EASE_OUT }).onfinish = done;
    } else {
      const cell = returnTo ? next.querySelector<HTMLElement>(returnTo) : null;
      const target = cell ? this.originOf(cell) : { x: 0, y: 0, s: 0.2 };
      old.style.transformOrigin = `${target.x}px ${target.y}px`;
      next.style.transformOrigin = `${target.x}px ${target.y}px`;
      old.animate([{ transform: "scale(1)", opacity: 1 }, { transform: `scale(${Math.max(0.12, target.s)})`, opacity: 0 }], { duration: 320, easing: EASE_OUT }).onfinish = done;
      next.animate([{ transform: "scale(1.6)", opacity: 0 }, { transform: "scale(1)", opacity: 1 }], { duration: 420, easing: SPRING });
    }
    return next;
  }

  /** Rows for the CSV export at the current granularity. */
  csv(): { header: string[]; rows: Cell[][] } {
    const { rows } = this.cells();
    const flat = rows.flatMap((r) => r.cells).filter((c) => this.level.kind === "years" || c.day);
    if (this.level.kind === "years") {
      return {
        header: ["year", "month", "detections", "status"],
        rows: flat.map((c) => [c.y, MONTHS[c.m], c.state === "none" ? "" : c.value, c.state === "none" ? "outside dates" : c.state]),
      };
    }
    return {
      header: ["date", "detections", "status"],
      rows: flat.map((c) => [fromDay(monthStart(c.y, c.m) + c.day! - 1), c.state === "none" ? "" : c.value, c.state === "none" ? "outside dates" : c.state]),
    };
  }

  /** The calendar as a standalone SVG in the same dark palette, for the PNG export. */
  svg(): { svg: string; width: number; height: number } {
    const { rows, max } = this.cells();
    const days = this.level.kind === "days";
    const cw = days ? 56 : 44;
    const ch = days ? 44 : 26;
    const gap = 3;
    const left = days ? 0 : 44;
    const top = 18;
    const cols = days ? 7 : 12;
    const width = left + cols * (cw + gap) + 24;
    const height = top + rows.length * (ch + gap) + 44;
    const head = (days ? WEEKDAYS : MONTHS)
      .map((h, i) => `<text x="${left + i * (cw + gap) + cw / 2}" y="12" text-anchor="middle" fill="${CHART.ink3}" font-size="10">${h}</text>`)
      .join("");
    const body = rows
      .map((row, r) => {
        const y = top + r * (ch + gap);
        const label = days ? "" : `<text x="${left - 8}" y="${y + ch / 2 + 3.5}" text-anchor="end" fill="${CHART.ink2}" font-size="10.5">${row.label}</text>`;
        return (
          label +
          row.cells
            .map((c, i) => {
              const x = left + i * (cw + gap);
              if (days && !c.day) return "";
              if (c.state === "none") return `<rect x="${x}" y="${y}" width="${cw}" height="${ch}" rx="4" fill="url(#hatch)"/>`;
              if (c.state === "zero") return `<rect x="${x + 0.5}" y="${y + 0.5}" width="${cw - 1}" height="${ch - 1}" rx="4" fill="none" stroke="${CHART.line}" stroke-width="1"/>`;
              const fill = colorFor(c.value, max, this.ramp)!;
              const ink = inkOn(fill);
              const dayText = days ? `<text x="${x + 5}" y="${y + 12}" fill="${ink}" font-size="9" opacity="0.8">${c.day}</text>` : "";
              return `<rect x="${x}" y="${y}" width="${cw}" height="${ch}" rx="4" fill="${fill}"/>${dayText}<text x="${x + cw / 2}" y="${y + ch / 2 + (days ? 9 : 3.5)}" text-anchor="middle" fill="${ink}" font-size="10">${fmtCompact(c.value)}</text>`;
            })
            .join("")
        );
      })
      .join("");
    const steps = RAMPS[this.ramp].steps;
    const ly = height - 26;
    const legend = steps.map((c, i) => `<rect x="${left + i * 18}" y="${ly}" width="16" height="10" rx="2" fill="${c}"/>`).join("") +
      `<text x="${left}" y="${ly + 24}" fill="${CHART.ink3}" font-size="10">${fmtCompact(stepBounds(max, steps.length)[0])}</text>` +
      `<text x="${left + steps.length * 18 - 2}" y="${ly + 24}" text-anchor="end" fill="${CHART.ink3}" font-size="10">${fmtCompact(max)}</text>` +
      `<rect x="${left + steps.length * 18 + 16}" y="${ly}" width="16" height="10" rx="2" fill="none" stroke="${CHART.line}"/><text x="${left + steps.length * 18 + 38}" y="${ly + 9}" fill="${CHART.ink3}" font-size="10">Zero</text>` +
      `<rect x="${left + steps.length * 18 + 80}" y="${ly}" width="16" height="10" rx="2" fill="url(#hatch)"/><text x="${left + steps.length * 18 + 102}" y="${ly + 9}" fill="${CHART.ink3}" font-size="10">No data / outside dates</text>`;
    const defs = `<defs><pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="#1a1310"/><line x1="0" y1="0" x2="0" y2="6" stroke="${CHART.line}" stroke-width="2"/></pattern></defs>`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="100%">${defs}<g transform="translate(24 0)">${head}${body}${legend}</g></svg>`;
    return { svg, width, height };
  }
}
