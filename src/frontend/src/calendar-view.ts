import { monthOutsideRecord, sum } from "./analytics";
import { MONTHS, MONTHS_LONG, daysInMonth, fromDay, monthStart, parts, weekdayMon } from "./dates";
import type { Cell } from "./export";
import { UNIT_SHORT, escapeXml, fmtCompact, fmtVal } from "./format";
import { reducedMotion } from "./fx";
import { RAMPS, colorFor, inkOn, stepBounds, type RampName } from "./ramps";
import { SelectMenu } from "./select-menu";
import type { Selection } from "./store";

type Level = { kind: "year" } | { kind: "days"; year: number; month: number };

interface CellData {
  label: string;
  value: number;
  /** "data" has activity, "zero" has none, "missed" was not observed, "none" is outside the record. */
  state: "data" | "zero" | "missed" | "none";
}

const round4 = (v: number) => Math.round(v * 1e4) / 1e4;

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const SPRING = "cubic-bezier(0.34, 1.56, 0.64, 1)";
const EASE_OUT = "cubic-bezier(0.22, 1, 0.36, 1)";

/**
 * Burning activity calendar: every day of one picked year as twelve small month grids, each opening
 * a daily heatmap of that month. A year picker, a breadcrumb and previous and next buttons move through
 * the record; the dashboard's date filter does not apply here.
 */
export class CalendarView {
  private level: Level = { kind: "year" };
  /** Year shown at the year level; 0 until the first record arrives. */
  private year = 0;
  private sel: Selection | null = null;
  private ramp: RampName = "ember";
  private readonly stage: HTMLElement;
  private readonly back: HTMLButtonElement;
  private readonly crumb: HTMLElement;
  private readonly yearField: HTMLElement;
  /** Year dropdown, built once the record's years are known. */
  private yearMenu: SelectMenu | null = null;
  private yearSpan = "";
  private readonly nav: HTMLElement;
  private readonly prev: HTMLButtonElement;
  private readonly next: HTMLButtonElement;
  private readonly legend: HTMLElement;

  constructor(root: HTMLElement) {
    root.innerHTML = `
      <div class="cal-bar">
        <button type="button" class="pill cal-back" hidden><span class="chev chev-left" aria-hidden="true"></span>Back to year</button>
        <div class="cal-year"></div>
        <nav class="cal-crumb" aria-label="Calendar level"><ol></ol></nav>
        <div class="cal-nav">
          <button type="button" class="icon-btn cal-step" data-step="-1"><span class="chev chev-left" aria-hidden="true"></span></button>
          <button type="button" class="icon-btn cal-step" data-step="1"><span class="chev chev-right" aria-hidden="true"></span></button>
        </div>
      </div>
      <div class="cal-stage"></div>
      <div class="legend" aria-label="Colour legend"></div>`;
    this.stage = root.querySelector(".cal-stage")!;
    this.back = root.querySelector(".cal-back")!;
    this.crumb = root.querySelector(".cal-crumb ol")!;
    this.yearField = root.querySelector(".cal-year")!;
    this.nav = root.querySelector(".cal-nav")!;
    [this.prev, this.next] = root.querySelectorAll<HTMLButtonElement>(".cal-step");
    this.legend = root.querySelector(".legend")!;
    this.back.addEventListener("click", () => this.goBack());
    this.crumb.addEventListener("click", (e) => {
      if ((e.target as Element).closest(".crumb-link")) this.goBack();
    });
    this.nav.addEventListener("click", (e) => {
      const btn = (e.target as Element).closest<HTMLButtonElement>(".cal-step");
      if (btn && !btn.disabled) this.step(+btn.dataset.step!);
    });
    this.stage.addEventListener("click", (e) => {
      const month = (e.target as Element).closest<HTMLButtonElement>("button.cal-month");
      if (month) this.drill(this.year, +month.dataset.m!, month);
    });
  }

  get granularity(): string {
    return this.level.kind === "year" ? "Month by year" : `Day, ${MONTHS_LONG[this.level.month]} ${this.level.year}`;
  }

  render(sel: Selection, ramp: RampName): void {
    this.sel = sel;
    this.ramp = ramp;
    const [a, b] = [parts(sel.from).year, parts(sel.to).year];
    if (this.year < a || this.year > b) this.year = b;
    if (this.yearSpan !== `${a}-${b}`) {
      this.yearSpan = `${a}-${b}`;
      const years = Array.from({ length: b - a + 1 }, (_, i) => ({ value: String(b - i), label: String(b - i) }));
      this.yearMenu = new SelectMenu(this.yearField, "Year", years, String(this.year), (value) => {
        const dir = +value < this.year ? "prev" : "next";
        this.year = +value;
        this.swap(null, dir);
      });
    }
    this.stage.replaceChildren(this.buildLayer());
    this.syncChrome();
  }

