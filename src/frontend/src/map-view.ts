import { AttributionControl, GeoJSONSource, LngLatBounds, Map as MLMap, Marker, NavigationControl, Popup, setWorkerUrl, type ExpressionSpecification, type FilterSpecification, type MapMouseEvent, type StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import type { CellsResponse, OutlookCells } from "./api";
import { CHANCE_BREAKS, RAMPS, quantileBreaks, type RampName } from "./ramps";
import { UNIT_SHORT, escapeXml, fmtChance, fmtInt, fmtVal } from "./format";
import type { BBox, LngLat } from "./types";

/** Map chrome colours. Keep in step with the tokens in style.css. */
const MAP = {
  background: "#0b0706",
  land: "#2a1e17",
  water: "#0d0a08",
  border: "#5a4334",
  label: "#b29c88",
  area: "#ff7a2e",
  outline: "#ffb27a",
  drawLine: "#f4e7d6",
  drawPoint: "#ffb27a",
};

/** Pixels covered by floating cards on each side of the map. */
export interface Insets {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

setWorkerUrl(workerUrl);

/** Real outlines of the selectable areas, built by scripts/build-boundaries.mjs. */
const OUTLINES_URL = `${import.meta.env.BASE_URL}boundaries.geojson`;
const OUTLINES_CREDIT = 'Boundaries: <a href="https://www.geoboundaries.org" target="_blank" rel="noopener">geoBoundaries</a> (ODbL, CC BY 3.0 IGO)';

const BASEMAP = "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";
const FALLBACK: StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: "bg", type: "background", paint: { "background-color": MAP.background } }],
};

/** Zoom from which the basemap coastline replaces the simplified area outlines. */
const COAST_ZOOM = 7;

type GeoFC = GeoJSON.FeatureCollection;
const EMPTY: GeoFC = { type: "FeatureCollection", features: [] };

export interface MapCallbacks {
  onPolygon: (ring: LngLat[] | null) => void;
  onDrawState: (drawing: boolean, vertices: number) => void;
}

/** Closed ring of the grid square of half-side `h` degrees centred on `lon`, `lat`. */
function cellRing(lon: number, lat: number, h: number): GeoJSON.Position[] {
  return [[lon - h, lat - h], [lon + h, lat - h], [lon + h, lat + h], [lon - h, lat + h], [lon - h, lat - h]];
}

/** Most active block of the period, from the cells response. */
export type Top = NonNullable<CellsResponse["top"]>;

/** MapLibre map showing active fire cells, selected area outlines, a fire event box and the polygon drawing tool. */
export class MapView {
  readonly map: MLMap;
  private hotspots: GeoFC = EMPTY;
  private eventBox: GeoFC = EMPTY;
  /** Lower bounds of the colour classes for the current cells. */
  breaks: number[] = [0];
  /** Side of the delivered cells in degrees (0.05, or 0.25 for an unusually large layer). */
  private resDeg = 0.05;
  /** What the cells show: observed hotspots, or forecast chances of fire (with the period they are for). */
  private forecast: { label: string } | null = null;
  private polygon: LngLat[] | null = null;
  private outlineIds: string[] = [];
  private draft: LngLat[] = [];
  private cursor: LngLat | null = null;
  private drawing = false;
  private ramp: RampName = "ember";
  private insets: Insets = { top: 40, bottom: 40, left: 40, right: 40 };
  /** Ids of the sea layers drawn over the fire cells, which clip the cells to the coastline. */
  private seaMasks: string[] = [];
  /** Ids of the coastline layers traced from the basemap's sea, shown while an area is selected. */
  private coastLayers: string[] = [];
  private callout: Marker | null = null;
  private readonly popup = new Popup({ closeButton: false, closeOnClick: false, className: "hs-popup", offset: 8 });

