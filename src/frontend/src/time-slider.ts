import { MONTHS, parts, toDay } from "./dates";
import { axisTicks, defaultInterval, frameAt, shiftDate, timeFrames, type Frame, type Interval } from "./timeline";

/** Most steps one animation can hold; each step is one request to the backend. */
export const MAX_ANIMATION_STEPS = 200;
/** Steps the animation range covers when it is set up, ending on the step under the marker. */
const DEFAULT_ANIMATION_STEPS = 10;
/** Smallest width of one day on the axis at each zoom level; the axis also never gets narrower than its box. */
const MIN_PX_PER_DAY: Record<Interval, number> = { year: 0.33, month: 3, day: 28 };
/** Pointer travel that turns a press on the axis into panning instead of picking a date. */
const PAN_THRESHOLD = 4;

const ZOOMS: Interval[] = ["year", "month", "day"];
const INTERVALS: { value: Interval; label: string }[] = [
  { value: "year", label: "Year" },
  { value: "month", label: "Month" },
  { value: "day", label: "Day" },
];

const svg = (path: string, fill = false) => `<svg class="ico${fill ? " ico-fill" : ""}" viewBox="0 0 24 24" aria-hidden="true"><path d="${path}" /></svg>`;
const ICON = {
  up: svg("M6 15l6-6 6 6z", true),
  down: svg("M6 9l6 6 6-6z", true),
  prev: svg("M15 4.5L7.5 12l7.5 7.5"),
  next: svg("M9 4.5l7.5 7.5L9 19.5"),
  latest: svg("M5 5.5L11.5 12 5 18.5M12 5.5l6.5 6.5-6.5 6.5"),
  camera: svg("M3.5 7h11.5v10H3.5zM15 10.5l5.5-3v9l-5.5-3z", true),
  collapse: svg("M12.5 6l-6 6 6 6M18.5 6l-6 6 6 6"),
  expand: svg("M5.5 6l6 6-6 6M11.5 6l6 6-6 6"),
  close: svg("M7 7l10 10M17 7L7 17"),
  play: svg("M8 5.5v13l10.5-6.5z", true),
  pause: svg("M9 6v12M15 6v12"),
  loop: svg("M5 12a6 6 0 0 1 10.2-4.3L17 9.5M17 5v4.5h-4.5M19 12a6 6 0 0 1-10.2 4.3L7 14.5M7 19v-4.5h4.5"),
};

/** What the timeline needs from the page: showing a step on the map and loading the steps of an animation. */
export interface TimelineHost {
  /** Shows one step on the map, or the whole selected period for null; resolves once it is on the map. */
  show(frame: Frame | null, scale?: number[]): Promise<void>;
  /** Loads every step of an animation, reporting progress, and returns one colour scale for all of them. */
  prepare(frames: Frame[], progress: (done: number) => void): Promise<number[]>;
}

/**
 * Year, month and day fields with an up arrow above and a down arrow below each, as one date. Fields finer than
 * the step are hidden; typing a value or pressing an arrow reports the new date, which the caller fits to the steps.
 */
class DateFields {
  private date = "";
  private shown: Interval = "day";
  private readonly inputs: Record<Interval, HTMLInputElement>;
  private readonly boxes: Record<Interval, HTMLElement>;

