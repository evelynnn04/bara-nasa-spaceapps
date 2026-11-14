import { AttributionControl, GeoJSONSource, LngLatBounds, Map as MLMap, Marker, NavigationControl, Popup, setWorkerUrl, type MapMouseEvent, type StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { RAMPS, type RampName } from "./ramps";
import { escapeXml } from "./format";
import type { Cell } from "./store";
import type { BBox, Hotspot, LngLat } from "./types";

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

/** Fire radiative power breaks (MW) for the hotspot colour steps. */
export const FRP_BREAKS = [0, 4, 8, 15, 30, 60, 120, 250];

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

type GeoFC = GeoJSON.FeatureCollection;
const EMPTY: GeoFC = { type: "FeatureCollection", features: [] };

export interface MapCallbacks {
  onPolygon: (ring: LngLat[] | null) => void;
  onDrawState: (drawing: boolean, vertices: number) => void;
}

/** MapLibre map showing filtered hotspots, selected area outlines and the polygon drawing tool. */
export class MapView {
  readonly map: MLMap;
  private hotspots: GeoFC = EMPTY;
  private polygon: LngLat[] | null = null;
  private outlineIds: string[] = [];
  private draft: LngLat[] = [];
  private cursor: LngLat | null = null;
  private drawing = false;
  private ramp: RampName = "ember";
  private insets: Insets = { top: 40, bottom: 40, left: 40, right: 40 };
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
    this.map.on("error", (e) => {
      if (!this.map.isStyleLoaded() && String(e.error?.message ?? "").length) this.map.setStyle(FALLBACK);
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

  /** Places an element of the page among the map controls in the bottom-right corner, left of the zoom buttons. */
  addCornerControl(el: HTMLElement): void {
    this.map.addControl({ onAdd: () => el, onRemove: () => el.remove() }, "bottom-right");
  }

  setRamp(ramp: RampName): void {
    this.ramp = ramp;
    if (this.map.getLayer("hotspots")) this.map.setPaintProperty("hotspots", "circle-color", this.colorExpr());
    if (this.map.getLayer("hotspots-glow")) this.map.setPaintProperty("hotspots-glow", "circle-color", this.glowColor());
  }

  setHotspots(items: Hotspot[]): void {
    this.hotspots = {
      type: "FeatureCollection",
      features: items.map((h) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [h.lon, h.lat] },
        properties: { frp: h.frp, date: h.date, sensor: h.sensor, confidence: h.confidence },
      })),
    };
    this.source("hotspots")?.setData(this.hotspots);
  }

  /** Outlines the selected areas with their real borders. */
  setOutlines(ids: string[]): void {
    this.outlineIds = ids;
    for (const id of ["outline-glow", "outline-line"]) if (this.map.getLayer(id)) this.map.setFilter(id, this.outlineFilter());
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

  /** Pins an ember callout with a leader line to the busiest grid cell, labelled with its region name, or removes it. */
  setCallout(c: Cell | null, label: string): void {
    this.callout?.remove();
    this.callout = null;
    if (!c) return;
    const el = document.createElement("div");
    el.className = "callout";
    el.innerHTML = `<div class="callout-box"><span class="callout-row"><span class="callout-v">${c.count.toLocaleString("en-US")}</span><span class="callout-u">fire points</span></span>
      <span class="callout-k">Highest intensity hotspot &middot; ${escapeXml(label)}</span></div>
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

  /** Glow under the fire points, taken from the active ramp so it follows the chosen palette. */
  private glowColor(): string {
    return RAMPS[this.ramp].steps[5];
  }

  /** Step expression colouring hotspots by fire radiative power with the active ramp. */
  private colorExpr(): ["step", ["get", string], string, ...(string | number)[]] {
    const steps = RAMPS[this.ramp].steps;
    const pairs = FRP_BREAKS.slice(1).flatMap((b, i) => [b, steps[i + 1]]);
    return ["step", ["get", "frp"], steps[0], ...pairs];
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
    m.addLayer({
      id: "hotspots-glow",
      type: "circle",
      source: "hotspots",
      paint: {
        "circle-color": this.glowColor(),
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 3, 7, 6, 13, 9, 22],
        "circle-blur": 1,
        "circle-opacity": ["interpolate", ["linear"], ["zoom"], 3, 0.1, 8, 0.16],
      },
    });
    m.addLayer({
      id: "hotspots",
      type: "circle",
      source: "hotspots",
      layout: { "circle-sort-key": ["get", "frp"] },
      paint: {
        "circle-color": this.colorExpr(),
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 3, 1.4, 6, 2.6, 9, 5, 12, 8],
        "circle-opacity": 0.9,
        "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 6, 0, 9, 0.6],
        "circle-stroke-color": MAP.background,
      },
    });
    m.addLayer({ id: "draft-line", type: "line", source: "draft", filter: ["==", ["geometry-type"], "LineString"], paint: { "line-color": MAP.drawLine, "line-width": 1.5, "line-dasharray": [2, 2] } });
    m.addLayer({ id: "draft-points", type: "circle", source: "draft", filter: ["==", ["geometry-type"], "Point"], paint: { "circle-color": MAP.drawPoint, "circle-radius": 4.5, "circle-stroke-color": MAP.background, "circle-stroke-width": 1.5 } });

    m.on("mousemove", "hotspots", (e) => {
      if (this.drawing) return;
      const f = e.features?.[0];
      if (!f) return;
      const p = f.properties as { frp: number; date: string; sensor: string; confidence: string };
      m.getCanvas().style.cursor = "pointer";
      this.popup
        .setLngLat(e.lngLat)
        .setHTML(`<strong>${escapeXml(p.date)}</strong><br>${escapeXml(p.sensor)} &middot; ${p.frp} MW &middot; ${escapeXml(p.confidence)} confidence`)
        .addTo(m);
    });
    m.on("mouseleave", "hotspots", () => {
      if (!this.drawing) m.getCanvas().style.cursor = "";
      this.popup.remove();
    });
    this.syncPolygon();
    this.syncDraft();
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