  private syncChrome(): void {
    const days = this.level.kind === "days";
    this.back.hidden = !days;
    this.yearField.hidden = days;
    this.yearMenu?.set(String(this.year));
    this.crumb.innerHTML = this.level.kind === "days"
      ? `<li><button type="button" class="crumb-link">${this.level.year}</button></li><li aria-current="page">${MONTHS_LONG[this.level.month]}</li>`
      : "";
    for (const btn of [this.prev, this.next]) {
      const t = this.neighbour(+btn.dataset.step!);
      const name = !t ? "" : t.month === undefined ? String(t.year) : `${MONTHS_LONG[t.month]} ${t.year}`;
      const which = `${btn === this.prev ? "Previous" : "Next"} ${days ? "month" : "year"}`;
      btn.disabled = !t;
      btn.setAttribute("aria-label", t ? `${which}, ${name}` : which);
      btn.title = name;
    }
    const max = this.level.kind === "days" ? this.cells().max : this.yearMonths().max;
    const steps = RAMPS[this.ramp].steps;
    const bounds = stepBounds(max, steps.length);
    this.legend.innerHTML = `
      <span class="legend-scale"><span class="legend-end">0</span><span class="legend-ramp"><span class="sw sw-zero" title="0"></span>${steps.map((c, i) => `<span class="sw" style="background:${c}" title="${fmtVal(bounds[i])}+"></span>`).join("")}</span><span class="legend-end">${fmtCompact(max)}</span></span>
      <span class="legend-item"><span class="sw sw-none"></span>Not observed</span>`;
  }

  /** The year or month `delta` steps away from the shown one, or null when it lies outside the record. */
  private neighbour(delta: number): { year: number; month?: number } | null {
    if (!this.sel) return null;
    if (this.level.kind === "year") {
      const year = this.year + delta;
      return year < parts(this.sel.from).year || year > parts(this.sel.to).year ? null : { year };
    }
    const i = this.level.year * 12 + this.level.month + delta;
    const year = Math.floor(i / 12);
    const month = i % 12;
    const start = monthStart(year, month);
    const end = start + daysInMonth(year, month) - 1;
    if (monthOutsideRecord(this.sel, year, month) || end < this.sel.from || start > this.sel.to) return null;
    return { year, month };
  }

  private step(delta: number): void {
    const t = this.neighbour(delta);
    if (!t) return;
    this.year = t.year;
    if (t.month !== undefined) this.level = { kind: "days", year: t.year, month: t.month };
    this.swap(null, delta < 0 ? "prev" : "next");
  }

  /** Days of the picked year grouped by month, with each month's total and the year's busiest day. */
  private yearMonths(): { months: { m: number; total: number; outside: boolean; lead: number; days: CellData["state"][]; values: number[] }[]; max: number; maxTotal: number } {
    const sel = this.sel!;
    let max = 0;
    const months = MONTHS.map((_, m) => {
      const start = monthStart(this.year, m);
      const values: number[] = [];
      const days: CellData["state"][] = [];
      let total = 0;
      for (let day = start; day < start + daysInMonth(this.year, m); day++) {
        const outside = day < sel.from || day > sel.to;
        const value = outside ? 0 : sel.daily[day - sel.firstDay];
        values.push(value);
        days.push(outside ? "none" : sel.missing[day - sel.firstDay] === 1 ? "missed" : value ? "data" : "zero");
        total += value;
        max = Math.max(max, value);
      }
      return { m, total, outside: monthOutsideRecord(sel, this.year, m), lead: weekdayMon(start), days, values };
    });
    return { months, max, maxTotal: Math.max(...months.map((mo) => mo.total)) };
  }