  constructor(root: HTMLElement, name: string, private readonly onPick: (date: string) => void) {
    const field = (unit: Interval, label: string, size: number) => `
      <span class="tl-field" data-unit="${unit}">
        <button type="button" class="tl-arrow" data-by="1" tabindex="-1" aria-label="Next ${label}">${ICON.up}</button>
        <input class="tl-input" data-unit="${unit}" size="${size}" spellcheck="false" autocomplete="off" aria-label="${name} ${label}" />
        <button type="button" class="tl-arrow" data-by="-1" tabindex="-1" aria-label="Previous ${label}">${ICON.down}</button>
      </span>`;
    root.innerHTML = field("year", "year", 4) + field("month", "month", 3) + field("day", "day", 2);
    const pick = <T extends HTMLElement>(sel: string, unit: Interval) => root.querySelector<T>(`${sel}[data-unit="${unit}"]`)!;
    this.inputs = { year: pick("input", "year"), month: pick("input", "month"), day: pick("input", "day") };
    this.boxes = { year: pick(".tl-field", "year"), month: pick(".tl-field", "month"), day: pick(".tl-field", "day") };
    for (const unit of ZOOMS) {
      this.boxes[unit].addEventListener("click", (e) => {
        const arrow = (e.target as Element).closest<HTMLButtonElement>(".tl-arrow");
        if (arrow) this.onPick(shiftDate(this.date, unit, +arrow.dataset.by!));
      });
      const input = this.inputs[unit];
      input.addEventListener("keydown", (e) => {
        if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          e.preventDefault();
          this.onPick(shiftDate(this.date, unit, e.key === "ArrowUp" ? 1 : -1));
        } else if (e.key === "Enter") input.blur();
      });
      input.addEventListener("change", () => {
        const typed = this.parse(unit, input.value.trim());
        if (typed) this.onPick(typed);
        else this.set(this.date, this.shown);
      });
      input.addEventListener("focus", () => input.select());
    }
  }

  /** Shows `date` with the fields the step needs. */
  set(date: string, interval: Interval): void {
    this.date = date;
    this.shown = interval;
    const p = parts(toDay(date));
    this.inputs.year.value = String(p.year);
    this.inputs.month.value = MONTHS[p.month].toUpperCase();
    this.inputs.day.value = String(p.date).padStart(2, "0");
    this.boxes.month.hidden = interval === "year";
    this.boxes.day.hidden = interval !== "day";
  }

  /** The current date with one field replaced by what was typed, or null when it is not a valid value. */
  private parse(unit: Interval, text: string): string | null {
    let { year, month, date } = parts(toDay(this.date));
    if (unit === "year") {
      if (!/^\d{4}$/.test(text)) return null;
      year = +text;
    } else if (unit === "month") {
      const byName = MONTHS.findIndex((m) => m.toLowerCase() === text.slice(0, 3).toLowerCase());
      month = byName >= 0 ? byName : /^\d{1,2}$/.test(text) ? +text - 1 : -1;
      if (month < 0 || month > 11) return null;
    } else {
      if (!/^\d{1,2}$/.test(text) || +text < 1) return null;
      date = +text;
    }
    const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    return `${year}-${String(month + 1).padStart(2, "0")}-${String(Math.min(date, last)).padStart(2, "0")}`;
  }
}

/**
 * Timeline for the map, laid out like a satellite imagery timeline: along the bottom of the map, a large date
 * selector, the step size over previous, next and latest arrows, an animation button, a zoomable axis over the
 * selected dates with a daily activity strip and a pick marking the date shown, a zoom control, and a button that
 * collapses it. Collapsed, the map shows the whole selected period; open, it shows the step under the pick.
 * Pressing the axis picks a date, dragging it pans, and the pick and the animation handles can be dragged.
 */
export class Timeline {
  private interval: Interval = "month";
  private zoom: Interval = "month";
  private frames: Frame[] = [];
  private current = 0;
  private animA = 0;
  private animB = 0;
  private open = false;
  private playing = false;
  private loop = true;
  private fps = 2;
  private timer = 0;
  /** Left edge of the axis window into the track, in pixels. */
  private scroll = 0;
  private daily: { values: ArrayLike<number>; firstDay: number; max: number } | null = null;
  /** Colour scale of the loaded animation range, kept for the steps inside it until the range changes. */
  private animScale: { a: number; b: number; scale: number[] } | null = null;
  private range: [string, string] = ["", ""];
  private redraw = 0;

  private readonly bar: HTMLElement;
  private readonly openBtn: HTMLButtonElement;
  private readonly date: DateFields;
  private readonly intervalBtn: HTMLButtonElement;
  private readonly menu: HTMLElement;
  private readonly prevBtn: HTMLButtonElement;
  private readonly nextBtn: HTMLButtonElement;
  private readonly latestBtn: HTMLButtonElement;
  private readonly animBtn: HTMLButtonElement;
  private readonly axis: HTMLElement;
  private readonly track: HTMLElement;
  private readonly activity: SVGSVGElement;
  private readonly grid: HTMLElement;
  private readonly span: HTMLElement;
  private readonly pick: HTMLElement;
  private readonly band: HTMLElement;
  private readonly zoomLabel: HTMLElement;
  private readonly zoomOut: HTMLButtonElement;
  private readonly zoomIn: HTMLButtonElement;
  private readonly panel: HTMLElement;
  private readonly panelTitle: HTMLElement;
  private readonly playBtn: HTMLButtonElement;
  private readonly loopBtn: HTMLButtonElement;
  private readonly speed: HTMLInputElement;
  private readonly speedLabel: HTMLElement;
  private readonly startDate: DateFields;
  private readonly endDate: DateFields;
  private readonly status: HTMLElement;

