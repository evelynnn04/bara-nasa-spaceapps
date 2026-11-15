import "./style.css";
import { AgreementView } from "./agreement-view";
import { AnalyticsView } from "./analytics-view";
import { AnomalyView } from "./anomaly-view";
import { Api, type FireEvent, type Meta } from "./api";
import { AreaPicker } from "./area-picker";
import { CalendarView } from "./calendar-view";
import { DatePicker } from "./date-picker";
import { formatRange, parts, toDay } from "./dates";
import { EventsView } from "./events-view";
import { downloadCsv, downloadPng, frame, place, slug, toCsv } from "./export";
import { UNIT, UNIT_SHORT, fmtCompact, fmtInt, fmtVal } from "./format";
import { initFx, pulse } from "./fx";
import { MapView } from "./map-view";
import { RAMPS, type RampName } from "./ramps";
import { SelectMenu } from "./select-menu";
import { RegionIndex, regionsFromBoundaries, unionBBox, type Boundaries } from "./regions";
import { initCards, measureInsets } from "./screen";
import { select, unobserved, type Selection } from "./store";
import type { DayNight, Filters, SelectionMode } from "./types";
import { readUrlState, writeUrlState, type ViewState } from "./url-state";

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

const DAYNIGHT_LABEL: Record<DayNight, string> = { all: "Day and night", day: "Daytime only", night: "Night-time only" };
const DATASET = "NASA FIRMS MODIS (Aqua) and VIIRS (S-NPP, NOAA-20, NOAA-21), harmonised";

const api = new Api();

initFx();
trackHeaderHeight();
Promise.all([loadBoundaries(), api.meta()]).then(([b, meta]) => boot(b, meta), (err: Error) => {
  $("#map-count").textContent = `Could not load the fire data (${err.message}). Check that the backend is running, then reload the page.`;
});

/** Keeps `--top-h` equal to the header height so sticky columns sit under it. */
function trackHeaderHeight(): void {
  const header = $("#top");
  new ResizeObserver(() => document.documentElement.style.setProperty("--top-h", `${header.offsetHeight}px`)).observe(header);
}

/** Fetches the country, province and city/regency outlines that the area list is built from. */
async function loadBoundaries(): Promise<Boundaries> {
  const res = await fetch(`${import.meta.env.BASE_URL}boundaries.geojson`);
  if (!res.ok) throw new Error(`boundaries: HTTP ${res.status}`);
  return res.json();
}