  /** Month-by-year values of the whole record (for the CSV), or the weeks of the open month. */
  private cells(): { rows: { label: string; cells: (CellData & { y: number; m: number; day?: number })[] }[]; max: number } {
    const sel = this.sel!;
    const rows: { label: string; cells: (CellData & { y: number; m: number; day?: number })[] }[] = [];
    let max = 0;
    if (this.level.kind === "year") {
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
        const missed = !outside && sel.missing[day - sel.firstDay] === 1;
        const value = outside ? 0 : sel.daily[day - sel.firstDay];
        if (!outside) max = Math.max(max, value);
        const state = outside ? "none" : missed ? "missed" : value ? "data" : "zero";
        week.push({ y: year, m: month, day: d + 1, label: `${d + 1} ${MONTHS_LONG[month]} ${year}`, value, state });
        if (week.length === 7) {
          rows.push({ label: "", cells: week });
          week = [];
        }
      }
      if (week.length) rows.push({ label: "", cells: week });
    }
    return { rows, max };
  }

  /** The picked year: one button per month holding a small grid of its days. */
  private buildYear(): HTMLElement {
    const { months, max, maxTotal } = this.yearMonths();
    const layer = document.createElement("div");
    layer.className = "cal-layer is-year";
    layer.innerHTML = `<div class="cal-months" role="group" aria-label="Days of ${this.year} by month">${months
      .map((mo) => {
        const minis = `${'<i class="mini is-blank"></i>'.repeat(mo.lead)}${mo.days
          .map((state, d) => {
            const fill = state === "data" ? colorFor(mo.values[d], max, this.ramp)! : "";
            return `<i class="mini is-${state === "missed" ? "none" : state}"${fill ? ` style="background:${fill}"` : ""}></i>`;
          })
          .join("")}`;
        // The month's total sits on its own step of the colour scale, so the busiest months stand out
        const tint = mo.total ? colorFor(mo.total, maxTotal, this.ramp)! : "";
        const total = mo.outside ? "" : `<span class="cal-month-v"${tint ? ` style="background:${tint};color:${inkOn(tint)}"` : ""}>${fmtCompact(mo.total)}</span>`;
        const head = `<span class="cal-month-h"><span>${MONTHS[mo.m]}</span>${total}</span>`;
        const name = `${MONTHS_LONG[mo.m]} ${this.year}`;
        if (mo.outside) return `<span class="cal-month is-outside" role="img" aria-label="${name}: outside the record">${head}<span class="cal-mini" aria-hidden="true">${minis}</span></span>`;
        const text = `${name}: ${fmtVal(mo.total)} ${UNIT_SHORT}`;
        return `<button type="button" class="cal-month" style="--d:${mo.m}" data-m="${mo.m}" aria-label="${text}. Show days" title="${text}">${head}<span class="cal-mini" aria-hidden="true">${minis}</span></button>`;
      })
      .join("")}</div>`;
    return layer;
  }

  private buildLayer(): HTMLElement {
    if (this.level.kind === "year") return this.buildYear();
    const { rows, max } = this.cells();
    const layer = document.createElement("div");
    layer.className = "cal-layer is-days";
    const head = WEEKDAYS.map((h) => `<span class="cal-h" aria-hidden="true">${h}</span>`).join("");
    const body = rows
      .map((row, r) => {
        const cells = row.cells
          .map((c, i) => {
            const fill = c.state === "data" ? colorFor(c.value, max, this.ramp)! : "";
            const style = `--d:${r + i}${fill ? `;background:${fill};color:${inkOn(fill)}` : ""}`;
            const text = c.state === "none" ? "outside the record" : c.state === "missed" ? "not observed by the satellite" : `${fmtVal(c.value)} ${UNIT_SHORT}`;
            if (!c.day) return `<span class="cell is-blank" aria-hidden="true"></span>`;
            const cls = c.state === "missed" ? "none" : c.state;
            return `<span class="cell is-${cls}" style="${style}" role="img" aria-label="${c.label}: ${text}" title="${c.label}: ${text}">
              <span class="cell-day">${c.day}</span><span class="cell-v">${c.state === "none" || c.state === "missed" ? "" : fmtCompact(c.value)}</span></span>`;
          })
          .join("");
        return cells;
      })
      .join("");
    layer.innerHTML = `<div class="cal-grid" role="group" aria-label="${escapeXml(this.granularity)} heatmap">${head}${body}</div>`;
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
    this.year = year;
    this.level = { kind: "year" };
    const next = this.swap(null, "out", `.cal-month[data-m="${month}"]`);
    next.querySelector<HTMLElement>(`.cal-month[data-m="${month}"]`)?.focus({ preventScroll: true });
  }

  private originOf(el: HTMLElement): { x: number; y: number; s: number } {
    const a = this.stage.getBoundingClientRect();
    const b = el.getBoundingClientRect();
    return { x: b.left - a.left + b.width / 2, y: b.top - a.top + b.height / 2, s: Math.max(0.08, b.width / a.width) };
  }

  /** Replaces the visible layer, zooming out of (or back into) the month cell that was clicked. */
  private swap(origin: { x: number; y: number; s: number } | null, dir: "in" | "out" | "prev" | "next", returnTo = ""): HTMLElement {
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
    if (dir === "prev" || dir === "next") {
      const dx = dir === "next" ? 40 : -40;
      old.animate([{ transform: "translateX(0)", opacity: 1 }, { transform: `translateX(${-dx}px)`, opacity: 0 }], { duration: 220, easing: EASE_OUT }).onfinish = done;
      next.animate([{ transform: `translateX(${dx}px)`, opacity: 0 }, { transform: "translateX(0)", opacity: 1 }], { duration: 320, easing: EASE_OUT });
    } else if (dir === "in" && origin) {
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
    const flat = rows.flatMap((r) => r.cells).filter((c) => this.level.kind === "year" || c.day);
    if (this.level.kind === "year") {
      return {
        header: ["year", "month", "fire_cell_days", "status"],
        rows: flat.map((c) => [c.y, MONTHS[c.m], c.state === "none" ? "" : round4(c.value), c.state === "none" ? "outside record" : c.state]),
      };
    }
    return {
      header: ["date", "fire_cell_days", "status"],
      rows: flat.map((c) => [
        fromDay(monthStart(c.y, c.m) + c.day! - 1),
        c.state === "none" || c.state === "missed" ? "" : round4(c.value),
        c.state === "none" ? "outside record" : c.state === "missed" ? "not observed" : c.state,
      ]),
    };
  }
}
