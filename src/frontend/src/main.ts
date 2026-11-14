import "./style.css";
import { AnalyticsView } from "./analytics-view";
import { AnomalyView } from "./anomaly-view";
import { AreaPicker } from "./area-picker";
import { CalendarView } from "./calendar-view";
import { DatePicker } from "./date-picker";
import { formatRange } from "./dates";
import { generateDummy } from "./dummy";
import { downloadCsv, downloadPng, frame, place, slug, toCsv } from "./export";
import { fmtInt } from "./format";
import { initFx, pulse } from "./fx";
import { FRP_BREAKS, MapView } from "./map-view";
import { RAMPS, type RampName } from "./ramps";
import { SelectMenu } from "./select-menu";
import { regionsFromBoundaries, unionBBox, type Boundaries } from "./regions";
import { initCards, measureInsets } from "./screen";
import { HotspotStore, hottestCell, type Selection } from "./store";
import type { Filters, SelectionMode } from "./types";
import { readUrlState, writeUrlState, type ViewState } from "./url-state";

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

const DEFAULTS: Filters = { mode: "area", regionIds: ["idn"], polygon: null, start: "2025-01-01", end: "2025-12-31" };

initFx();
trackHeaderHeight();
loadBoundaries().then(boot, (err: Error) => {
  $("#map-count").textContent = `Could not load the area boundaries (${err.message}). Reload the page to try again.`;
});

/** Keeps `--top-h` equal to the header height so sticky columns sit under it. */
function trackHeaderHeight(): void {
  const header = $("#top");
  new ResizeObserver(() => document.documentElement.style.setProperty("--top-h", `${header.offsetHeight}px`)).observe(header);
}

/** Fetches the real country, province and city/regency outlines that the area list and dummy data are built from. */
async function loadBoundaries(): Promise<Boundaries> {
  const res = await fetch(`${import.meta.env.BASE_URL}boundaries.geojson`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function boot(boundaries: Boundaries): void {
  const { regions: regionList, shapes } = regionsFromBoundaries(boundaries);
  const store = new HotspotStore(generateDummy(regionList, shapes));
  const regions = store.regions;
  const defaultView: ViewState = { filters: DEFAULTS, ramp: "ember" };
  const initial = readUrlState(defaultView, (id) => regions.byId.has(id), store.data.start, store.data.end);
  let filters: Filters = initial.filters;
  let ramp: RampName = initial.ramp;
  const saveUrl = () => writeUrlState({ filters, ramp }, defaultView);
  let sel: Selection;
  let freshTimer = 0;
  let draw = { drawing: false, corners: 0 };
  let countText = "";

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
  const map = new MapView($("#map"), {
    onPolygon: (polygon) => update({ polygon }),
    onDrawState: (drawing, corners) => {
      draw = { drawing, corners };
      syncDrawUi();
    },
  });
  map.setRamp(ramp);
  if (import.meta.env.DEV) Object.assign(window, { __dash: { map, store } });
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
    el.setTitle(`The record covers ${store.data.start.slice(0, 4)}–${store.data.end.slice(0, 4)}`);
    el.setBounds(store.data.start, store.data.end);
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

  function syncControls(): void {
    document.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === filters.mode)));
    picker.setDisabled(filters.mode !== "area", "Drawn on map");
    fromIn.set(filters.start);
    toIn.set(filters.end);
  }

  function update(patch: Partial<Filters>, opts: { fit?: boolean } = {}): void {
    const datesChanged = (patch.start && patch.start !== filters.start) || (patch.end && patch.end !== filters.end);
    filters = { ...filters, ...patch };
    saveUrl();
    setFresh();
    syncControls();
    syncDrawUi();
    sel = store.select(filters);

    map.setOutlines(filters.mode === "area" ? regions.normalise(filters.regionIds) : []);
    map.setPolygon(filters.mode === "polygon" ? filters.polygon : null);
    map.setHotspots(sel.items);
    if (opts.fit) fitSelection();
    const hot = hottestCell(sel.items);
    map.setCallout(hot, hot ? (store.regions.byId.get(hot.regionId)?.name ?? hot.regionId) : "");
    countText = `Map: ${fmtInt(sel.items.length)} detections, ${areaLabel()}, ${formatRange(sel.from, sel.to)}. Callout marks the highest intensity hotspot and its region.`;
    syncDrawUi();

    calendar.render(sel, ramp);
    analytics.render(sel, Boolean(datesChanged), ramp);
    anomaly.render(sel, Boolean(datesChanged));
    document.querySelectorAll("#g-main [aria-busy]").forEach((el) => el.setAttribute("aria-busy", "false"));
  }

  document.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((b) =>
    b.addEventListener("click", () => {
      const mode = b.dataset.mode as SelectionMode;
      if (mode === filters.mode) return;
      if (mode === "area") map.cancelDrawing();
      update({ mode }, { fit: mode === "area" });
      if (mode === "polygon") map.startDrawing();
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
    calendar.render(sel, ramp);
    analytics.render(sel, false, ramp);
  });

  function renderMapLegend(): void {
    const steps = RAMPS[ramp].steps;
    $("#map-legend").innerHTML = `<span class="legend-k">Fire radiative power (MW)</span>
      <span class="legend-ramp">${steps.map((c) => `<span class="sw" style="background:${c}"></span>`).join("")}</span>
      <span class="legend-ends"><span>${FRP_BREAKS[0]}</span><span>${FRP_BREAKS[FRP_BREAKS.length - 1]}+</span></span>`;
  }

  document.addEventListener("click", async (e) => {
    const btn = (e.target as Element).closest<HTMLButtonElement>("[data-export]");
    if (!btn) return;
    const kind = btn.dataset.export as "calendar" | "analytics" | "anomaly";
    const format = btn.dataset.format as "csv" | "png";
    const name = `${kind}_${slug(areaLabel())}_${filters.start}_${filters.end}.${format}`;
    const subtitle = `${areaLabel()} · ${formatRange(sel.from, sel.to)} · Dummy data`;
    pulse(btn);
    try {
      if (format === "csv") {
        const meta: [string, string][] = [
          ["area", areaLabel()],
          ["from", filters.start],
          ["to", filters.end],
          ["dataset", "dummy data"],
        ];
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
      $("#dl-note").textContent = `Saved ${name}`;
    } catch (err) {
      $("#dl-note").textContent = `Could not save ${name}: ${(err as Error).message}`;
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
  $("#reset-view").addEventListener("click", fitSelection);
  initCards(fitSelection);
  window.addEventListener("resize", () => map.setInsets(measureInsets()));

  renderMapLegend();
  update({}, { fit: false });
  map.map.once("load", fitSelection);
}
