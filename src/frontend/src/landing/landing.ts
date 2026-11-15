// Bara, the landing page: a scroll-driven flight. First person through a rainforest river, the forest
// catches fire, you climb above the burning landscape, then rise through the haze to orbit, where
// Indonesia shows the real 2015 fire cells. Scroll sets where you are (journey.ts eases towards it);
// fact stops fade in along the way. With reduced motion or without WebGL, the facts are an ordinary
// page over the still 2D backdrop (scene.ts).

import "./base.css";
import "./landing.css";

import { Api, type CellsResponse } from "../api";
import { fmtInt } from "../format";
import { loadBoundaries } from "../regions";
import { startJourney, webglOk, type Journey } from "./journey";
import { startScene } from "./scene";

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const smooth = (x: number) => { const c = clamp01(x); return c * c * (3 - 2 * c); };
const fmt = (v: number, d: number) => v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const motionOk = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const flying = motionOk && webglOk();

// ---------------------------------------------------------------- data and links into the dashboard

/** The orbit view shows Aug–Oct 2015 (the same period is fetched for the globe's fire cells). */
const PERIOD = { start: "2015-08-01", end: "2015-10-31" };
// The finale opens the dashboard on 2015.
$<HTMLAnchorElement>("go-dashboard").href = "/dashboard/?from=2015-01-01&to=2015-12-31";

const api = new Api();

/**
 * Harmonised cells of all Indonesia in the orbit period, as [cx, cy, value] with `cx`, `cy` the grid
 * indices (`floor(lon / gridDeg)`); the API sends cell centres.
 */
async function fireCells(): Promise<{ cells: [number, number, number][]; gridDeg: number }> {
  const r: CellsResponse = await api.cells(
    { mode: "area", regionIds: ["idn"], polygon: null, ...PERIOD },
    { daynight: "all", hotspots: "vegetation" },
  );
  const g = r.res_deg;
  const { lon, lat, value } = r.cells;
  return { cells: lon.map((x, i) => [Math.round(x / g - 0.5), Math.round(lat[i] / g - 0.5), value[i]]), gridDeg: g };
}

/** Province outlines from the dashboard's boundary file, for the coastline seen from orbit. */
async function provinces(): Promise<GeoJSON.MultiPolygon[]> {
  const fc = await loadBoundaries();
  return fc.features.filter((f) => f.properties.level === "province").map((f) => f.geometry);
}

// ---------------------------------------------------------------- stops

interface Scrub { el: HTMLElement; from: number; to: number; decimals: number; suffix: string }
interface Stop { el: HTMLElement; p: number; scrubs: Scrub[] }
const stops: Stop[] = Array.from(document.querySelectorAll<HTMLElement>(".stop, .finale")).map((el) => ({
  el,
  p: Number(el.dataset.p),
  scrubs: Array.from(el.querySelectorAll<HTMLElement>("[data-scrub]")).map((s) => {
    const [from, to, decimals] = s.dataset.scrub!.split(",").map(Number);
    return { el: s, from, to, decimals, suffix: s.dataset.suffix ?? "" };
  }),
}));

const HOLD = 0.022;   // fully visible within this distance of a stop
const FADE = 0.048;   // gone at this distance

function showStops(p: number): void {
  for (const s of stops) {
    const d = s.el.classList.contains("finale") ? Math.max(0, s.p - 0.04 - p) : Math.abs(p - s.p);
    const vis = 1 - smooth((d - HOLD) / (FADE - HOLD));
    s.el.style.setProperty("--vis", vis.toFixed(3));
    s.el.classList.toggle("is-on", vis > 0.5);
    s.el.inert = vis < 0.5;
    if (s.scrubs.length) {
      const t = smooth((p - (s.p - FADE)) / (FADE - HOLD * 0.5));
      for (const sc of s.scrubs) sc.el.textContent = fmt(sc.from + (sc.to - sc.from) * t, sc.decimals) + sc.suffix;
    }
  }
}

// ---------------------------------------------------------------- intro

let started = false;
function start(): void {
  if (started) return;
  started = true;
  document.body.classList.remove("is-intro");
  document.body.classList.add("is-flying");
  window.scrollTo({ top: 0 });
}
$("explore").addEventListener("click", start);

