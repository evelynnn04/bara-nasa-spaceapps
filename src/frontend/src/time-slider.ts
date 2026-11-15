import { daysInMonth, fromDay, formatDay, monthStart, parts, toDay } from "./dates";
import { SelectMenu } from "./select-menu";
import { escapeXml, fmtInt } from "./format";
import { defaultInterval, timeFrames, type Frame, type Interval, type OutlookLabel } from "./timeline";

/** Most steps one animation can hold; each step is one request to the backend. */
export const MAX_ANIMATION_STEPS = 200;
/** Steps shown per second while playing. */
const FPS = 2;
/** Years between labels under the activity strip, so about seven labels fit. */
const YEAR_LABELS = 7;

const INTERVALS: { value: Interval; label: string }[] = [
  { value: "year", label: "Year" },
  { value: "month", label: "Month" },
  { value: "day", label: "Day" },
];

/** What each forecast label means, from the held-out evaluation in docs/fire-outlook.md. */
export const TRUST: Record<OutlookLabel, string> = {
  forecast: "Forecast: recent fire improves on the usual chance for this time of year.",
  "weak forecast": "Weak forecast: recent fire adds a little to the usual chance for this time of year.",
  seasonal: "Seasonal: the usual chance for this time of year, not a forecast of this period in particular.",
  baseline: "Baseline: each cell's share of past years with fire.",
};

/** Tooltip of a forecast step: that it is not observed data, and how far it can be trusted. */
export function forecastTip(f: Frame): string {
  return `${f.label}: forecast, not observed data. ${f.outlook ? TRUST[f.outlook] : ""}`.trim();
}

const svg = (path: string, fill = false) => `<svg class="ico${fill ? " ico-fill" : ""}" viewBox="0 0 24 24" aria-hidden="true"><path d="${path}" /></svg>`;
const ICON = {
  prev: svg("M15 4.5L7.5 12l7.5 7.5"),
  next: svg("M9 4.5l7.5 7.5L9 19.5"),
  play: svg("M8 5.5v13l10.5-6.5z", true),
  pause: svg("M9 6v12M15 6v12"),
  close: svg("M7 7l10 10M17 7L7 17"),
};

/** What the timeline needs from the page. */
export interface TimelineHost {
  /** Shows one step on the map, or the whole selected period for null; resolves once it is on the map. */
  show(frame: Frame | null): Promise<void>;
  /** Loads every step of an animation ahead of playback, reporting progress. */
  prepare(frames: Frame[], progress: (done: number) => void): Promise<void>;
  /** Dates under the brush while it is dragged; shown, not loaded. */
  preview(start: string, end: string): void;
  /** Dates the user settled on with the brush, or the selected dates cut to the end of the track. */
  pick(start: string, end: string): void;
  /** Last day the selected dates can reach: the end of the interval's forecast, or of the record without one. */
  setEnd(end: string): void;
  /** Interval the user picked from the menu. */
  pickInterval(interval: Interval): void;
}

/**
 * Thin timeline along the bottom of the map. A strip of monthly fire activity covers the whole record and runs on
 * over the forecast of the interval (30 days, 12 months or 5 years after the data), whose bars stand on a grey band
 * and are scaled by the cells with fire expected. The brush on it is the selected dates, which can reach to the end
 * of that forecast: drag its ends or its body to change them, in whole months. The play and step buttons walk the map through the selected dates one step at a time, observed steps
 * first, then forecast ones; clearing the step shows the whole observed part of the period.
 */
export class Timeline {
  private interval: Interval = "month";
  /** Interval the viewer picked from the menu; kept when the dates change, instead of the default for their length. */
  private picked: Interval | null = null;
  /** Observed steps of the selected dates, followed by their forecast steps. */
  private frames: Frame[] = [];
  /** Number of observed steps, before the forecast steps. */
  private past = 0;
  /** Monthly activity bars of the record, drawn before the forecast of the interval. */
  private pastBars = "";
  /** Cells with fire expected over the area per lead of each interval, lead 1 first; empty until loaded. */
  private expected: Partial<Record<Interval, number[]>> = {};
  /** Step on the map, or null while the map shows the whole selected period. */
  private current: number | null = null;
  private playing = false;
  private timer = 0;
  /** Steps whose loading for playback has started. */
  private prepared: Frame[] | null = null;
  /** Selected dates as day numbers. */
  private range: [number, number];
  private readonly recA: number;
  private readonly recB: number;
  /** Last day of the track: the end of the interval's forecast, or of the record without one. */
  private axB: number;
  /** Month number (year * 12 + month) of the record's first month, and the months the track spans. */
  private readonly m0: number;
  private months = 0;
  private readonly years: HTMLElement;

