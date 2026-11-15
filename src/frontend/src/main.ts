import "./style.css";
import { AgreementView } from "./agreement-view";
import { AnalyticsView } from "./analytics-view";
import { AnomalyView } from "./anomaly-view";
import { Api, type AgreementResponse, type CellsResponse, type FireEvent, type Meta } from "./api";
import { setChartPalette } from "./charts";
import { AreaPicker } from "./area-picker";
import { CalendarView } from "./calendar-view";
import { DatePicker } from "./date-picker";
import { formatDay, parts, toDay } from "./dates";
import { EventsView } from "./events-view";
import { downloadCsv, slug, toCsv } from "./export";
import { watchData } from "./freshness";
import { UNIT_SHORT, fmtCompact, fmtVal } from "./format";
import { initFx, pulse } from "./fx";
import { initTooltips } from "./tooltip";
import { MapView } from "./map-view";
import { RAMPS, accentVars, breaksFrom, type RampName } from "./ramps";
import { SelectMenu } from "./select-menu";
import { RegionIndex, loadBoundaries, regionsFromBoundaries, unionBBox, type Boundaries } from "./regions";
import { initCards, measureInsets } from "./screen";
import { select, type Selection } from "./store";
import { Timeline } from "./time-slider";
import { stepShare, type Frame, type Interval } from "./timeline";
import type { DayNight, Filters, Hotspots, SelectionMode } from "./types";
import { readUrlState, writeUrlState, type ViewState } from "./url-state";

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;


const api = new Api();

initFx();
initTooltips();
trackHeaderHeight();
Promise.all([loadBoundaries(), api.meta()]).then(([b, meta]) => boot(b, meta), (err: Error) => {
  $("#dl-note").textContent = `Could not load the fire data (${err.message}). Check that the backend is running, then reload the page.`;
});

/** Keeps `--top-h` equal to the header height so sticky columns sit under it. */
function trackHeaderHeight(): void {
  const header = $("#top");
  new ResizeObserver(() => document.documentElement.style.setProperty("--top-h", `${header.offsetHeight}px`)).observe(header);
}