// ---------------------------------------------------------------- about

const about = $<HTMLDialogElement>("about");
$("about-open").addEventListener("click", () => about.showModal());
about.addEventListener("click", (e) => { if (e.target === about) about.close(); });

// ---------------------------------------------------------------- the flight

const progressBar = $("progress");
const hint = $("hint");
const hazeEl = $("haze");

function wireFlight(journey: Journey): void {
  const readScroll = () => {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    journey.setTarget(max > 0 ? window.scrollY / max : 0);
  };
  window.addEventListener("scroll", readScroll, { passive: true });
  readScroll();
  // Indonesia's end framing: the band between the header and the finale text, re-measured on resize
  // and once the display font has loaded (it changes the title's height).
  const hud = document.querySelector<HTMLElement>(".hud")!;
  const finale = $("finale");
  const measure = () => {
    const top = hud.getBoundingClientRect().bottom;
    const bottom = window.innerHeight * (1 - 0.09) - finale.offsetHeight;   // .finale sits at bottom: 9vh
    journey.setFrame(top, Math.max(top + 120, bottom - 16));
  };
  measure();
  window.addEventListener("resize", measure);
  void document.fonts?.ready.then(measure);
  window.addEventListener("pointermove", (e) => {
    journey.setPointer((e.clientX / window.innerWidth) * 2 - 1, (e.clientY / window.innerHeight) * 2 - 1);
  }, { passive: true });

  journey.onFrame((s) => {
    showStops(s.p);
    progressBar.style.transform = `scaleX(${s.p.toFixed(4)})`;
    hint.style.opacity = String(started ? Math.max(0, 1 - s.p * 40) : 0);
    hazeEl.style.opacity = s.haze.toFixed(3);
  });

  // The orbit view: real coastline and the real harmonised fire cells for Aug–Oct 2015.
  provinces().then((polys) => journey.setProvinces(polys)).catch(() => {});
  fireCells().then(({ cells, gridDeg }) => {
    if (!cells.length) return;
    journey.setCells(cells, gridDeg);
    $("live-cells").textContent = fmtInt(cells.length);
  }).catch(() => { $("live-cells").textContent = "thousands of"; });

  // Keyboard users: focusing a stop's link brings the flight to that stop.
  document.addEventListener("focusin", (e) => {
    const stop = stops.find((s) => s.el.contains(e.target as Node));
    if (!stop) return;
    const max = document.documentElement.scrollHeight - window.innerHeight;
    window.scrollTo({ top: stop.p * max });
  });
}

if (flying) {
  document.body.classList.add("is-journey");
  history.scrollRestoration = "manual";          // every visit starts at the title card
  window.scrollTo(0, 0);
  const wake = () => start();
  window.addEventListener("wheel", wake, { passive: true, once: true });
  window.addEventListener("touchmove", wake, { passive: true, once: true });
  window.addEventListener("keydown", (e) => { if (["ArrowDown", "PageDown", " ", "Enter"].includes(e.key) && !started) start(); });

  // Grow the world after the title card has painted, so the page never looks frozen.
  const load = $("intro-load");
  requestAnimationFrame(() => setTimeout(() => {
    const journey = startJourney($<HTMLCanvasElement>("world"));
    if (!journey) { fallBack(); return; }
    load.textContent = "";
    document.body.classList.add("is-ready");
    wireFlight(journey);
  }, 60));
} else {
  fallBack();
}

/** Reduced motion or no WebGL: the facts as a calm page over a still 2D backdrop. */
function fallBack(): void {
  document.body.classList.remove("is-intro", "is-journey");
  document.body.classList.add("is-static");
  started = true;
  const backdrop = startScene($<HTMLCanvasElement>("scene"));
  stops.forEach((s) => { s.el.style.setProperty("--vis", "1"); s.el.classList.add("is-on"); s.el.inert = false; });
  const onScroll = () => {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    backdrop.setStory(max > 0 ? window.scrollY / max : 0, 1);
  };
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
  fireCells()
    .then(({ cells }) => { if (cells.length) $("live-cells").textContent = fmtInt(cells.length); })
    .catch(() => {});
}