  private readonly track: HTMLElement;
  private readonly activity: SVGSVGElement;
  private readonly brush: HTMLElement;
  private readonly head: HTMLElement;
  private readonly prevBtn: HTMLButtonElement;
  private readonly nextBtn: HTMLButtonElement;
  private readonly playBtn: HTMLButtonElement;
  private readonly now: HTMLElement;
  private readonly nowLabel: HTMLElement;
  private readonly clearBtn: HTMLButtonElement;
  private readonly menu: SelectMenu;
  private readonly status: HTMLElement;

  /** `outlook` holds the forecast steps of each interval, which the track runs on into. */
  constructor(
    root: HTMLElement,
    private readonly host: TimelineHost,
    recordStart: string,
    recordEnd: string,
    private readonly outlook: Partial<Record<Interval, Frame[]>> = {},
  ) {
    this.recA = toDay(recordStart);
    this.recB = toDay(recordEnd);
    this.axB = this.recB;
    this.range = [this.recA, this.recB];
    const a = parts(this.recA);
    this.m0 = a.year * 12 + a.month;
    root.innerHTML = `
      <div class="tl-ctl">
        <button type="button" class="icon-btn tl-step" data-by="-1">${ICON.prev}</button>
        <button type="button" class="icon-btn tl-play">${ICON.play}</button>
        <button type="button" class="icon-btn tl-step" data-by="1">${ICON.next}</button>
      </div>
      <div class="tl-track">
        <svg class="tl-activity" preserveAspectRatio="none" aria-hidden="true"></svg>
        <div class="tl-years" aria-hidden="true"></div>
        <div class="tl-brush">
          <span class="tl-handle" data-end="a" role="slider" tabindex="0" aria-label="Start of the selected dates"></span>
          <span class="tl-handle" data-end="b" role="slider" tabindex="0" aria-label="End of the selected dates"></span>
        </div>
        <div class="tl-head" hidden aria-hidden="true" title="Drag to move through the steps"></div>
      </div>
      <p class="tl-now" hidden><span></span><button type="button" class="tl-clear" aria-label="Show the whole selected period" title="Show the whole selected period">${ICON.close}</button></p>
      <div class="tl-interval"></div>
      <p class="tl-status" role="status"></p>`;
    const $ = <T extends Element = HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
    this.track = $(".tl-track");
    this.activity = $<SVGSVGElement>(".tl-activity");
    this.years = $(".tl-years");
    this.brush = $(".tl-brush");
    this.head = $(".tl-head");
    [this.prevBtn, this.nextBtn] = root.querySelectorAll<HTMLButtonElement>(".tl-step");
    this.playBtn = $(".tl-play");
    this.now = $(".tl-now");
    this.nowLabel = $(".tl-now span");
    this.menu = new SelectMenu($(".tl-interval"), "Step", INTERVALS, this.interval, (value) => {
      this.picked = value as Interval;
      this.setInterval(this.picked);
      this.host.pickInterval(this.picked);
    });
    this.status = $(".tl-status");

    this.prevBtn.addEventListener("click", () => void this.go(this.current === null ? (this.past || this.frames.length) - 1 : this.current - 1));
    this.nextBtn.addEventListener("click", () => void this.go(this.current === null ? 0 : this.current + 1));
    this.playBtn.addEventListener("click", () => (this.playing ? this.pause() : this.play()));
    this.clearBtn = $<HTMLButtonElement>(".tl-clear");
    this.clearBtn.addEventListener("click", () => this.clear());
    this.bindTrack();
    this.setEnd(this.endOf(this.interval));
    this.sync();
  }

  /** Last day of an interval's forecast, or of the record without one. */
  private endOf(interval: Interval): number {
    const fc = this.outlook[interval] ?? [];
    return fc.length ? Math.max(this.recB, toDay(fc[fc.length - 1].to)) : this.recB;
  }

