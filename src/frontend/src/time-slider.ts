import { fromDay, formatDay, monthStart, parts, toDay } from "./dates";
import { SelectMenu } from "./select-menu";
import { defaultInterval, timeFrames, type Frame, type Interval } from "./timeline";

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
  show(frame: Frame | null, scale?: number[]): Promise<void>;
  /** Loads every step of an animation, reporting progress, and returns one colour scale for all of them. */
  prepare(frames: Frame[], progress: (done: number) => void): Promise<number[]>;
  /** Dates under the brush while it is dragged; shown, not loaded. */
  preview(start: string, end: string): void;
  /** Dates the user settled on with the brush. */
  pick(start: string, end: string): void;
}

/**
 * Thin timeline along the bottom of the map. A strip of monthly fire activity covers the whole record, and the
 * brush on it is the selected dates: drag its ends or its body to change them, in whole months. The play and step
 * buttons walk the map through the selected dates one step at a time; clearing the step shows the whole period.
 */
export class Timeline {
  private interval: Interval = "month";
  private frames: Frame[] = [];
  /** Step on the map, or null while the map shows the whole selected period. */
  private current: number | null = null;
  private playing = false;
  private timer = 0;
  /** Colour scale shared by all steps, once an animation has loaded them. */
  private scale: number[] | null = null;
  /** Selected dates as day numbers. */
  private range: [number, number];
  private readonly recA: number;
  private readonly recB: number;
  /** Month number (year * 12 + month) of the record's first month, and the months the record spans. */
  private readonly m0: number;
  private readonly months: number;

  private readonly track: HTMLElement;
  private readonly activity: SVGSVGElement;
  private readonly brush: HTMLElement;
  private readonly head: HTMLElement;
  private readonly prevBtn: HTMLButtonElement;
  private readonly nextBtn: HTMLButtonElement;
  private readonly playBtn: HTMLButtonElement;
  private readonly now: HTMLElement;
  private readonly nowLabel: HTMLElement;
  private readonly menu: SelectMenu;
  private readonly status: HTMLElement;

