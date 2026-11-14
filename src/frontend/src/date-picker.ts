import { daysInMonth, formatDay, fromDay, monthStart, MONTHS, MONTHS_LONG, parts, toDay, weekdayMon } from "./dates";
import { escapeXml } from "./format";

const CAL = `<svg class="ico ico-sm dp-ico" viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5.5" width="16" height="14" rx="2.5"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/></svg>`;
const PREV = `<svg class="ico ico-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>`;
const NEXT = `<svg class="ico ico-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>`;
const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

type View = "days" | "months";

let uid = 0;

/**
 * A date field in the glass style with its own calendar popup, used instead of a native
 * date input so the open calendar matches the app. Values are YYYY-MM-DD strings.
 */
export class DatePicker {
  private value = "";
  private min = "";
  private max = "";
  /** Day number of the day that holds keyboard focus in the grid. */
  private cursor = 0;
  private view: View = "days";
  /** Year shown in the month view. */
  private year = 0;
  private readonly button: HTMLButtonElement;
  private readonly pop: HTMLElement;
  private readonly id = `dp${++uid}`;

  /**
   * @param root Element the field is rendered into.
   * @param label Short label shown inside the field, e.g. "From".
   * @param range Returns the currently selected start and end, used to tint the days between them.
   * @param onChange Called with the new value after the user picks a date.
   */
  constructor(
    private readonly root: HTMLElement,
    private readonly label: string,
    private readonly range: () => [string, string],
    private readonly onChange: (value: string) => void,
  ) {
    root.classList.add("dp");
    root.innerHTML = `
      <button type="button" class="hf hf-date dp-button" aria-haspopup="dialog" aria-expanded="false" aria-controls="${this.id}-pop">
        <span class="hf-k">${escapeXml(label)}</span>
        <span class="dp-value"></span>
        ${CAL}
      </button>
      <div class="dp-pop" id="${this.id}-pop" role="dialog" tabindex="-1" aria-label="Choose the ${escapeXml(label.toLowerCase())} date"></div>`;
    this.button = root.querySelector(".dp-button")!;
    this.pop = root.querySelector(".dp-pop")!;

    this.button.addEventListener("click", () => (this.isOpen() ? this.close() : this.open()));
    this.button.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        this.open();
      }
    });
    this.pop.addEventListener("click", (e) => this.onClick(e));
    this.pop.addEventListener("keydown", (e) => this.onKey(e));
    root.addEventListener("focusout", () =>
      setTimeout(() => {
        if (this.isOpen() && !root.contains(document.activeElement)) this.close(false);
      }),
    );
    document.addEventListener("pointerdown", (e) => {
      if (this.isOpen() && !root.contains(e.target as Node)) this.close(false);
    });
  }

  /** Sets the earliest and latest dates that can be picked. */
  setBounds(min: string, max: string): void {
    this.min = min;
    this.max = max;
  }

  /** Sets the value without notifying. */
  set(value: string): void {
    this.value = value;
    this.button.querySelector(".dp-value")!.textContent = value ? formatDay(toDay(value)) : "";
    this.button.setAttribute("aria-label", `${this.label}: ${value ? formatDay(toDay(value)) : "not set"}`);
    if (this.isOpen()) this.render();
  }

  /** Sets the tooltip of the field. */
  setTitle(title: string): void {
    this.button.title = title;
  }

  private isOpen(): boolean {
    return this.button.getAttribute("aria-expanded") === "true";
  }

  private open(): void {
    this.cursor = this.clamp(toDay(this.value || this.max));
    this.view = "days";
    this.button.setAttribute("aria-expanded", "true");
    this.root.classList.add("is-open");
    this.render();
    this.focusCursor();
  }

  private close(returnFocus = true): void {
    this.button.setAttribute("aria-expanded", "false");
    this.root.classList.remove("is-open");
    if (returnFocus) this.button.focus();
  }

  private clamp(day: number): number {
    return Math.min(toDay(this.max), Math.max(toDay(this.min), day));
  }

  private render(): void {
    if (this.view === "months") this.renderMonths();
    else this.renderDays();
  }

  private renderDays(): void {
    const { year, month } = parts(this.cursor);
    const first = monthStart(year, month);
    const last = first + daysInMonth(year, month) - 1;
    const lead = weekdayMon(first);
    const [lo, hi] = [toDay(this.min), toDay(this.max)];
    const [rs, re] = this.range().map(toDay);
    const selected = this.value ? toDay(this.value) : NaN;

    const cells: string[] = [];
    for (let day = first - lead; day <= last || cells.length % 7; day++) {
      if (day < first || day > last) {
        cells.push(`<span class="dp-day is-outside" aria-hidden="true">${parts(day).date}</span>`);
        continue;
      }
      const cls = ["dp-day"];
      if (day > rs && day < re) cls.push("in-range");
      if (day === rs) cls.push("range-start");
      if (day === re) cls.push("range-end");
      cells.push(
        `<button type="button" class="${cls.join(" ")}" data-day="${day}" tabindex="${day === this.cursor ? 0 : -1}"
          aria-label="${formatDay(day)}" aria-pressed="${day === selected}"${day < lo || day > hi ? " disabled" : ""}>${day - first + 1}</button>`,
      );
    }

    this.pop.innerHTML = `
      <div class="dp-head">
        <button type="button" class="dp-nav" data-step="-1" aria-label="Previous month"${first <= lo ? " disabled" : ""}>${PREV}</button>
        <button type="button" class="dp-title" data-view="months" aria-label="${MONTHS_LONG[month]} ${year}, choose another month">${MONTHS_LONG[month]} ${year}</button>
        <button type="button" class="dp-nav" data-step="1" aria-label="Next month"${last >= hi ? " disabled" : ""}>${NEXT}</button>
      </div>
      <div class="dp-grid">
        ${WEEKDAYS.map((d) => `<span class="dp-wd" aria-hidden="true">${d}</span>`).join("")}
        ${cells.join("")}
      </div>`;
  }

  private renderMonths(): void {
    const [lo, hi] = [parts(toDay(this.min)), parts(toDay(this.max))];
    const current = parts(this.cursor);
    const months = MONTHS.map((name, m) => {
      const out = this.year * 12 + m < lo.year * 12 + lo.month || this.year * 12 + m > hi.year * 12 + hi.month;
      const here = this.year === current.year && m === current.month;
      return `<button type="button" class="dp-month" data-month="${m}" tabindex="${here ? 0 : -1}" aria-label="${MONTHS_LONG[m]} ${this.year}"
        aria-pressed="${here}"${out ? " disabled" : ""}>${name}</button>`;
    });
    this.pop.innerHTML = `
      <div class="dp-head">
        <button type="button" class="dp-nav" data-year="-1" aria-label="Previous year"${this.year <= lo.year ? " disabled" : ""}>${PREV}</button>
        <span class="dp-title is-static">${this.year}</span>
        <button type="button" class="dp-nav" data-year="1" aria-label="Next year"${this.year >= hi.year ? " disabled" : ""}>${NEXT}</button>
      </div>
      <div class="dp-months">${months.join("")}</div>`;
  }

  /** Moves the cursor to the first day of the month `step` months away, keeping it in bounds. */
  private shiftMonth(step: number): void {
    const { year, month } = parts(this.cursor);
    const target = monthStart(year, month + step);
    const p = parts(target);
    this.cursor = this.clamp(target + Math.min(parts(this.cursor).date, daysInMonth(p.year, p.month)) - 1);
  }

  private onClick(e: MouseEvent): void {
    const el = (e.target as Element).closest<HTMLButtonElement>("button");
    if (!el || el.disabled) return;
    if (el.dataset.day) return this.choose(+el.dataset.day);
    if (el.dataset.step) {
      this.shiftMonth(+el.dataset.step);
      this.render();
      const same = this.pop.querySelector<HTMLButtonElement>(`[data-step="${el.dataset.step}"]:not(:disabled)`);
      if (same) same.focus();
      else this.focusCursor();
      return;
    }
    if (el.dataset.view) {
      this.view = "months";
      this.year = parts(this.cursor).year;
      this.render();
      (this.pop.querySelector<HTMLButtonElement>(".dp-month[tabindex='0']:not(:disabled)") ??
        this.pop.querySelector<HTMLButtonElement>(".dp-month:not(:disabled)"))?.focus();
      return;
    }
    if (el.dataset.year) {
      this.year += +el.dataset.year;
      this.render();
      (this.pop.querySelector<HTMLButtonElement>(`[data-year="${el.dataset.year}"]:not(:disabled)`) ??
        this.pop.querySelector<HTMLButtonElement>(".dp-month:not(:disabled)"))?.focus();
      return;
    }
    if (el.dataset.month) {
      const date = parts(this.cursor).date;
      const m = +el.dataset.month;
      this.cursor = this.clamp(monthStart(this.year, m) + Math.min(date, daysInMonth(this.year, m)) - 1);
      this.view = "days";
      this.render();
      this.focusCursor();
    }
  }

  private onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      if (this.view === "months") {
        this.view = "days";
        this.render();
        this.focusCursor();
      } else this.close();
      return;
    }
    const target = e.target as HTMLElement;
    if (this.view === "days" && target.classList.contains("dp-day")) {
      const { year, month } = parts(this.cursor);
      const weekStart = this.cursor - weekdayMon(this.cursor);
      const moves: Record<string, number> = {
        ArrowLeft: this.cursor - 1,
        ArrowRight: this.cursor + 1,
        ArrowUp: this.cursor - 7,
        ArrowDown: this.cursor + 7,
        Home: weekStart,
        End: weekStart + 6,
      };
      if (e.key in moves) {
        e.preventDefault();
        this.cursor = this.clamp(moves[e.key]);
      } else if (e.key === "PageUp" || e.key === "PageDown") {
        e.preventDefault();
        this.shiftMonth(e.key === "PageUp" ? -1 : 1);
      } else return;
      const moved = parts(this.cursor);
      if (moved.year !== year || moved.month !== month) this.render();
      this.focusCursor();
    } else if (this.view === "months" && target.classList.contains("dp-month")) {
      const moves: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -3, ArrowDown: 3 };
      if (!(e.key in moves)) return;
      e.preventDefault();
      const next = this.pop.querySelector<HTMLButtonElement>(`.dp-month[data-month="${+target.dataset.month! + moves[e.key]}"]`);
      if (next && !next.disabled) next.focus();
    }
  }

  private focusCursor(): void {
    const btn = this.pop.querySelector<HTMLButtonElement>(`.dp-day[data-day="${this.cursor}"]`);
    if (!btn) return;
    this.pop.querySelectorAll<HTMLButtonElement>(".dp-day[tabindex='0']").forEach((b) => (b.tabIndex = -1));
    btn.tabIndex = 0;
    btn.focus({ preventScroll: true });
  }

  private choose(day: number): void {
    const next = fromDay(day);
    this.close();
    if (next === this.value) return;
    this.set(next);
    this.onChange(next);
  }
}