  /** Lays the track out from the record's start to `end`: its months, year marks and the date fields' limit. */
  private setEnd(end: number): void {
    this.axB = end;
    const a = parts(this.recA);
    const b = parts(end);
    this.months = b.year * 12 + b.month - this.m0 + 1;
    this.activity.setAttribute("viewBox", `0 0 ${this.months} 20`);
    const every = Math.ceil((b.year - a.year + 1) / YEAR_LABELS);
    let years = "";
    for (let y = a.year + 1; y <= b.year; y++) {
      const left = (this.frac(monthStart(y, 0)) * 100).toFixed(2);
      years += `<i style="left:${left}%">${(y - a.year) % every === 0 ? `<span>${y}</span>` : ""}</i>`;
    }
    this.years.innerHTML = years;
    this.host.setEnd(fromDay(end));
  }

  /** The cells with fire expected over the selected area per lead of each interval, which scale the forecast bars. */
  setExpected(expected: Partial<Record<Interval, number[]>>): void {
    this.expected = expected;
    this.drawStrip();
  }

  /**
   * New selected dates: moves the brush and rebuilds the steps, keeping the interval the viewer picked. A step on
   * the map that still falls in the new dates stays on the map; otherwise the map goes back to the whole period, or
   * to the first step when the dates hold only forecast.
   */
  setRange(start: string, end: string): void {
    this.pause();
    const keep = this.current === null ? null : this.frames[this.current];
    this.range = [toDay(start), toDay(end)];
    this.current = null;
    this.setFrames(this.picked ?? defaultInterval(start, end));
    let i = -1;
    if (keep?.lead) i = this.frames.findIndex((f) => f.lead === keep.lead);
    else if (keep && keep.to >= start && keep.from <= end) i = Math.max(0, this.frames.findIndex((f) => f.to >= keep.from));
    if (i < 0 && !this.past && this.frames.length) i = 0;
    if (i < 0) {
      if (!this.past) void this.host.show(null);
      return;
    }
    this.current = i;
    this.sync();
    void this.host.show(this.frames[i]);
  }

  /** Keeps this interval for every later range, as if the viewer had picked it (restored from the page URL). */
  usePicked(interval: Interval | null): void {
    this.picked = interval;
  }

  /** The area's daily record, drawn as monthly bars along the track. */
  setActivity(values: ArrayLike<number>, firstDay: number): void {
    const sums = new Array<number>(this.monthOf(this.recB) + 1).fill(0);
    for (let d = this.recA; d <= this.recB; d++) sums[this.monthOf(d)] += values[d - firstDay] ?? 0;
    const max = Math.max(...sums);
    const last = this.monthOf(this.recB);
    // Square-root heights keep quiet months visible next to the peak fire seasons; the last month ends with the record
    this.pastBars = max
      ? sums.map((v, i) => {
          if (v <= 0) return "";
          const w = i === last ? Math.min(0.8, this.x(this.recB + 1) - i - 0.1) : 0.8;
          return `<rect x="${i + 0.1}" y="${(20 - Math.max(1, Math.sqrt(v / max) * 20)).toFixed(1)}" width="${w.toFixed(3)}" height="20"/>`;
        }).join("")
      : "";
    this.drawStrip();
  }