  constructor(root: HTMLElement, private readonly host: TimelineHost, recordStart: string, recordEnd: string) {
    this.recA = toDay(recordStart);
    this.recB = toDay(recordEnd);
    this.range = [this.recA, this.recB];
    const a = parts(this.recA);
    const b = parts(this.recB);
    this.m0 = a.year * 12 + a.month;
    this.months = b.year * 12 + b.month - this.m0 + 1;
    const every = Math.ceil((b.year - a.year + 1) / YEAR_LABELS);
    let years = "";
    for (let y = a.year + 1; y <= b.year; y++) {
      const left = (this.frac(monthStart(y, 0)) * 100).toFixed(2);
      years += `<i style="left:${left}%">${(y - a.year) % every === 0 ? `<span>${y}</span>` : ""}</i>`;
    }
    root.innerHTML = `
      <div class="tl-ctl">
        <button type="button" class="icon-btn tl-step" data-by="-1">${ICON.prev}</button>
        <button type="button" class="icon-btn tl-play">${ICON.play}</button>
        <button type="button" class="icon-btn tl-step" data-by="1">${ICON.next}</button>
      </div>
      <div class="tl-track">
        <svg class="tl-activity" viewBox="0 0 ${this.months} 20" preserveAspectRatio="none" aria-hidden="true"></svg>
        <div class="tl-years" aria-hidden="true">${years}</div>
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
    this.brush = $(".tl-brush");
    this.head = $(".tl-head");
    [this.prevBtn, this.nextBtn] = root.querySelectorAll<HTMLButtonElement>(".tl-step");
    this.playBtn = $(".tl-play");
    this.now = $(".tl-now");
    this.nowLabel = $(".tl-now span");
    this.menu = new SelectMenu($(".tl-interval"), "Step", INTERVALS, this.interval, (value) => this.setInterval(value as Interval));
    this.status = $(".tl-status");

    this.prevBtn.addEventListener("click", () => void this.go(this.current === null ? this.frames.length - 1 : this.current - 1));
    this.nextBtn.addEventListener("click", () => void this.go(this.current === null ? 0 : this.current + 1));
    this.playBtn.addEventListener("click", () => (this.playing ? this.pause() : this.play()));
    $(".tl-clear").addEventListener("click", () => this.clear());
    this.bindTrack();
    this.sync();
  }

  /** New selected dates: moves the brush, rebuilds the steps and goes back to the whole period. */
  setRange(start: string, end: string): void {
    this.pause();
    this.range = [toDay(start), toDay(end)];
    this.current = null;
    this.setFrames(defaultInterval(start, end));
  }

  /** The area's daily record, drawn as monthly bars along the track. */
  setActivity(values: ArrayLike<number>, firstDay: number): void {
    const sums = new Array<number>(this.months).fill(0);
    for (let d = this.recA; d <= this.recB; d++) sums[this.monthOf(d)] += values[d - firstDay] ?? 0;
    const max = Math.max(...sums);
    // Square-root heights keep quiet months visible next to the peak fire seasons
    this.activity.innerHTML = max
      ? sums.map((v, i) => (v > 0 ? `<rect x="${i + 0.1}" y="${(20 - Math.max(1, Math.sqrt(v / max) * 20)).toFixed(1)}" width="0.8" height="20"/>` : "")).join("")
      : "";
  }

  /** Whether the map shows one step instead of the whole selected period. */
  get active(): boolean {
    return this.current !== null;
  }

  private setInterval(interval: Interval): void {
    this.pause();
    const keep = this.current === null ? null : this.frames[this.current].from;
    this.setFrames(interval);
    if (keep === null) return;
    this.current = Math.max(0, this.frames.findIndex((f) => f.to >= keep));
    this.sync();
    void this.host.show(this.frames[this.current]);
  }

  private setFrames(interval: Interval): void {
    this.interval = interval;
    this.frames = timeFrames(fromDay(this.range[0]), fromDay(this.range[1]), interval);
    this.scale = null;
    this.status.textContent = "";
    this.sync();
  }

  /** Shows a step on the map; moves by the user stop playback. */
  private go(index: number, fromPlayback = false): Promise<void> {
    if (!fromPlayback) this.pause();
    this.current = Math.max(0, Math.min(this.frames.length - 1, index));
    this.sync();
    return this.host.show(this.frames[this.current], this.scale ?? undefined);
  }

  /** Back to the whole selected period. */
  private clear(): void {
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
    if (!this.scale) {
      // Playing starts at once, each step on its own colour scale; the remaining steps load meanwhile, and
      // once all are in they share one scale so the steps compare like with like
      this.host
        .prepare(frames, (done) => {
          if (this.playing && frames === this.frames) this.status.textContent = done < count ? `Loaded ${done} of ${count} steps` : "";
        })
        .then(
          (scale) => {
            if (frames === this.frames) this.scale = scale;
          },
          (err: Error) => {
            if (err.name !== "AbortError" && frames === this.frames) this.status.textContent = `Could not load every step: ${err.message}`;
          },
        );
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
    return (day - this.recA) / (this.recB - this.recA + 1);
  }

  /** Index of the month holding a day, counted from the record's first month. */
  private monthOf(day: number): number {
    const p = parts(day);
    return p.year * 12 + p.month - this.m0;
  }

  /** First and last day of a run of months, cut to the record. */
  private monthDays(first: number, last: number): [number, number] {
    const start = (i: number) => monthStart(Math.floor((this.m0 + i) / 12), (this.m0 + i) % 12);
    return [Math.max(this.recA, start(first)), Math.min(this.recB, start(last + 1) - 1)];
  }

  /** Index of the step under a pointer on the track, clamped to the first or last step. */
  private stepAt(clientX: number): number {
    const r = this.track.getBoundingClientRect();
    const date = fromDay(this.recA + Math.floor(((clientX - r.left) / r.width) * (this.recB - this.recA + 1)));
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
      h.setAttribute("aria-valuemax", String(this.recB));
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
    this.nowLabel.textContent = frame ? frame.label : "";
  }
}