function boot(boundaries: Boundaries, meta: Meta): void {
  const regions = new RegionIndex(regionsFromBoundaries(boundaries).regions);
  const recordStart = meta.record.start;
  const recordEnd = meta.record.end;
  const defaults: ViewState = {
    filters: { mode: "area", regionIds: ["idn"], polygon: null, start: `${recordEnd.slice(0, 4)}-01-01`, end: recordEnd },
    ramp: "ember",
    daynight: "all",
  };
  const initial = readUrlState(defaults, (id) => regions.byId.has(id), recordStart, recordEnd);
  let filters: Filters = initial.filters;
  let ramp: RampName = initial.ramp;
  let daynight: DayNight = initial.daynight;
  const saveUrl = () => writeUrlState({ filters, ramp, daynight }, defaults);
  /** The selected area's daily record for the current filters; null while it loads or after it failed. */
  let sel: Selection | null = null;
  /** Map totals for the current filters; null while they load or after they failed. */
  let mapTotals: { total: number; cells: number } | null = null;
  let freshTimer = 0;
  let draw = { drawing: false, corners: 0 };
  let countText = "Loading fire data…";
  let generation = 0;
  let periodRequests: AbortController | null = null;

  /** Updates the polygon tools and the on-map instruction from the drawing state. */
  function syncDrawUi(): void {
    const { drawing, corners } = draw;
    const polygonMode = filters.mode === "polygon";
    const tip = corners < 3
      ? `Click the map to add corners (${corners} of at least 3)`
      : `${corners} corners. Click the first corner, double-click or press Enter to finish`;
    $("#draw-start").hidden = !polygonMode || drawing;
    $("#draw-start-label").textContent = filters.polygon ? "Redraw polygon" : "Draw polygon";
    $("#draw-tip").hidden = !drawing;
    $("#draw-tip").textContent = tip;
    $("#draw-finish").hidden = !drawing;
    $<HTMLButtonElement>("#draw-finish").disabled = corners < 3;
    $("#draw-cancel").hidden = !drawing;
    $("#draw-clear").hidden = !polygonMode || drawing || !filters.polygon;
    $("#map-count").textContent = countText;
  }

  const calendar = new CalendarView($("#calendar"));
  const analytics = new AnalyticsView({ summary: $("#an-summary"), peak: $("#an-peak"), patterns: $("#an-patterns") });
  const anomaly = new AnomalyView($("#anomaly"), $("#an-unusual"));
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
  map.setRamp(ramp);
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
  for (const el of [fromIn, toIn]) {
    el.setTitle(`The harmonised record covers ${recordStart.slice(0, 4)}–${recordEnd.slice(0, 4)}`);
    el.setBounds(recordStart, recordEnd);
  }

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
  function setNote(text: string, loadError = false): void {
    const note = $("#dl-note");
    note.textContent = text;
    if (loadError) note.dataset.loadError = "true";
    else delete note.dataset.loadError;
  }

  function syncControls(): void {
    document.querySelectorAll<HTMLButtonElement>(".hf-mode [data-mode]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === filters.mode)));
    document.querySelectorAll<HTMLButtonElement>("[data-dn]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.dn === daynight)));
    picker.setDisabled(filters.mode !== "area", "Drawn on map");
    fromIn.set(filters.start);
    toIn.set(filters.end);
  }

  function showError(what: string, err: Error): void {
    if (err.name === "AbortError") return;
    setNote(`Could not load ${what}: ${err.message}`, true);
  }

  function updateCount(): void {
    const parts: string[] = [];
    if (mapTotals) parts.push(`${fmtVal(mapTotals.total)} ${UNIT_SHORT} in ${fmtInt(mapTotals.cells)} cells`);
    parts.push(areaLabel(), formatRange(toDay(filters.start), toDay(filters.end)));
    if (daynight !== "all") parts.push(DAYNIGHT_LABEL[daynight]);
    if (sel) {
      const missing = unobserved(sel, sel.from, sel.to);
      if (missing) parts.push(`${missing} day${missing === 1 ? "" : "s"} not observed`);
    }
    countText = parts.join(" · ");
    syncDrawUi();
  }

  function update(patch: Partial<Filters>, opts: { fit?: boolean; datesChanged?: boolean } = {}): void {
    const datesChanged = opts.datesChanged || (patch.start && patch.start !== filters.start) || (patch.end && patch.end !== filters.end);
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
    mapTotals = null;
    if ($("#dl-note").dataset.loadError) setNote("");
    updateCount();

    const seriesCards = ["calendar", "an-summary", "an-peak", "an-patterns", "an-unusual", "anomaly"];
    setLoad(seriesCards, "busy");
    api.series(filters, daynight).then((s) => {
      if (!current()) return;
      sel = select(s, filters.start, filters.end);
      calendar.render(sel, ramp);
      analytics.render(sel, Boolean(datesChanged), ramp);
      anomaly.render(sel, Boolean(datesChanged));
      setLoad(seriesCards, "ready");
      updateCount();
    }, (err) => {
      if (!current()) return;
      setLoad(seriesCards, "stale");
      showError("the daily record", err);
    });

    setLoad(["agreement"], "busy");
    api.agreement(filters, daynight).then((a) => {
      if (!current()) return;
      agreement.render(a, meta.verdict, parts(toDay(filters.end)).year);
      setLoad(["agreement"], "ready");
    }, (err) => {
      if (!current()) return;
      setLoad(["agreement"], "stale");
      showError("the sensor comparison", err);
    });

    periodRequests?.abort();
    const ctl = (periodRequests = new AbortController());
    setLoad(["events"], "busy");
    api.cells(filters, daynight, ctl.signal).then((c) => {
      if (!current()) return;
      map.setCells(c);
      map.setCallout(c.top, c.top ? (regions.byId.get(c.top.region_id)?.name ?? "") : "");
      renderMapLegend();
      mapTotals = { total: c.total, cells: c.active_cells };
      updateCount();
    }, (err) => {
      if (!current()) return;
      map.setCells(null);
      map.setCallout(null, "");
      renderMapLegend();
      showError("the map cells", err);
    });
    api.events(filters, ctl.signal).then((r) => {
      if (!current()) return;
      events.render(r.events);
      setLoad(["events"], "ready");
    }, (err) => {
      if (!current()) return;
      setLoad(["events"], "stale");
      showError("the fire events", err);
    });
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
      update({}, { datesChanged: true });
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
    map.setRamp(ramp);
    renderMapLegend();
    if (!sel) return;
    calendar.render(sel, ramp);
    analytics.render(sel, false, ramp);
  });

  function renderMapLegend(): void {
    const steps = RAMPS[ramp].steps;
    const b = map.breaks;
    const used = steps.slice(steps.length - b.length);
    const first = b.length > 1 ? b[1] : 0;
    $("#map-legend").innerHTML = `<span class="legend-k">${UNIT_SHORT} per cell</span>
      <span class="legend-scale"><span class="legend-end">&lt;${fmtCompact(first)}</span><span class="legend-ramp">${used.map((c, i) => `<span class="sw" style="background:${c}" title="${i ? `${fmtVal(b[i])}+` : `under ${fmtVal(first)}`}"></span>`).join("")}</span><span class="legend-end">${fmtCompact(b[b.length - 1])}+</span></span>`;
  }

  function exportMeta(): [string, string][] {
    return [
      ["area", areaLabel()],
      ["from", filters.start],
      ["to", filters.end],
      ["detections", DAYNIGHT_LABEL[daynight]],
      ["unit", UNIT],
      ["dataset", DATASET],
      ["unobserved_days_in_range", sel ? String(unobserved(sel, sel.from, sel.to)) : ""],
    ];
  }

  document.addEventListener("click", async (e) => {
    const btn = (e.target as Element).closest<HTMLButtonElement>("[data-export]");
    if (!btn) return;
    if (!sel) {
      setNote("The daily record for these filters is not loaded yet, so there is nothing to save.");
      return;
    }
    const kind = btn.dataset.export as "calendar" | "analytics" | "anomaly";
    const format = btn.dataset.format as "csv" | "png";
    const name = `${kind}_${slug(areaLabel())}_${filters.start}_${filters.end}${daynight === "all" ? "" : `_${daynight}`}.${format}`;
    const subtitle = `${areaLabel()} · ${formatRange(sel.from, sel.to)} · ${DAYNIGHT_LABEL[daynight]} · ${UNIT}`;
    pulse(btn);
    try {
      if (format === "csv") {
        const meta = exportMeta();
        const view = kind === "calendar" ? calendar : kind === "analytics" ? analytics : anomaly;
        if (kind === "calendar") meta.push(["granularity", calendar.granularity]);
        const { header, rows } = view.csv();
        downloadCsv(name, toCsv(meta, header, rows));
      } else if (kind === "calendar") {
        const c = calendar.svg();
        const f = frame(`Burning activity calendar, ${calendar.granularity}`, subtitle, place(c.svg, 0, 0, c.width), c.width + 24, c.height);
        await downloadPng(name, f.svg, c.width + 24, f.height);
      } else {
        const v = (kind === "analytics" ? analytics : anomaly).svg(subtitle);
        await downloadPng(name, v.svg, v.width, v.height);
      }
      setNote(`Saved ${name}`);
    } catch (err) {
      setNote(`Could not save ${name}: ${(err as Error).message}`);
    }
  });

  $("#dl-detections").addEventListener("click", async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    pulse(btn);
    btn.disabled = true;
    setNote("Preparing the raw detections…");
    try {
      const r = await api.detections(filters, daynight);
      const url = URL.createObjectURL(r.blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = r.name;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNote(r.total > r.limit
        ? `Saved ${r.name}: the first ${fmtInt(r.limit)} of ${fmtInt(r.total)} detections. Pick a shorter period for all of them.`
        : `Saved ${r.name} (${fmtInt(r.total)} detections)`);
    } catch (err) {
      setNote(`Could not save the raw detections: ${(err as Error).message}`);
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
  $("#reset-view").addEventListener("click", () => {
    map.setEventBox(null);
    fitSelection();
  });
  initCards(fitSelection);
  window.addEventListener("resize", () => map.setInsets(measureInsets()));

  renderMapLegend();
  update({}, { fit: false });
  map.map.once("load", fitSelection);
}