  /**
   * Draws the activity bars and, after the record, the forecast of the interval on a grey band: one bar per month,
   * as tall as the cells with fire expected in it (square root of its share of the forecast's highest month), with
   * a tooltip saying it is a forecast. The forecast has its own scale, as its unit differs from the record's.
   */
  private drawStrip(): void {
    const future = this.outlook[this.interval] ?? [];
    const expected = this.expected[this.interval] ?? [];
    const rank: OutlookLabel[] = ["forecast", "weak forecast", "seasonal", "baseline"];
    let fc = "";
    if (future.length) {
      const first = this.recB + 1;
      const end = toDay(future[future.length - 1].to) + 1;
      fc += `<rect class="fc-band" x="${this.x(first).toFixed(3)}" y="0" width="${(this.x(end) - this.x(first)).toFixed(3)}" height="20"/>`;
      const slots: { m: number; a: number; b: number; inside: Frame[]; value: number }[] = [];
      for (let m = this.monthOf(first); m <= this.monthOf(end - 1); m++) {
        const y = Math.floor((this.m0 + m) / 12);
        const mo = (this.m0 + m) % 12;
        const a = Math.max(first, monthStart(y, mo));
        const b = Math.min(end - 1, monthStart(y, mo + 1) - 1);
        const inside = future.filter((f) => toDay(f.to) >= a && toDay(f.from) <= b);
        // A step counts in a month for the share of its days that fall in it
        const value = inside.reduce((sum, f) => {
          const days = Math.min(b, toDay(f.to)) - Math.max(a, toDay(f.from)) + 1;
          return sum + (expected[f.lead! - 1] ?? 0) * (days / (toDay(f.to) - toDay(f.from) + 1));
        }, 0);
        if (inside.length) slots.push({ m, a, b, inside, value });
      }
      const max = Math.max(0, ...slots.map((s) => s.value));
      for (const { m, a, b, inside, value } of slots) {
        const labels = [...new Set(inside.map((f) => f.outlook!))].sort((p, q) => rank.indexOf(p) - rank.indexOf(q));
        const span = inside.length > 1 ? `${inside[0].label} to ${inside[inside.length - 1].label}` : inside[0].label;
        const amount = expected.length ? ` About ${fmtInt(value)} cells with fire expected.` : "";
        const tip = `${span}: forecast, not observed data.${amount} ${labels.map((l) => TRUST[l]).join(" ")}`;
        const x0 = Math.max(this.x(a), m + 0.1);
        const x1 = Math.min(this.x(b + 1), m + 0.9);
        const h = max > 0 && value > 0 ? Math.max(1, Math.sqrt(value / max) * 20) : 0;
        fc += `<g class="fc"><title>${escapeXml(tip)}</title>
          <rect class="fc-hit" x="${this.x(a).toFixed(3)}" y="0" width="${(this.x(b + 1) - this.x(a)).toFixed(3)}" height="20"/>
          ${h ? `<rect x="${x0.toFixed(3)}" y="${(20 - h).toFixed(1)}" width="${Math.max(0.05, x1 - x0).toFixed(3)}" height="20"/>` : ""}</g>`;
      }
    }
    this.activity.innerHTML = this.pastBars + fc;
  }

  /** Position of the start of a day along the activity strip, in months from the track's first month. */
  private x(day: number): number {
    const p = parts(day);
    return p.year * 12 + p.month - this.m0 + (p.date - 1) / daysInMonth(p.year, p.month);
  }

  /** Whether the map shows one step instead of the whole selected period. */
  get active(): boolean {
    return this.current !== null;
  }

  private setInterval(interval: Interval): void {
    this.pause();
    const keep = this.current === null ? null : this.frames[this.current];
    this.setFrames(interval);
    if (keep === null) {
      // Dates holding only forecast have no whole period, so their first step goes on the map
      if (!this.past && this.frames.length) void this.go(0);
      return;
    }
    if (!this.frames.length) {
      void this.host.show(null);
      return;
    }
    // A forecast step on the map stays in the forecast, on the step holding its start or else the last one
    const first = keep.lead && this.frames.length > this.past ? this.past : 0;
    const i = this.frames.findIndex((f, k) => k >= first && f.to >= keep.from);
    this.current = i >= 0 ? i : keep.lead ? this.frames.length - 1 : 0;
    this.sync();
    void this.host.show(this.frames[this.current]);
  }

  /**
   * Steps of the selected dates: observed ones up to the record's end, then the forecast steps after it. The track
   * ends with the interval's forecast; selected dates running past it are cut to it and handed back to the page.
   */
  private setFrames(interval: Interval): void {
    this.interval = interval;
    const end = this.endOf(interval);
    if (end !== this.axB) this.setEnd(end);
    if (this.range[1] > end) {
      this.range = [Math.min(this.range[0], end), end];
      const [a, b] = this.range.map(fromDay);
      // After the current update, so the page is not asked to update while it is updating
      window.setTimeout(() => this.host.pick(a, b));
    }
    const [a, b] = this.range;
    const past = a <= this.recB ? timeFrames(fromDay(a), fromDay(Math.min(b, this.recB)), interval) : [];
    const future = (this.outlook[interval] ?? []).filter((f) => toDay(f.to) >= a && Math.max(toDay(f.from), this.recB + 1) <= b);
    this.frames = [...past, ...future];
    this.past = past.length;
    this.prepared = null;
    const all = this.outlook[interval] ?? [];
    this.status.textContent = this.frames.length || !all.length
      ? ""
      : `The ${interval} forecast runs from ${all[0].label} to ${all[all.length - 1].label}; pick earlier dates or a longer step.`;
    this.drawStrip();
    this.sync();
  }