  constructor(el: HTMLElement, private readonly cb: MapCallbacks) {
    this.map = new MLMap({
      container: el,
      style: BASEMAP,
      bounds: [95, -11, 141, 7],
      attributionControl: false,
      dragRotate: false,
      pitchWithRotate: false,
      clickTolerance: 6,
    });
    this.map.touchZoomRotate.disableRotation();
    this.map.addControl(new NavigationControl({ showCompass: false }), "bottom-right");
    this.map.addControl(new AttributionControl({ compact: true }), "bottom-left");
    // Hover and focus reveal the credits, so a click must not close the <details> that holds them
    el.querySelector(".maplibregl-ctrl-attrib-button")?.removeAttribute("title");
    el.querySelector(".maplibregl-ctrl-attrib")?.addEventListener(
      "click",
      (e) => {
        if (!(e.target as Element).closest("summary")) return;
        e.preventDefault();
        e.stopPropagation();
      },
      { capture: true },
    );
    this.map.on("style.load", () => this.installLayers());
    let fellBack = false;
    this.map.on("error", (e) => {
      if (fellBack || this.map.isStyleLoaded() || !String(e.error?.message ?? "").length) return;
      fellBack = true;
      this.map.setStyle(FALLBACK);
    });
    this.map.on("click", (e) => this.onClick(e));
    this.map.on("dblclick", (e) => {
      if (!this.drawing) return;
      e.preventDefault();
      this.finishDrawing();
    });
    this.map.on("mousemove", (e) => {
      if (!this.drawing) return;
      this.cursor = [e.lngLat.lng, e.lngLat.lat];
      this.syncDraft();
    });
    el.addEventListener("keydown", (e) => {
      if (!this.drawing) return;
      if (e.key === "Escape") this.cancelDrawing();
      else if (e.key === "Enter") this.finishDrawing();
      else if (e.key === "Backspace") {
        this.draft.pop();
        this.syncDraft();
      }
    });
  }

  /**
   * Places an element of the page among the map controls of a corner: bottom right, left of the zoom
   * buttons, or bottom left, before the map credits.
   */
  addCornerControl(el: HTMLElement, corner: "bottom-right" | "bottom-left" = "bottom-right"): void {
    this.map.addControl({ onAdd: () => el, onRemove: () => el.remove() }, corner);
    if (corner === "bottom-left") el.parentElement?.prepend(el);
  }

  /** Colours the cells with the palette, and the area outlines and drawing with its accent. */
  setRamp(ramp: RampName): void {
    this.ramp = ramp;
    this.syncCellPaint();
    MAP.area = RAMPS[ramp].accent;
    MAP.outline = RAMPS[ramp].accentInk;
    MAP.drawPoint = RAMPS[ramp].accentInk;
    const paint: [string, "fill-color" | "line-color" | "circle-color", string][] = [
      ["polygon-fill", "fill-color", MAP.area],
      ["polygon-line", "line-color", MAP.area],
      ["outline-glow", "line-color", MAP.area],
      ["outline-line", "line-color", MAP.outline],
      ["coast-glow", "line-color", MAP.area],
      ["coast-line", "line-color", MAP.outline],
      ["draft-points", "circle-color", MAP.drawPoint],
    ];
    for (const [id, prop, color] of paint) if (this.map.getLayer(id)) this.map.setPaintProperty(id, prop, color);
  }

  /**
   * Shows the active cells of the period as filled grid squares, coloured by harmonised value with quantile classes
   * of these cells, or with the given `breaks` so that several periods share one scale.
   */
  setCells(c: CellsResponse | null, breaks?: number[]): void {
    const cells = c?.cells;
    this.forecast = null;
    this.resDeg = c?.res_deg ?? 0.05;
    this.breaks = breaks ?? (cells ? quantileBreaks(cells.value, RAMPS[this.ramp].steps.length) : [0]);
    this.drawCells(cells?.lon ?? [], cells?.lat ?? [], (i) => ({
      value: cells!.value[i], modis: cells!.modis_px[i], viirs: cells!.viirs_px[i], frp: cells!.frp_max[i],
    }));
  }

  /**
   * Shows the forecast chance of fire per cell for one lead, in the palette's ramp with the fixed chance classes.
   * `label` names the day, month or year it is for; the popup marks it as a forecast.
   */
  setOutlook(c: OutlookCells, label: string): void {
    this.forecast = { label };
    this.resDeg = c.grid_deg;
    this.breaks = CHANCE_BREAKS;
    this.drawCells(c.cells.lon, c.cells.lat, (i) => ({ value: c.cells.chance[i] }));
  }

  private drawCells(lon: number[], lat: number[], props: (i: number) => GeoJSON.GeoJsonProperties): void {
    const h = this.resDeg / 2;
    this.hotspots = {
      type: "FeatureCollection",
      features: lon.map((x, i) => ({ type: "Feature", geometry: { type: "Polygon", coordinates: [cellRing(x, lat[i], h)] }, properties: props(i) })),
    };
    this.source("hotspots")?.setData(this.hotspots);
    this.syncCellPaint();
  }