function boot(boundaries: Boundaries, meta: Meta): void {
  const regions = new RegionIndex(regionsFromBoundaries(boundaries).regions);
  const recordStart = meta.record.start;
  const recordEnd = meta.record.end;
  const defaults: ViewState = {
    filters: { mode: "area", regionIds: ["idn"], polygon: null, start: `${recordEnd.slice(0, 4)}-01-01`, end: recordEnd },
    ramp: "ember",
    daynight: "all",
    hotspots: meta.default_hotspots ?? "vegetation",
    step: null,
  };
  const initial = readUrlState(defaults, (id) => regions.byId.has(id), recordStart, recordEnd);
  let filters: Filters = initial.filters;
  let ramp: RampName = initial.ramp;
  let daynight: DayNight = initial.daynight;
  let hotspots: Hotspots = initial.hotspots;
  let step: Interval | null = initial.step;
  const counting = () => ({ daynight, hotspots });
  const saveUrl = () => writeUrlState({ filters, ramp, daynight, hotspots, step }, defaults);
  /** The selected area's daily record for the current filters; null while it loads or after it failed. */
  let sel: Selection | null = null;
  /** The same record over all its dates, for the cards that do not follow the date picker. */
  let record: Selection | null = null;
  /** The latest sensor comparison, kept so a palette change can redraw it. */
  let lastAgreement: AgreementResponse | null = null;
  let freshTimer = 0;
  let draw = { drawing: false, corners: 0 };
  let generation = 0;
  let periodRequests: AbortController | null = null;
  /** Cells of the whole selected period, shown while the timeline is on all dates. */
  let fullCells: CellsResponse | null = null;
  /** Timeline step last asked for; a slower load for an earlier step is dropped. */
  let wantedFrame: Frame | null = null;
  /** Cells of timeline steps already asked for, for the current filters. */
  const stepCache = new Map<string, Promise<CellsResponse>>();
  /** Value quantiles of one step of each interval over the whole record, keyed by area, counting and interval. */
  const scaleCache = new Map<string, Promise<number[]>>();
  let timeRequests: AbortController | null = null;

  /** Updates the polygon tools from the drawing state; how to draw is in the Polygon button's tooltip. */
  function syncDrawUi(): void {
    const { drawing, corners } = draw;
    const polygonMode = filters.mode === "polygon";
    $("#draw-start").hidden = !polygonMode || drawing;
    $("#draw-start-label").textContent = filters.polygon ? "Redraw polygon" : "Draw polygon";
    $("#draw-finish").hidden = !drawing;
    $<HTMLButtonElement>("#draw-finish").disabled = corners < 3;
    $("#draw-cancel").hidden = !drawing;
    $("#draw-clear").hidden = !polygonMode || drawing || !filters.polygon;
  }

  const calendar = new CalendarView($("#calendar"));
  const analytics = new AnalyticsView($("#an-summary"));
  const anomaly = new AnomalyView($("#anomaly"), $("#an-patterns"));
  const agreement = new AgreementView($("#agreement"));
  const map = new MapView($("#map"), {
    onPolygon: (polygon) => update({ polygon }),
    onDrawState: (drawing, corners) => {
      draw = { drawing, corners };
      syncDrawUi();
    },
  });
  const events = new EventsView($("#events"), regions, (e: FireEvent) => {
    map.setInsets(measureInsets());
    map.setEventBox(e.bbox);
    map.fitBBox(e.bbox);
  });
  /** Carries the palette's accent through the page: CSS variables, chart lines and map outlines. */
  function applyPalette(): void {
    for (const [name, value] of Object.entries(accentVars(ramp))) document.documentElement.style.setProperty(name, value);
    setChartPalette(RAMPS[ramp]);
    map.setRamp(ramp);
  }
  applyPalette();
  if (import.meta.env.DEV) Object.assign(window, { __dash: { map, api } });
  const picker = new AreaPicker($("#area-picker"), regions, (regionIds) => update({ regionIds }, { fit: true }));
  picker.set(filters.regionIds);

  const onDate = (patch: Partial<Filters>) => {
    let [a, b] = [patch.start ?? filters.start, patch.end ?? filters.end];
    if (a > b) [a, b] = [b, a];
    update({ start: a, end: b });
  };
  const range = (): [string, string] => [filters.start, filters.end];
  const fromIn = new DatePicker($("#date-from"), "From", range, (start) => onDate({ start }));
  const toIn = new DatePicker($("#date-to"), "To", range, (end) => onDate({ end }));
  for (const el of [fromIn, toIn]) el.setBounds(recordStart, recordEnd);

  function areaLabel(): string {
    if (filters.mode === "polygon") return filters.polygon ? `Drawn polygon (${filters.polygon.length} corners)` : "All areas";
    return regions.label(filters.regionIds);
  }

  function setFresh(): void {
    document.body.classList.add("is-fresh");
    clearTimeout(freshTimer);
    freshTimer = window.setTimeout(() => document.body.classList.remove("is-fresh"), 1100);
  }

  /** Marks cards as loading, ready, or stale (their content is for earlier filters because loading failed). */
  function setLoad(ids: string[], state: "busy" | "ready" | "stale"): void {
    for (const id of ids) {
      const el = document.getElementById(id);
      if (!el) continue;
      el.setAttribute("aria-busy", String(state === "busy"));
      if (state === "stale") el.dataset.stale = "true";
      else delete el.dataset.stale;
    }
  }

  /** Writes the footer note; a load error is cleared again by the next filter change. */
  let noteTimer = 0;
  /**
   * Shows a status line under the download button. Confirmations fade out after a reading time
   * (5 s plus 60 ms per character, at most 12 s) that pauses while the pointer is over the note;
   * notes marked `error` (errors, and "Preparing…" while it is true) stay until the next note.
   * `loadError` marks a failed data load, cleared on the next update.
   */
  function setNote(text: string, opts: { error?: boolean; loadError?: boolean } = {}): void {
    const note = $("#dl-note");
    window.clearTimeout(noteTimer);
    note.classList.remove("is-fading");
    note.textContent = text;
    note.onmouseenter = null;
    note.onmouseleave = null;
    if (opts.loadError) note.dataset.loadError = "true";
    else delete note.dataset.loadError;
    if (!text || opts.error || opts.loadError) return;
    const hide = () => {
      note.classList.add("is-fading");
      noteTimer = window.setTimeout(() => {
        note.textContent = "";
        note.classList.remove("is-fading");
      }, 400);
    };
    const wait = Math.min(12000, 5000 + text.length * 60);
    noteTimer = window.setTimeout(hide, wait);
    note.onmouseenter = () => {
      window.clearTimeout(noteTimer);
      note.classList.remove("is-fading");
    };
    note.onmouseleave = () => {
      if (note.textContent) noteTimer = window.setTimeout(hide, 2000);
    };
  }

  function syncControls(): void {
    document.querySelectorAll<HTMLButtonElement>(".hf-mode [data-mode]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === filters.mode)));
    document.querySelectorAll<HTMLButtonElement>("[data-dn]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.dn === daynight)));
    document.querySelectorAll<HTMLButtonElement>("[data-ht]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.ht === hotspots)));
    picker.setDisabled(filters.mode !== "area", "Drawn on map");
    showDates(filters.start, filters.end);
    syncDrawUi();
  }

  /** Writes dates into the date fields. */
  function showDates(start: string, end: string): void {
    fromIn.set(start);
    toIn.set(end);
  }

  function showError(what: string, err: Error): void {
    if (err.name === "AbortError") return;
    setNote(`Could not load ${what}: ${err.message}`, { loadError: true });
  }

  function update(patch: Partial<Filters>, opts: { fit?: boolean } = {}): void {
    const areaChanged = ["mode", "regionIds", "polygon"].some((k) => k in patch);
    filters = { ...filters, ...patch };
    saveUrl();
    setFresh();
    syncControls();
    map.setOutlines(filters.mode === "area" ? regions.normalise(filters.regionIds) : []);
    map.setPolygon(filters.mode === "polygon" ? filters.polygon : null);
    map.setEventBox(null);
    if (opts.fit) fitSelection();
    const g = ++generation;
    const current = () => g === generation;
    sel = null;
    record = null;
    resetTimeline();
    if ($("#dl-note").dataset.loadError) setNote("");

    const seriesCards = ["calendar", "an-summary", "an-patterns", "anomaly"];
    setLoad(seriesCards, "busy");
    api.series(filters, counting()).then((s) => {
      if (!current()) return;
      sel = select(s, filters.start, filters.end);
      record = select(s, recordStart, recordEnd);
      timeline.setActivity(s.daily, s.firstDay);
      calendar.render(record, ramp);
      analytics.render(sel);
      anomaly.render(record, ramp, areaChanged);
      setLoad(seriesCards, "ready");
    }, (err) => {
      if (!current()) return;
      setLoad(seriesCards, "stale");
      showError("the daily record", err);
    });

    setLoad(["agreement"], "busy");
    api.agreement(filters, counting()).then((a) => {
      if (!current()) return;
      lastAgreement = a;
      agreement.render(a, meta.settings[hotspots], parts(toDay(filters.end)).year);
      setLoad(["agreement"], "ready");
    }, (err) => {
      if (!current()) return;
      setLoad(["agreement"], "stale");
      showError("the sensor comparison", err);
    });

    periodRequests?.abort();
    const ctl = (periodRequests = new AbortController());
    setLoad(["events"], "busy");
    // A shimmer covers the map until its cells arrive (or fail)
    $(".g-map").classList.add("is-loading");
    $("#map").setAttribute("aria-busy", "true");
    const loaded = () => {
      $(".g-map").classList.remove("is-loading");
      $("#map").setAttribute("aria-busy", "false");
    };
    api.cells(filters, counting(), ctl.signal).then((c) => {
      if (!current()) return;
      loaded();
      fullCells = c;
      if (!timeline.active) showCells(c);
    }, (err) => {
      if (!current()) return;
      loaded();
      map.setCells(null);
      map.setCallout(null, "");
      renderMapLegend();
      showError("the map cells", err);
    });
    api.events(filters, hotspots, ctl.signal, 3).then((r) => {
      if (!current()) return;
      events.render(r.events);
      setLoad(["events"], "ready");
    }, (err) => {
      if (!current()) return;
      setLoad(["events"], "stale");
      showError("the fire events", err);
    });
  }

  /** Puts cells on the map with their legend; a timeline step has no most-active-cell callout. */
  function showCells(c: CellsResponse, step: Frame | null = null, breaks?: number[]): void {
    map.setCells(c, breaks);
    map.setCallout(step ? null : c.top, c.top ? (regions.byId.get(c.top.region_id)?.name ?? "") : "");
    renderMapLegend();
  }

  /** Cells of one timeline step, loaded once per filters and kept for stepping back and forth. */
  function stepCells(f: Frame): Promise<CellsResponse> {
    const key = `${f.from}|${f.to}`;
    let hit = stepCache.get(key);
    if (!hit) {
      const ctl = (timeRequests ??= new AbortController());
      hit = api.cells({ ...filters, start: f.from, end: f.to }, counting(), ctl.signal);
      hit.catch(() => stepCache.delete(key));
      stepCache.set(key, hit);
      if (stepCache.size > 400) stepCache.delete(stepCache.keys().next().value!);
    }
    return hit;
  }

  /**
   * Quantiles of one step of an interval over the area's whole record, so a step gets the same colour scale and
   * legend whatever dates are selected. Resolves to null when they could not be loaded.
   */
  function stepQuantiles(interval: Interval): Promise<number[] | null> {
    const key = JSON.stringify([filters.mode, filters.regionIds, filters.polygon, daynight, hotspots, interval]);
    let hit = scaleCache.get(key);
    if (!hit) {
      hit = api.cellScale(filters, interval, counting()).then((r) => r.values);
      hit.catch(() => scaleCache.delete(key));
      scaleCache.set(key, hit);
      if (scaleCache.size > 60) scaleCache.delete(scaleCache.keys().next().value!);
    }
    return hit.catch(() => null);
  }

  const timeline = new Timeline($("#time-slider"), {
    async show(frame) {
      wantedFrame = frame;
      if (!frame) {
        if (fullCells) showCells(fullCells);
        return;
      }
      const g = generation;
      try {
        const [c, q] = await Promise.all([stepCells(frame), stepQuantiles(frame.interval)]);
        // Without the record's scale the step falls back to quantiles of its own cells
        const share = stepShare(frame);
        const breaks = q?.length ? breaksFrom(q.map((v) => v * share), RAMPS[ramp].steps.length) : undefined;
        if (g === generation && wantedFrame === frame) showCells(c, frame, breaks);
      } catch (err) {
        if (g !== generation || (err as Error).name === "AbortError") return;
        showError("the map timeline", err as Error);
      }
    },
    async prepare(list, progress) {
      let next = 0;
      let done = 0;
      const worker = async () => {
        while (next < list.length) {
          await stepCells(list[next++]);
          progress(++done);
        }
      };
      await Promise.all(Array.from({ length: 4 }, worker));
    },
    preview: showDates,
    pick: (start, end) => update({ start, end }),
    pickInterval: (interval) => {
      step = interval;
      saveUrl();
    },
  }, recordStart, recordEnd);
  timeline.usePicked(step);

  /** Drops the timeline steps loaded for earlier filters and lays the timeline over the new dates. */
  function resetTimeline(): void {
    timeRequests?.abort();
    timeRequests = null;
    stepCache.clear();
    fullCells = null;
    wantedFrame = null;
    timeline.setRange(filters.start, filters.end);
  }

  document.querySelectorAll<HTMLButtonElement>(".hf-mode [data-mode]").forEach((b) =>
    b.addEventListener("click", () => {
      const mode = b.dataset.mode as SelectionMode;
      if (mode === filters.mode) return;
      if (mode === "area") map.cancelDrawing();
      update({ mode }, { fit: mode === "area" });
      if (mode === "polygon") map.startDrawing();
    }),
  );
  document.querySelectorAll<HTMLButtonElement>("[data-dn]").forEach((b) =>
    b.addEventListener("click", () => {
      const dn = b.dataset.dn as DayNight;
      if (dn === daynight) return;
      daynight = dn;
      update({});
    }),
  );
  document.querySelectorAll<HTMLButtonElement>("[data-ht]").forEach((b) =>
    b.addEventListener("click", () => {
      const ht = b.dataset.ht as Hotspots;
      if (ht === hotspots) return;
      hotspots = ht;
      update({});
    }),
  );
  $("#draw-start").addEventListener("click", () => map.startDrawing());
  $("#draw-finish").addEventListener("click", () => map.finishDrawing());
  $("#draw-clear").addEventListener("click", () => map.clearPolygon());
  $("#draw-cancel").addEventListener("click", () => map.cancelDrawing());

  const strip = (name: RampName) =>
    `<span class="ramp-strip" aria-hidden="true">${RAMPS[name].steps.map((c) => `<span style="background:${c}"></span>`).join("")}</span>`;
  const paletteOptions = (Object.keys(RAMPS) as RampName[]).map((name) => ({ value: name, label: RAMPS[name].label, hint: RAMPS[name].hint, preview: strip(name) }));
  new SelectMenu($("#palette-menu"), "Palette", paletteOptions, ramp, (value) => {
    ramp = value as RampName;
    saveUrl();
    applyPalette();
    renderMapLegend();
    if (lastAgreement) agreement.render(lastAgreement, meta.settings[hotspots], parts(toDay(filters.end)).year);
    if (!record) return;
    calendar.render(record, ramp);
    anomaly.render(record, ramp, false);
  });

  function renderMapLegend(): void {
    const steps = RAMPS[ramp].steps;
    const b = map.breaks;
    const used = steps.slice(steps.length - b.length);
    const first = b.length > 1 ? b[1] : 0;
    $("#map-legend").innerHTML = `<span class="legend-k">${UNIT_SHORT} per cell</span>
      <span class="legend-scale"><span class="legend-end">&lt;${fmtCompact(first)}</span><span class="legend-ramp">${used.map((c, i) => `<span class="sw" style="background:${c}" title="${i ? `${fmtVal(b[i])}+` : `under ${fmtVal(first)}`}"></span>`).join("")}</span><span class="legend-end">${fmtCompact(b[b.length - 1])}+</span></span>`;
  }

  document.addEventListener("click", async (e) => {
    const btn = (e.target as Element).closest<HTMLButtonElement>("[data-export]");
    if (!btn) return;
    if (!sel || !record) {
      setNote("The daily record for these filters is not loaded yet, so there is nothing to save.", { error: true });
      return;
    }
    // The exportable cards (calendar, comparison) cover every year of the record.
    const kind = btn.dataset.export as "calendar" | "anomaly";
    const name = `${kind}_${slug(areaLabel())}_all-years${daynight === "all" ? "" : `_${daynight}`}${hotspots === "all" ? "_all-types" : ""}.csv`;
    pulse(btn);
    try {
      const { header, rows } = (kind === "calendar" ? calendar : anomaly).csv();
      downloadCsv(name, toCsv(header, rows));
      setNote(`Saved ${name}`);
    } catch (err) {
      setNote(`Could not save ${name}: ${(err as Error).message}`, { error: true });
    }
  });

  $("#dl-detections").addEventListener("click", async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    pulse(btn);
    btn.disabled = true;
    setNote("Preparing the raw detections…", { error: true });
    try {
      // The browser streams the file to disk itself; this first check only catches a refusal from the API
      await api.checkDetections(filters, counting());
      const a = document.createElement("a");
      a.href = api.detectionsUrl(filters, counting());
      a.download = "";
      document.body.append(a);
      a.click();
      a.remove();
      setNote("Downloading the raw detections. A long period takes a moment to start.");
    } catch (err) {
      setNote(`Could not save the raw detections: ${(err as Error).message}`, { error: true });
    } finally {
      btn.disabled = false;
    }
  });

  /** Frames the selected areas (or every area) between the floating cards. */
  function fitSelection(): void {
    const selected = filters.mode === "area" ? regions.normalise(filters.regionIds).map((id) => regions.byId.get(id)!) : [];
    const ring = filters.mode === "polygon" ? filters.polygon : null;
    map.setInsets(measureInsets());
    if (ring) {
      const xs = ring.map((p) => p[0]);
      const ys = ring.map((p) => p[1]);
      map.fitBBox([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
    } else map.fitBBox(unionBBox((selected.length ? selected : regions.roots).map((r) => r.bbox)));
  }

  map.addCornerControl($("#reset-view"));
  // "How the numbers work": the formulas and the MODIS-VIIRS agreement, in a dialog
  const help = $<HTMLDialogElement>("#help");
  map.addCornerControl($("#help-open"), "bottom-left");
  $("#help-open").addEventListener("click", () => help.showModal());
  $("#help-close").addEventListener("click", () => help.close());
  help.addEventListener("click", (e) => {
    if (e.target === help) help.close();
  });
  $("#reset-view").addEventListener("click", () => {
    map.setEventBox(null);
    fitSelection();
  });
  // A card opening or closing changes how much of the map is free; the next fit uses the new framing.
  initCards(() => map.setInsets(measureInsets()));
  window.addEventListener("resize", () => map.setInsets(measureInsets()));

  renderMapLegend();
  update({}, { fit: false });
  map.map.once("load", fitSelection);
  $("#data-notice-reload").addEventListener("click", () => location.reload());
  watchData(() => api.meta(), meta, (now) => {
    $("#data-notice-text").textContent = `Newer fire data has arrived, up to ${formatDay(toDay(now.record.end))}.`;
    $("#data-notice").hidden = false;
  });
}