  /** Shows a step on the map; moves by the user stop playback. */
  private go(index: number, fromPlayback = false): Promise<void> {
    if (!fromPlayback) this.pause();
    this.current = Math.max(0, Math.min(this.frames.length - 1, index));
    this.sync();
    return this.host.show(this.frames[this.current]);
  }

  /** Back to the whole selected period; dates holding only forecast have no whole period to show. */
  private clear(): void {
    if (!this.past) return;
    this.pause();
    this.current = null;
    this.sync();
    void this.host.show(null);
  }

  private play(): void {
    const count = this.frames.length;
    if (count > MAX_ANIMATION_STEPS) {
      this.status.textContent = `Playing holds up to ${MAX_ANIMATION_STEPS} steps; these dates have ${count}. Shorten them or pick a longer step.`;
      return;
    }
    this.playing = true;
    this.sync();
    const frames = this.frames;
    if (this.prepared !== frames) {
      // Playing starts at once while the remaining steps load; every step of an interval shares one colour scale
      this.prepared = frames;
      this.host
        .prepare(frames, (done) => {
          if (this.playing && frames === this.frames) this.status.textContent = done < count ? `Loaded ${done} of ${count} steps` : "";
        })
        .catch((err: Error) => {
          if (frames !== this.frames) return;
          this.prepared = null;
          if (err.name !== "AbortError") this.status.textContent = `Could not load every step: ${err.message}`;
        });
    }
    void this.tick(this.current === null || this.current === count - 1 ? 0 : this.current);
  }

  private async tick(i: number): Promise<void> {
    await this.go(i, true);
    if (!this.playing) return;
    this.timer = window.setTimeout(() => {
      if (this.playing) void this.tick(i < this.frames.length - 1 ? i + 1 : 0);
    }, 1000 / FPS);
  }

  private pause(): void {
    if (!this.playing) return;
    this.playing = false;
    clearTimeout(this.timer);
    this.status.textContent = "";
    this.sync();
  }

  /** Position of the start of a day along the track, from 0 to 1. */
  private frac(day: number): number {
    return (day - this.recA) / (this.axB - this.recA + 1);
  }

  /** Index of the month holding a day, counted from the record's first month. */
  private monthOf(day: number): number {
    const p = parts(day);
    return p.year * 12 + p.month - this.m0;
  }

  /** First and last day of a run of months, cut to the track. */
  private monthDays(first: number, last: number): [number, number] {
    const start = (i: number) => monthStart(Math.floor((this.m0 + i) / 12), (this.m0 + i) % 12);
    return [Math.max(this.recA, start(first)), Math.min(this.axB, start(last + 1) - 1)];
  }

  /** Index of the step under a pointer on the track, clamped to the first or last step. */
  private stepAt(clientX: number): number {
    const r = this.track.getBoundingClientRect();
    const date = fromDay(this.recA + Math.floor(((clientX - r.left) / r.width) * (this.axB - this.recA + 1)));
    const i = this.frames.findIndex((f) => f.to >= date);
    return i < 0 ? this.frames.length - 1 : i;
  }