  constructor(private readonly root: HTMLElement, private readonly host: TimelineHost) {
    root.innerHTML = `
      <button type="button" class="pill tl-open" aria-label="Show timeline">Timeline${ICON.expand}</button>
      <div class="tl-panel" hidden role="dialog" aria-label="Animate the map">
        <div class="tl-panel-head">
          <p class="tl-panel-title"></p>
          <button type="button" class="icon-btn tl-panel-close" aria-label="Close animation">${ICON.close}</button>
        </div>
        <div class="tl-panel-row">
          <button type="button" class="icon-btn tl-play" aria-label="Play animation">${ICON.play}</button>
          <button type="button" class="icon-btn tl-loop" aria-pressed="true" aria-label="Loop" title="Loop">${ICON.loop}</button>
          <input type="range" class="tl-speed" min="1" max="10" step="1" value="2" aria-label="Frames per second" />
          <span class="tl-speed-label"></span>
        </div>
        <div class="tl-panel-row tl-panel-dates">
          <span class="tl-date tl-anim-start"></span><span class="tl-to">to</span><span class="tl-date tl-anim-end"></span>
        </div>
        <p class="tl-status" role="status"></p>
      </div>
      <div class="tl-bar" hidden>
        <div class="tl-datebox"><span class="tl-date tl-current"></span></div>
        <div class="tl-nav">
          <div class="tl-interval-wrap">
            <button type="button" class="tl-interval" aria-haspopup="menu" aria-expanded="false" title="Step size"></button>
            <div class="tl-menu" role="menu" hidden>
              ${INTERVALS.map((i) => `<button type="button" role="menuitemradio" data-interval="${i.value}">${i.label}</button>`).join("")}
            </div>
          </div>
          <div class="tl-arrows">
            <button type="button" class="tl-chev tl-step" data-by="-1">${ICON.prev}</button>
            <button type="button" class="tl-chev tl-step" data-by="1">${ICON.next}</button>
            <button type="button" class="tl-chev tl-latest" aria-label="Latest step" title="Latest step">${ICON.latest}</button>
          </div>
        </div>
        <button type="button" class="tl-animate" aria-expanded="false" aria-label="Set up animation" title="Set up animation">${ICON.camera}</button>
        <div class="tl-axis" role="slider" tabindex="0" aria-label="Date shown on the map">
          <div class="tl-track">
            <svg class="tl-activity" aria-hidden="true"></svg>
            <div class="tl-grid" aria-hidden="true"></div>
            <div class="tl-span" aria-hidden="true"></div>
            <div class="tl-band" aria-hidden="true"><span class="tl-handle" data-end="a"></span><span class="tl-handle" data-end="b"></span></div>
            <div class="tl-pick" aria-hidden="true"><span class="tl-pick-head"></span></div>
          </div>
        </div>
        <div class="tl-zoom">
          <span class="tl-zoom-label"></span>
          <button type="button" class="tl-arrow tl-zoom-out" aria-label="Zoom the axis out">${ICON.up}</button>
          <button type="button" class="tl-arrow tl-zoom-in" aria-label="Zoom the axis in">${ICON.down}</button>
        </div>
        <button type="button" class="tl-hide" aria-label="Hide timeline" title="Hide timeline">${ICON.collapse}</button>
      </div>`;
    const $ = <T extends Element = HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
    this.bar = $(".tl-bar");
    this.openBtn = $(".tl-open");
    this.intervalBtn = $(".tl-interval");
    this.menu = $(".tl-menu");
    [this.prevBtn, this.nextBtn] = root.querySelectorAll<HTMLButtonElement>(".tl-step");
    this.latestBtn = $(".tl-latest");
    this.animBtn = $(".tl-animate");
    this.axis = $(".tl-axis");
    this.track = $(".tl-track");
    this.activity = $<SVGSVGElement>(".tl-activity");
    this.grid = $(".tl-grid");
    this.span = $(".tl-span");
    this.pick = $(".tl-pick");
    this.band = $(".tl-band");
    this.zoomLabel = $(".tl-zoom-label");
    this.zoomOut = $(".tl-zoom-out");
    this.zoomIn = $(".tl-zoom-in");
    this.panel = $(".tl-panel");
    this.panelTitle = $(".tl-panel-title");
    this.playBtn = $(".tl-play");
    this.loopBtn = $(".tl-loop");
    this.speed = $(".tl-speed");
    this.speedLabel = $(".tl-speed-label");
    this.status = $(".tl-status");
    this.date = new DateFields($(".tl-current"), "Date", (d) => void this.go(frameAt(this.frames, d)));
    this.startDate = new DateFields($(".tl-anim-start"), "Animation start", (d) => this.setAnim(frameAt(this.frames, d), null));
    this.endDate = new DateFields($(".tl-anim-end"), "Animation end", (d) => this.setAnim(null, frameAt(this.frames, d)));

    this.openBtn.addEventListener("click", () => this.setOpen(true));
    $(".tl-hide").addEventListener("click", () => this.setOpen(false));
    this.prevBtn.addEventListener("click", () => void this.go(this.current - 1));
    this.nextBtn.addEventListener("click", () => void this.go(this.current + 1));
    this.latestBtn.addEventListener("click", () => void this.go(this.frames.length - 1));
    this.intervalBtn.addEventListener("click", () => this.toggleMenu(Boolean(this.menu.hidden)));
    this.menu.addEventListener("click", (e) => {
      const item = (e.target as Element).closest<HTMLButtonElement>("[data-interval]");
      if (!item) return;
      this.toggleMenu(false);
      this.setInterval(item.dataset.interval as Interval);
      this.intervalBtn.focus();
    });
    document.addEventListener("pointerdown", (e) => {
      if (!this.menu.hidden && !(e.target as Element).closest(".tl-interval-wrap")) this.toggleMenu(false);
    });
    this.zoomOut.addEventListener("click", () => this.setZoom(ZOOMS[ZOOMS.indexOf(this.zoom) - 1]));
    this.zoomIn.addEventListener("click", () => this.setZoom(ZOOMS[ZOOMS.indexOf(this.zoom) + 1]));
    this.animBtn.addEventListener("click", () => this.togglePanel(Boolean(this.panel.hidden)));
    $(".tl-panel-close").addEventListener("click", () => this.togglePanel(false));
    this.playBtn.addEventListener("click", () => (this.playing ? this.pause() : void this.play()));
    this.loopBtn.addEventListener("click", () => {
      this.loop = !this.loop;
      this.sync();
    });
    this.speed.addEventListener("input", () => {
      this.fps = +this.speed.value;
      this.sync();
    });
    this.root.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (!this.menu.hidden) this.toggleMenu(false);
      else if (!this.panel.hidden) this.togglePanel(false);
    });
    this.bindAxis();
    new ResizeObserver(() => this.layout()).observe(this.axis);
    this.sync();
  }

  /** New selected dates: picks the step for their length, puts the pick on the latest step and stops playback. */
  setRange(start: string, end: string): void {
    this.pause();
    this.range = [start, end];
    this.daily = null;
    this.applyInterval(defaultInterval(start, end), null);
    this.zoom = this.interval;
    this.layout(true);
    if (this.open) void this.host.show(this.frames[this.current]);
  }

  /** The area's daily record, drawn as the activity strip along the axis. */
  setActivity(values: ArrayLike<number>, firstDay: number): void {
    const [a, b] = this.dayRange();
    let max = 0;
    for (let d = a; d <= b; d++) max = Math.max(max, values[d - firstDay] ?? 0);
    this.daily = { values, firstDay, max };
    this.draw();
  }

  /** Whether the map follows the timeline (open) or shows the whole selected period (collapsed). */
  get active(): boolean {
    return this.open;
  }

  private setOpen(open: boolean): void {
    this.open = open;
    this.pause();
    if (!open) {
      this.togglePanel(false);
      this.toggleMenu(false);
    }
    this.sync();
    if (open) {
      this.layout(true);
      this.axis.focus();
      void this.host.show(this.frames[this.current]);
    } else {
      void this.host.show(null);
      this.openBtn.focus();
    }
  }

  private setInterval(interval: Interval): void {
    if (interval === this.interval) return;
    this.pause();
    this.applyInterval(interval, this.frames[this.current]?.from ?? null);
    this.zoom = interval;
    this.layout(true);
    void this.host.show(this.frames[this.current]);
  }

  private setZoom(zoom: Interval | undefined): void {
    if (!zoom || zoom === this.zoom) return;
    this.zoom = zoom;
    this.layout(true);
    this.sync();
  }

  /**
   * Rebuilds the steps for an interval, keeping the pick on the same date. The animation range goes back to the
   * ten steps ending at the pick, as a range kept in a finer step could hold far too many steps.
   */
  private applyInterval(interval: Interval, keep: string | null): void {
    const [start, end] = this.range;
    this.interval = interval;
    this.frames = timeFrames(start, end, interval);
    this.current = keep ? frameAt(this.frames, keep) : this.frames.length - 1;
    this.animA = Math.max(0, this.current - DEFAULT_ANIMATION_STEPS + 1);
    this.animB = this.current;
    this.animScale = null;
    this.status.textContent = "";
    this.sync();
  }

  /** Moves the pick to a step and shows it; moves by the user stop playback. */
  private go(index: number, fromPlayback = false): Promise<void> {
    if (!fromPlayback) this.pause();
    const i = Math.max(0, Math.min(this.frames.length - 1, index));
    if (i === this.current && !fromPlayback) return Promise.resolve();
    this.current = i;
    this.sync();
    this.reveal();
    const s = this.animScale && i >= this.animScale.a && i <= this.animScale.b ? this.animScale.scale : undefined;
    return this.host.show(this.frames[i], s);
  }

  /** Sets the animation start or end (null keeps it); a start past the end pushes the end along, and back. */
  private setAnim(a: number | null, b: number | null): void {
    this.pause();
    if (a !== null) {
      this.animA = a;
      this.animB = Math.max(this.animB, a);
    }
    if (b !== null) {
      this.animB = b;
      this.animA = Math.min(this.animA, b);
    }
    this.animScale = null;
    this.status.textContent = "";
    this.sync();
  }

  private async play(): Promise<void> {
    const count = this.animB - this.animA + 1;
    if (count > MAX_ANIMATION_STEPS) {
      this.status.textContent = `An animation holds up to ${MAX_ANIMATION_STEPS} steps; this range has ${count}. Shorten it or pick a longer step.`;
      return;
    }
    this.playing = true;
    this.sync();
    const [a, b] = [this.animA, this.animB];
    if (!this.animScale || this.animScale.a !== a || this.animScale.b !== b) {
      this.status.textContent = `Loading 0 of ${count}`;
      try {
        const scale = await this.host.prepare(this.frames.slice(a, b + 1), (done) => {
          this.status.textContent = `Loading ${done} of ${count}`;
        });
        if (!this.playing || a !== this.animA || b !== this.animB) return;
        this.animScale = { a, b, scale };
      } catch (err) {
        this.pause();
        if ((err as Error).name !== "AbortError") this.status.textContent = `Could not load the animation: ${(err as Error).message}`;
        return;
      }
    }
    this.status.textContent = "";
    void this.tick(this.current >= a && this.current < b ? this.current : a);
  }

  private async tick(i: number): Promise<void> {
    await this.go(i, true);
    if (!this.playing) return;
    this.timer = window.setTimeout(() => {
      if (!this.playing) return;
      if (i < this.animB) void this.tick(i + 1);
      else if (this.loop) void this.tick(this.animA);
      else this.pause();
    }, 1000 / this.fps);
  }

  private pause(): void {
    if (!this.playing) return;
    this.playing = false;
    clearTimeout(this.timer);
    this.sync();
  }

  private toggleMenu(show: boolean): void {
    this.menu.hidden = !show;
    this.intervalBtn.setAttribute("aria-expanded", String(show));
    if (show) this.menu.querySelector<HTMLButtonElement>(`[data-interval="${this.interval}"]`)?.focus();
  }

  private togglePanel(show: boolean): void {
    if (!show) this.pause();
    this.panel.hidden = !show;
    this.animBtn.setAttribute("aria-expanded", String(show));
    this.bar.classList.toggle("is-animating", show);
    // The panel opens above the camera button
    if (show) this.panel.style.left = `${Math.max(0, this.animBtn.offsetLeft + this.animBtn.offsetWidth / 2 - 40)}px`;
    this.sync();
    if (show) this.playBtn.focus();
  }

  /** First and last day of the selected dates, as day numbers. */
  private dayRange(): [number, number] {
    return this.frames.length ? [toDay(this.frames[0].from), toDay(this.frames[this.frames.length - 1].to)] : [0, 0];
  }

  /** Width of one day on the axis: the zoom level's width, or wider so the whole axis fills its box. */
  private pxPerDay(): number {
    const [a, b] = this.dayRange();
    return Math.max(MIN_PX_PER_DAY[this.zoom], (this.axis.clientWidth || 300) / (b - a + 1));
  }

  /** Position of the start of a day on the track. */
  private x(day: number): number {
    return (day - this.dayRange()[0]) * this.pxPerDay();
  }

  /** Day under a pointer on the axis. */
  private dayAt(clientX: number): number {
    const [a, b] = this.dayRange();
    const r = this.axis.getBoundingClientRect();
    return Math.max(a, Math.min(b, a + Math.floor((clientX - r.left + this.scroll) / this.pxPerDay())));
  }

  private stepAt(clientX: number): number {
    return frameAt(this.frames, new Date(this.dayAt(clientX) * 86_400_000).toISOString().slice(0, 10));
  }

  /** Sizes the track for the zoom; with `center`, scrolls so the pick sits in the middle of the axis. */
  private layout(center = false): void {
    if (!this.open || !this.frames.length) return;
    const [a, b] = this.dayRange();
    this.track.style.width = `${(b - a + 1) * this.pxPerDay()}px`;
    if (center) {
      const f = this.frames[this.current];
      const mid = (this.x(toDay(f.from)) + this.x(toDay(f.to) + 1)) / 2;
      this.scrollTo(mid - this.axis.clientWidth / 2);
    } else this.scrollTo(this.scroll);
    this.sync();
  }

  /** Scrolls the axis, keeping the track inside its box. */
  private scrollTo(px: number): void {
    const [a, b] = this.dayRange();
    const max = Math.max(0, (b - a + 1) * this.pxPerDay() - this.axis.clientWidth);
    this.scroll = Math.max(0, Math.min(max, px));
    this.track.style.transform = `translateX(${-this.scroll}px)`;
    this.draw();
  }

  /** Scrolls just enough to bring the pick back into view. */
  private reveal(): void {
    const f = this.frames[this.current];
    const mid = (this.x(toDay(f.from)) + this.x(toDay(f.to) + 1)) / 2;
    const w = this.axis.clientWidth;
    if (mid < this.scroll + 40 || mid > this.scroll + w - 40) this.scrollTo(mid - w / 2);
  }

  private bindAxis(): void {
    let mode: "pick" | "a" | "b" | "press" | "pan" | null = null;
    let startX = 0;
    let startScroll = 0;
    this.axis.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const t = e.target as Element;
      const handle = t.closest<HTMLElement>(".tl-handle");
      mode = handle ? (handle.dataset.end as "a" | "b") : t.closest(".tl-pick") ? "pick" : "press";
      startX = e.clientX;
      startScroll = this.scroll;
      this.axis.setPointerCapture(e.pointerId);
      this.axis.focus();
      this.axis.classList.toggle("is-dragging", mode !== "press");
    });
    this.axis.addEventListener("pointermove", (e) => {
      if (!mode) return;
      if (mode === "press" && Math.abs(e.clientX - startX) > PAN_THRESHOLD) {
        mode = "pan";
        this.axis.classList.add("is-panning");
      }
      if (mode === "pan") this.scrollTo(startScroll - (e.clientX - startX));
      else if (mode === "pick") void this.go(this.stepAt(e.clientX));
      else if (mode === "a") this.setAnim(this.stepAt(e.clientX), null);
      else if (mode === "b") this.setAnim(null, this.stepAt(e.clientX));
    });
    const end = (e: PointerEvent) => {
      if (mode === "press") void this.go(this.stepAt(e.clientX));
      mode = null;
      this.axis.classList.remove("is-dragging", "is-panning");
    };
    this.axis.addEventListener("pointerup", end);
    this.axis.addEventListener("pointercancel", () => {
      mode = null;
      this.axis.classList.remove("is-dragging", "is-panning");
    });
    this.axis.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        this.scrollTo(this.scroll + (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY));
      },
      { passive: false },
    );
    this.axis.addEventListener("keydown", (e) => {
      const by: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowDown: -1, ArrowUp: 1, PageDown: -10, PageUp: 10 };
      if (e.key in by) void this.go(this.current + by[e.key]);
      else if (e.key === "Home") void this.go(0);
      else if (e.key === "End") void this.go(this.frames.length - 1);
      else return;
      e.preventDefault();
    });
  }

  /** Draws the ticks, labels and activity bars of the days around the visible part of the axis. */
  private draw(): void {
    cancelAnimationFrame(this.redraw);
    this.redraw = requestAnimationFrame(() => {
      if (!this.open || !this.frames.length) return;
      const [a, b] = this.dayRange();
      const ppd = this.pxPerDay();
      const w = this.axis.clientWidth;
      const from = Math.max(a, a + Math.floor((this.scroll - w) / ppd));
      const to = Math.min(b, a + Math.ceil((this.scroll + 2 * w) / ppd));
      this.grid.innerHTML = axisTicks(from, to, this.zoom, ppd)
        .map((t) => {
          const label = t.strong ? `<span><b>${t.strong}</b>${t.rest ? ` ${t.rest}` : ""}</span>` : "";
          return `<i class="tl-line${t.major ? " is-major" : ""}${t.rest ? " is-labelled" : ""}" style="left:${(t.day - a) * ppd}px">${label}</i>`;
        })
        .join("");
      const daily = this.daily;
      if (!daily || !daily.max) {
        this.activity.innerHTML = "";
        return;
      }
      const bw = Math.max(1, ppd * 0.7);
      let bars = "";
      for (let d = from; d <= to; d++) {
        const v = daily.values[d - daily.firstDay] ?? 0;
        if (v <= 0) continue;
        const h = Math.max(1.5, (v / daily.max) * 16);
        bars += `<rect x="${((d - a) * ppd + (ppd - bw) / 2).toFixed(1)}" y="${(18 - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}"/>`;
      }
      this.activity.innerHTML = bars;
    });
  }

  private sync(): void {
    const n = this.frames.length;
    const frame = this.frames[this.current];
    this.root.hidden = n < 2;
    this.bar.hidden = !this.open;
    this.openBtn.hidden = this.open;
    document.body.classList.toggle("has-timeline", this.open && n >= 2);
    if (!frame) return;

    this.date.set(frame.from, this.interval);
    const unit = this.interval.toUpperCase();
    this.intervalBtn.innerHTML = `<span class="tl-interval-n">1</span> ${unit}`;
    this.intervalBtn.setAttribute("aria-label", `Step size: 1 ${this.interval}. Change`);
    this.menu.querySelectorAll<HTMLButtonElement>("[data-interval]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.interval === this.interval)));
    this.prevBtn.disabled = this.current === 0;
    this.nextBtn.disabled = this.current === n - 1;
    this.latestBtn.disabled = this.current === n - 1;
    this.prevBtn.setAttribute("aria-label", `Previous ${this.interval}`);
    this.nextBtn.setAttribute("aria-label", `Next ${this.interval}`);
    this.prevBtn.title = `Previous ${this.interval}`;
    this.nextBtn.title = `Next ${this.interval}`;
    this.zoomLabel.textContent = this.zoom.toUpperCase();
    this.zoomOut.disabled = this.zoom === "year";
    this.zoomIn.disabled = this.zoom === "day";

    this.axis.setAttribute("aria-valuemin", "0");
    this.axis.setAttribute("aria-valuemax", String(n - 1));
    this.axis.setAttribute("aria-valuenow", String(this.current));
    this.axis.setAttribute("aria-valuetext", frame.label);
    const left = this.x(toDay(frame.from));
    const right = this.x(toDay(frame.to) + 1);
    this.span.style.left = `${left}px`;
    this.span.style.width = `${right - left}px`;
    this.pick.style.left = `${(left + right) / 2}px`;
    const bandLeft = this.x(toDay(this.frames[this.animA].from));
    this.band.style.left = `${bandLeft}px`;
    this.band.style.width = `${this.x(toDay(this.frames[this.animB].to) + 1) - bandLeft}px`;

    this.panelTitle.innerHTML = `Animate map in <strong>1 ${unit}</strong> steps`;
    this.startDate.set(this.frames[this.animA].from, this.interval);
    this.endDate.set(this.frames[this.animB].from, this.interval);
    this.playBtn.innerHTML = this.playing ? ICON.pause : ICON.play;
    this.playBtn.setAttribute("aria-label", this.playing ? "Pause animation" : "Play animation");
    this.loopBtn.setAttribute("aria-pressed", String(this.loop));
    this.speedLabel.textContent = `${this.fps} frame${this.fps === 1 ? "" : "s"} per second`;
  }
}