  /** Outlines a fire event's bounding box, or removes it. */
  setEventBox(b: BBox | null): void {
    this.eventBox = b
      ? { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [[[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]], [b[0], b[1]]]] } }] }
      : EMPTY;
    this.source("event-box")?.setData(this.eventBox);
  }

  private syncCellPaint(): void {
    if (this.map.getLayer("hotspots")) this.map.setPaintProperty("hotspots", "fill-color", this.colorExpr());
  }

  /** Outlines the selected areas with their real borders. */
  setOutlines(ids: string[]): void {
    this.outlineIds = ids;
    for (const id of ["outline-glow", "outline-line"]) if (this.map.getLayer(id)) this.map.setFilter(id, this.outlineFilter());
    for (const id of this.coastLayers) this.map.setLayoutProperty(id, "visibility", ids.length ? "visible" : "none");
  }

  private outlineFilter(): ["in", ["get", string], ["literal", string[]]] {
    return ["in", ["get", "id"], ["literal", this.outlineIds]];
  }

  setPolygon(ring: LngLat[] | null): void {
    this.polygon = ring;
    this.syncPolygon();
  }

  /** Space taken by the floating cards, so fitting an area frames it in the gap between them. */
  setInsets(p: Insets): void {
    this.insets = p;
  }

  fitBBox(b: BBox): void {
    const c = this.map.getContainer();
    const fits = c.clientWidth - this.insets.left - this.insets.right > 120 && c.clientHeight - this.insets.top - this.insets.bottom > 120;
    this.map.fitBounds(new LngLatBounds([b[0], b[1]], [b[2], b[3]]), { padding: fits ? this.insets : 30, maxZoom: 8.5, duration: 700 });
  }

  /** Pins an ember callout with a leader line to the most active block, labelled with its region name, or removes it. */
  setCallout(c: Top | null, label: string): void {
    this.callout?.remove();
    this.callout = null;
    if (!c) return;
    const el = document.createElement("div");
    el.className = "callout";
    el.innerHTML = `<div class="callout-box"><span class="callout-row"><span class="callout-v">${fmtVal(c.value)}</span><span class="callout-u">${UNIT_SHORT}</span></span>
      <span class="callout-k">Most active cell &middot; ${escapeXml(label)}</span></div>
      <span class="callout-line" aria-hidden="true"></span><span class="callout-dot" aria-hidden="true"></span>`;
    this.callout = new Marker({ element: el, anchor: "bottom-left", offset: [-5, 5] }).setLngLat([c.lon, c.lat]).addTo(this.map);
  }

  startDrawing(): void {
    this.map.stop();
    this.popup.remove();
    this.drawing = true;
    this.draft = [];
    this.cursor = null;
    this.map.doubleClickZoom.disable();
    this.map.getCanvas().style.cursor = "crosshair";
    this.map.getCanvas().focus({ preventScroll: true });
    this.syncDraft();
  }

  finishDrawing(): void {
    if (!this.drawing) return;
    if (this.draft.length < 3) return;
    const ring = [...this.draft];
    this.stopDrawing();
    this.setPolygon(ring);
    this.cb.onPolygon(ring);
  }

  cancelDrawing(): void {
    if (!this.drawing) return;
    this.stopDrawing();
  }

  clearPolygon(): void {
    this.stopDrawing();
    this.setPolygon(null);
    this.cb.onPolygon(null);
  }

  private stopDrawing(): void {
    this.drawing = false;
    this.draft = [];
    this.cursor = null;
    this.map.getCanvas().style.cursor = "";
    setTimeout(() => this.map.doubleClickZoom.enable(), 0);
    this.syncDraft();
  }

  private onClick(e: MapMouseEvent): void {
    if (!this.drawing) return;
    const p: LngLat = [e.lngLat.lng, e.lngLat.lat];
    if (this.draft.length >= 3) {
      const first = this.map.project(this.draft[0]);
      if (Math.hypot(first.x - e.point.x, first.y - e.point.y) < 12) {
        this.finishDrawing();
        return;
      }
    }
    this.draft.push(p);
    this.syncDraft();
  }

  private source(id: string): GeoJSONSource | undefined {
    return this.map.getSource<GeoJSONSource>(id);
  }

  /** Step expression colouring cells by value (hotspots or chance) with the active ramp (one colour while there are no classes). */
  private colorExpr(): string | ["step", ["get", string], string, ...(string | number)[]] {
    const steps = RAMPS[this.ramp].steps;
    const offset = steps.length - this.breaks.length;
    if (this.breaks.length < 2) return steps[offset];
    const pairs = this.breaks.slice(1).flatMap((b, i) => [b, steps[offset + i + 1]]);
    return ["step", ["get", "value"], steps[offset], ...pairs];
  }

  /** Warms the basemap so it sits under the ember palette. */
  private gradeBasemap(): void {
    for (const layer of this.map.getStyle().layers ?? []) {
      if (layer.type === "background") this.map.setPaintProperty(layer.id, "background-color", MAP.land);
      else if (layer.type === "fill" && /water|ocean|sea/i.test(layer.id)) this.map.setPaintProperty(layer.id, "fill-color", MAP.water);
      else if (layer.type === "fill" && /land|park|wood|grass|residential/i.test(layer.id)) this.map.setPaintProperty(layer.id, "fill-color", MAP.land);
      else if (layer.type === "line" && /boundary|admin/i.test(layer.id)) this.map.setPaintProperty(layer.id, "line-color", MAP.border);
      else if (layer.type === "symbol" && /place|country|state|city|town|label/i.test(layer.id)) {
        this.map.setPaintProperty(layer.id, "text-color", MAP.label);
        this.map.setPaintProperty(layer.id, "text-halo-color", MAP.background);
      }
    }
  }

  private installLayers(): void {
    const m = this.map;
    this.gradeBasemap();
    m.addSource("outlines", { type: "geojson", data: OUTLINES_URL, attribution: OUTLINES_CREDIT });
    m.addSource("hotspots", { type: "geojson", data: this.hotspots });
    m.addSource("polygon", { type: "geojson", data: EMPTY });
    m.addSource("event-box", { type: "geojson", data: this.eventBox });
    m.addSource("draft", { type: "geojson", data: EMPTY });

    m.addLayer({ id: "polygon-fill", type: "fill", source: "polygon", paint: { "fill-color": MAP.area, "fill-opacity": 0.08 } });
    m.addLayer({ id: "polygon-line", type: "line", source: "polygon", paint: { "line-color": MAP.area, "line-width": 2 } });
    m.addLayer({
      id: "outline-glow",
      type: "line",
      source: "outlines",
      filter: this.outlineFilter(),
      paint: { "line-color": MAP.area, "line-width": 7, "line-blur": 5, "line-opacity": 0.35 },
    });
    m.addLayer({
      id: "outline-line",
      type: "line",
      source: "outlines",
      filter: this.outlineFilter(),
      layout: { "line-join": "round" },
      paint: { "line-color": MAP.outline, "line-width": ["interpolate", ["linear"], ["zoom"], 4, 1.2, 9, 2] },
    });
    // Antialiasing off keeps neighbouring cells flush, with no hairline seams between them
    m.addLayer({
      id: "hotspots",
      type: "fill",
      source: "hotspots",
      paint: { "fill-color": this.colorExpr(), "fill-opacity": 0.9, "fill-antialias": false },
    });
    this.addSeaMasks();
    this.addCoast();
    for (const id of ["outline-glow", "outline-line", "polygon-line"]) m.moveLayer(id);
    this.raisePlaceLabels();
    m.addLayer({ id: "event-box", type: "line", source: "event-box", paint: { "line-color": MAP.drawLine, "line-width": 1.5, "line-dasharray": [3, 2] } });
    m.addLayer({ id: "draft-line", type: "line", source: "draft", filter: ["==", ["geometry-type"], "LineString"], paint: { "line-color": MAP.drawLine, "line-width": 1.5, "line-dasharray": [2, 2] } });
    m.addLayer({ id: "draft-points", type: "circle", source: "draft", filter: ["==", ["geometry-type"], "Point"], paint: { "circle-color": MAP.drawPoint, "circle-radius": 4.5, "circle-stroke-color": MAP.background, "circle-stroke-width": 1.5 } });

    m.on("mousemove", "hotspots", (e) => {
      if (this.drawing) return;
      const f = e.features?.[0];
      if (!f) return;
      if (this.seaMasks.length && m.queryRenderedFeatures(e.point, { layers: this.seaMasks }).length) {
        m.getCanvas().style.cursor = "";
        this.popup.remove();
        return;
      }
      const p = f.properties as { value: number; modis: number; viirs: number; frp: number };
      m.getCanvas().style.cursor = "pointer";
      const html = this.forecast
        ? `<strong>${fmtChance(p.value)} chance of fire</strong> in this ${this.resDeg}° cell<br>${escapeXml(this.forecast.label)}<br>Forecast, not observed data`
        : `<strong>${fmtVal(p.value)} ${UNIT_SHORT}</strong> in this ${this.resDeg}° cell<br>Raw hotspots: VIIRS ${fmtInt(p.viirs)} &middot; MODIS ${fmtInt(p.modis)}<br>Highest fire radiative power ${p.frp} MW`;
      this.popup.setLngLat(e.lngLat).setHTML(html).addTo(m);
    });
    m.on("mouseleave", "hotspots", () => {
      if (!this.drawing) m.getCanvas().style.cursor = "";
      this.popup.remove();
    });
    this.syncPolygon();
    this.syncDraft();
  }

  /**
   * Redraws the basemap's water polygons above the fire cells, so a cell on the coast shows only its land part.
   * The fallback style has no water layers, and the cells are then drawn whole.
   */
  private addSeaMasks(): void {
    this.seaMasks = [];
    for (const layer of this.map.getStyle().layers ?? []) {
      if (layer.type !== "fill" || layer["source-layer"] !== "water" || /shadow/i.test(layer.id)) continue;
      const id = `sea-mask-${layer.id}`;
      this.map.addLayer({
        id,
        type: "fill",
        source: layer.source,
        "source-layer": "water",
        ...(layer.filter ? { filter: layer.filter } : {}),
        ...(layer.minzoom !== undefined ? { minzoom: layer.minzoom } : {}),
        ...(layer.maxzoom !== undefined ? { maxzoom: layer.maxzoom } : {}),
        paint: { "fill-color": MAP.water, "fill-antialias": true },
      });
      this.seaMasks.push(id);
    }
  }

  /**
   * The area outlines are simplified to about 2 km, which shows once zoomed in. At zoom 7 they switch at once
   * (a fade would show both lines side by side) to the basemap's own coastline (the edge of its sea polygons, so lakes and rivers stay unlined), which follows
   * the land as closely as the clipped cells do. Borders on land are hidden then too, as the outline cannot tell
   * them from its coast and a simplified coast would cut across the land beside the precise one.
   * The coastline is not limited to the selected area, which is why it only appears zoomed in.
   */
  private addCoast(): void {
    this.coastLayers = [];
    const sea = this.seaMasks.length ? this.map.getLayer(this.seaMasks[0]) : undefined;
    if (!sea) return;
    const below = (opacity: number) => ["step", ["zoom"], opacity, COAST_ZOOM, 0] as ExpressionSpecification;
    const width: ExpressionSpecification = ["interpolate", ["linear"], ["zoom"], 4, 1.2, 9, 2];
    const filter: FilterSpecification = ["all", ["in", ["geometry-type"], ["literal", ["Polygon", "MultiPolygon"]]], ["==", ["get", "kind"], "ocean"]];
    const visibility = this.outlineIds.length ? "visible" : "none";
    const base = { type: "line", source: sea.source, "source-layer": "water", filter, minzoom: COAST_ZOOM } as const;
    this.map.addLayer({ ...base, id: "coast-glow", layout: { visibility }, paint: { "line-color": MAP.area, "line-width": 7, "line-blur": 5, "line-opacity": 0.35 } });
    this.map.addLayer({ ...base, id: "coast-line", layout: { visibility, "line-join": "round" }, paint: { "line-color": MAP.outline, "line-width": width } });
    this.coastLayers = ["coast-glow", "coast-line"];
    this.map.setPaintProperty("outline-line", "line-opacity", below(1));
    this.map.setPaintProperty("outline-glow", "line-opacity", below(0.35));
  }

  /** Lifts the basemap's place and water names above the fire cells, so region names stay readable over them. */
  private raisePlaceLabels(): void {
    for (const layer of this.map.getStyle().layers ?? []) {
      if (layer.type === "symbol" && (layer["source-layer"] === "places" || layer["source-layer"] === "water")) this.map.moveLayer(layer.id);
    }
  }

  private syncPolygon(): void {
    const ring = this.polygon;
    this.source("polygon")?.setData(
      ring ? { type: "Feature", geometry: { type: "Polygon", coordinates: [[...ring, ring[0]]] }, properties: {} } : EMPTY,
    );
  }

  private syncDraft(): void {
    const pts = this.draft;
    const line = this.cursor && pts.length ? [...pts, this.cursor] : pts;
    const features: GeoJSON.Feature[] = pts.map((c) => ({ type: "Feature", geometry: { type: "Point", coordinates: c }, properties: {} }));
    if (line.length >= 2) features.push({ type: "Feature", geometry: { type: "LineString", coordinates: line }, properties: {} });
    this.source("draft")?.setData({ type: "FeatureCollection", features });
    this.cb.onDrawState(this.drawing, pts.length);
  }
}