  /**
   * Dragging an end of the brush resizes the dates, dragging its body moves them, and a press elsewhere centres
   * it there. While a step is on the map, dragging its playhead moves through the steps.
   */
  private bindTrack(): void {
    let mode: "a" | "b" | "move" | "head" | null = null;
    let first = 0;
    let last = 0;
    let grab = 0;
    let before: [number, number] = this.range;
    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
    const monthAt = (clientX: number) => {
      const r = this.track.getBoundingClientRect();
      return clamp(Math.floor(((clientX - r.left) / r.width) * this.months), 0, this.months - 1);
    };
    const preview = () => {
      this.range = this.monthDays(first, last);
      this.place();
      this.host.preview(fromDay(this.range[0]), fromDay(this.range[1]));
    };
    const commit = () => {
      if (this.range[0] !== before[0] || this.range[1] !== before[1]) this.host.pick(fromDay(this.range[0]), fromDay(this.range[1]));
    };
    const slide = (at: number) => {
      const len = last - first;
      first = clamp(at, 0, this.months - 1 - len);
      last = first + len;
    };

    this.track.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const t = e.target as Element;
      before = this.range;
      [first, last] = [this.monthOf(this.range[0]), this.monthOf(this.range[1])];
      const handle = t.closest<HTMLElement>(".tl-handle");
      mode = handle ? (handle.dataset.end as "a" | "b") : t.closest(".tl-head") ? "head" : "move";
      if (mode === "move" && !t.closest(".tl-brush")) {
        slide(monthAt(e.clientX) - Math.floor((last - first) / 2));
        preview();
      }
      grab = monthAt(e.clientX) - first;
      this.track.setPointerCapture(e.pointerId);
      this.track.classList.add("is-dragging");
    });
    this.track.addEventListener("pointermove", (e) => {
      if (!mode) return;
      if (mode === "head") {
        const i = this.stepAt(e.clientX);
        if (i !== this.current) void this.go(i);
        return;
      }
      const at = monthAt(e.clientX);
      if (mode === "a") first = Math.min(at, last);
      else if (mode === "b") last = Math.max(at, first);
      else slide(at - grab);
      preview();
    });
    const end = () => {
      if (!mode) return;
      mode = null;
      this.track.classList.remove("is-dragging");
      commit();
    };
    this.track.addEventListener("pointerup", end);
    this.track.addEventListener("pointercancel", end);
    this.track.addEventListener("keydown", (e) => {
      const handle = (e.target as Element).closest<HTMLElement>(".tl-handle");
      const by = e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : 0;
      if (!handle || !by) return;
      e.preventDefault();
      before = this.range;
      [first, last] = [this.monthOf(this.range[0]), this.monthOf(this.range[1])];
      if (handle.dataset.end === "a") first = clamp(first + by, 0, last);
      else last = clamp(last + by, first, this.months - 1);
      preview();
      commit();
    });
  }

  /** Puts the brush over the selected dates and the playhead over the step on the map. */
  private place(): void {
    const [a, b] = this.range;
    this.brush.style.left = `${this.frac(a) * 100}%`;
    this.brush.style.width = `${(this.frac(b + 1) - this.frac(a)) * 100}%`;
    this.brush.querySelectorAll<HTMLElement>(".tl-handle").forEach((h) => {
      const day = h.dataset.end === "a" ? a : b;
      h.setAttribute("aria-valuemin", String(this.recA));
      h.setAttribute("aria-valuemax", String(this.axB));
      h.setAttribute("aria-valuenow", String(day));
      h.setAttribute("aria-valuetext", formatDay(day));
    });
    const frame = this.current === null ? null : this.frames[this.current];
    this.head.hidden = !frame;
    if (frame) {
      this.head.style.left = `${this.frac(toDay(frame.from)) * 100}%`;
      this.head.style.width = `${(this.frac(toDay(frame.to) + 1) - this.frac(toDay(frame.from))) * 100}%`;
    }
  }

  private sync(): void {
    const n = this.frames.length;
    const frame = this.current === null ? null : this.frames[this.current];
    const unit = this.interval;
    this.place();
    this.menu.set(unit);
    this.playBtn.disabled = n < 2;
    this.prevBtn.disabled = n < 2 || this.current === 0;
    this.nextBtn.disabled = n < 2 || this.current === n - 1;
    this.playBtn.innerHTML = this.playing ? ICON.pause : ICON.play;
    const playLabel = this.playing ? "Pause" : `Play the map through the selected dates, one ${unit} at a time`;
    this.playBtn.setAttribute("aria-label", playLabel);
    this.playBtn.title = playLabel;
    for (const [btn, which] of [[this.prevBtn, "Previous"], [this.nextBtn, "Next"]] as const) {
      btn.setAttribute("aria-label", `${which} ${unit} on the map`);
      btn.title = `${which} ${unit}`;
    }
    this.now.hidden = !frame;
    this.now.classList.toggle("is-forecast", !!frame?.lead);
    this.nowLabel.textContent = frame ? (frame.lead ? `Forecast \u00b7 ${frame.label}` : frame.label) : "";
    if (frame?.lead) this.nowLabel.title = forecastTip(frame);
    else this.nowLabel.removeAttribute("title");
    this.nowLabel.removeAttribute("data-tip");
    this.clearBtn.hidden = !this.past;
  }
}
