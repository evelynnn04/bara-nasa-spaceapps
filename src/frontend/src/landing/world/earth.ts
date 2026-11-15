// The last act: Indonesia seen from orbit. A globe (units: km) with the real coastline from the
// project's province outlines, ocean with shallow coastal water and sun glint, rainforest and
// burn scars, drifting cloud, the brown smoke haze over the fires, and an atmosphere rim. The fire
// lights are the real harmonised 0.05° cells from /api/cells: one light per cell that burned.
// Neighbouring countries (Natural Earth 1:50m, via world-atlas, loaded lazily) are the same green land
// with faint borders; only Indonesia has fire (the API only returns Indonesian cells).

import {
  AdditiveBlending, BackSide, BufferAttribute, BufferGeometry, CanvasTexture, Mesh, PerspectiveCamera, Points, Scene,
  ShaderMaterial, SphereGeometry, Vector3,
} from "three";
import { feature } from "topojson-client";
import { ORIGINS, rng, WORLD_GLSL } from "./common";

export const EARTH_R = 6371;
const LON0 = 94, LON1 = 142, LAT0 = -12, LAT1 = 8;

/** Position on the globe for lon/lat in degrees; the same convention as the shader. */
export function lonLat(lon: number, lat: number, r = EARTH_R): Vector3 {
  const a = (lon * Math.PI) / 180, b = (lat * Math.PI) / 180;
  return new Vector3(r * Math.cos(b) * Math.cos(a), r * Math.sin(b), -r * Math.cos(b) * Math.sin(a));
}

export interface Earth {
  scene: Scene;
  camera: PerspectiveCamera;
  /** 0 = low over Kalimantan, 1 = high, the whole archipelago in view. */
  setView(t: number, time: number): void;
  setProvinces(polys: GeoJSON.MultiPolygon[]): void;
  setCells(cells: [number, number, number][], gridDeg: number): void;
  resize(w: number, h: number): void;
  /** The free band of the screen (px from the top) that Indonesia should fill at the end. */
  setFrame(top: number, bottom: number): void;
}

export function buildEarth(): Earth {
  const scene = new Scene();
  const camera = new PerspectiveCamera(40, 1, 10, 60000);
  const sunDir = new Vector3().copy(lonLat(150, 12, 1)).normalize();

  // ---------------------------------------------------------------- region textures (painted on canvases)
  const W = 4096, H = Math.round((W * (LAT1 - LAT0)) / (LON1 - LON0));
  const mask = document.createElement("canvas");
  mask.width = W; mask.height = H;
  const mg = mask.getContext("2d")!;
  mg.fillStyle = "#000"; mg.fillRect(0, 0, W, H);
  const maskTex = new CanvasTexture(mask);

  const cw = 1024, ch = Math.round((cw * H) / W);
  const combo = document.createElement("canvas");          // R: coast blur, G: burn scar, B: haze
  combo.width = cw; combo.height = ch;
  const comboTex = new CanvasTexture(combo);
  let burnCanvas: HTMLCanvasElement | null = null;

  const px = (lon: number) => ((lon - LON0) / (LON1 - LON0)) * W;
  const py = (lat: number) => ((LAT1 - lat) / (LAT1 - LAT0)) * H;

  function blurred(src: HTMLCanvasElement, w: number, h: number, blur: number): ImageData {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const g = c.getContext("2d", { willReadFrequently: true })!;
    g.fillStyle = "#000"; g.fillRect(0, 0, w, h);
    g.filter = `blur(${blur}px)`;
    g.drawImage(src, 0, 0, w, h);
    return g.getImageData(0, 0, w, h);
  }
  function repaintCombo(): void {
    const coast = blurred(mask, cw, ch, 5);
    const burn = burnCanvas ? blurred(burnCanvas, cw, ch, 1.5) : null;
    const haze = burnCanvas ? blurred(burnCanvas, cw, ch, 28) : null;
    const g = combo.getContext("2d")!;
    const out = g.createImageData(cw, ch);
    for (let i = 0; i < out.data.length; i += 4) {
      out.data[i] = coast.data[i];
      out.data[i + 1] = burn ? Math.min(255, burn.data[i] * 2.2) : 0;
      out.data[i + 2] = haze ? Math.min(255, haze.data[i] * 3.5) : 0;
      out.data[i + 3] = 255;
    }
    g.putImageData(out, 0, 0);
    comboTex.needsUpdate = true;
  }
  repaintCombo();

  // ---------------------------------------------------------------- the rest of the world (R: land, G: borders)
  const WW = window.innerWidth < 760 ? 2048 : 4096, WH = WW / 2;
  const world = document.createElement("canvas");
  world.width = WW; world.height = WH;
  const wg = world.getContext("2d")!;
  wg.fillStyle = "#000"; wg.fillRect(0, 0, WW, WH);
  const worldTex = new CanvasTexture(world);
  async function loadWorld(): Promise<void> {
    const url = (await import("world-atlas/countries-50m.json?url")).default;
    const topo = await (await fetch(url)).json();
    const fc = feature(topo, topo.objects.countries) as unknown as {
      features: { id?: string; geometry: { type: string; coordinates: number[][][] | number[][][][] } | null }[];
    };
    const wx = (lon: number) => ((lon + 180) / 360) * WW, wy = (lat: number) => ((90 - lat) / 180) * WH;
    const trace = (ring: number[][]) => {
      ring.forEach(([lo, la], i) => {
        // a ring that jumps across the antimeridian would smear across the map: lift the pen instead
        if (i && Math.abs(lo - ring[i - 1][0]) > 180) wg.moveTo(wx(lo), wy(la));
        else if (i) wg.lineTo(wx(lo), wy(la));
        else wg.moveTo(wx(lo), wy(la));
      });
    };
    const polys = fc.features.filter((f) => f.geometry && f.id !== "360");          // 360 = Indonesia, drawn from the project's own outline
    const each = (cb: (poly: number[][][]) => void) => polys.forEach((f) => {
      const g = f.geometry!;
      (g.type === "Polygon" ? [g.coordinates as number[][][]] : (g.coordinates as number[][][][])).forEach(cb);
    });
    wg.fillStyle = "rgb(255,0,0)";
    each((poly) => { wg.beginPath(); poly.forEach(trace); wg.fill("evenodd"); });
    wg.globalCompositeOperation = "lighter";
    wg.strokeStyle = "rgb(0,255,0)";
    wg.lineWidth = WW / 2600;
    each((poly) => { wg.beginPath(); poly.forEach(trace); wg.stroke(); });
    wg.globalCompositeOperation = "source-over";
    worldTex.needsUpdate = true;
  }
  setTimeout(() => { loadWorld().catch(() => { /* the globe still works without neighbours */ }); }, 1500);

  // ---------------------------------------------------------------- the globe
  const uniforms = {
    uLand: { value: maskTex }, uCombo: { value: comboTex }, uWorld: { value: worldTex }, uSun: { value: sunDir }, uTime: { value: 0 },
    uRegion: { value: [LON0, LAT0, LON1, LAT1] }, uOrigins: { value: ORIGINS.map(() => new Vector3()) },
  };
  const globe = new Mesh(new SphereGeometry(EARTH_R, 256, 160), new ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */ `
      varying vec3 vN; varying vec3 vW;
      void main() { vN = normalize(position); vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D uLand, uCombo, uWorld; uniform vec3 uSun; uniform float uTime; uniform float uRegion[4];
      ${WORLD_GLSL}
      varying vec3 vN; varying vec3 vW;
      void main() {
        vec3 n = normalize(vN);
        float lat = degrees(asin(n.y)), lon = degrees(atan(-n.z, n.x));
        vec2 uv = vec2((lon - uRegion[0]) / (uRegion[2] - uRegion[0]), (lat - uRegion[1]) / (uRegion[3] - uRegion[1]));
        float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
        float land = texture2D(uLand, uv).r * inside;
        vec3 cb = texture2D(uCombo, uv).rgb * inside;
        vec2 ll = vec2(lon, lat);

        // land: rainforest greens, drier/brown uplands, burn scars from the real cells
        float relief = fbm(ll * 1.3);
        vec3 green = mix(vec3(0.035, 0.09, 0.03), vec3(0.08, 0.15, 0.05), fbm(ll * 6.0));
        green = mix(green, vec3(0.2, 0.17, 0.11), smoothstep(0.62, 0.82, relief));
        // Indonesia only: burn scars from the real cells
        vec3 forest = mix(green, vec3(0.19, 0.12, 0.07), smoothstep(0.05, 0.6, cb.g) * 0.85);
        // ocean: deep blue, turquoise shallows along the coast
        vec3 ocean = mix(vec3(0.01, 0.03, 0.07), vec3(0.04, 0.17, 0.2), smoothstep(0.08, 0.6, cb.r) * (1.0 - land));
        // neighbours: the same green land, with no fire
        vec2 wt = texture2D(uWorld, vec2((lon + 180.0) / 360.0, (lat + 90.0) / 180.0)).rg;
        float other = wt.r * (1.0 - smoothstep(0.2, 0.6, land));
        vec3 col = mix(ocean, green * 1.25, smoothstep(0.3, 0.7, other));
        col = mix(col, forest * 1.25, smoothstep(0.35, 0.65, land));

        vec3 v = normalize(cameraPosition - vW);
        float diff = max(dot(n, uSun), 0.0);
        col *= 0.12 + diff * 1.1;
        float glint = pow(max(dot(reflect(-uSun, n), v), 0.0), 140.0) * (1.0 - land) * (1.0 - other);
        col += vec3(1.0, 0.92, 0.8) * glint * 0.14;

        // country borders (faint), Indonesia's coast (an ember glow), and a faint graticule
        col = mix(col, vec3(0.55, 0.5, 0.45) * (0.25 + diff * 0.5), wt.g * 0.14 * (1.0 - smoothstep(0.2, 0.6, land)));
        float coastGlow = smoothstep(0.1, 0.32, cb.r) * (1.0 - smoothstep(0.32, 0.62, cb.r)) * (1.0 - land);
        col += vec3(1.0, 0.55, 0.2) * coastGlow * 0.16 * (0.5 + diff);
        vec2 gr = abs(fract(ll / 10.0 + 0.5) - 0.5) * 10.0 / max(fwidth(ll), vec2(1e-4));
        col += vec3(0.55, 0.65, 0.85) * (1.0 - min(min(gr.x, gr.y), 1.0)) * 0.035;

        // smoke haze over the fires, then cloud
        col = mix(col, vec3(0.34, 0.27, 0.2) * (0.3 + diff), smoothstep(0.08, 0.9, cb.b) * 0.45);
        float cl = fbm(ll * 0.9 + vec2(uTime * 0.01, 0.0)) * 0.7 + fbm(ll * 3.5 - vec2(uTime * 0.02, 0.0)) * 0.3;
        col = mix(col, vec3(0.9) * (0.2 + diff * 0.9), smoothstep(0.62, 0.86, cl) * 0.38);

        float rim = pow(1.0 - max(dot(n, v), 0.0), 3.0);
        col += vec3(0.25, 0.45, 0.9) * rim * 0.55 * (0.3 + diff);
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  }));
  scene.add(globe);

  scene.add(new Mesh(new SphereGeometry(EARTH_R * 1.025, 128, 64), new ShaderMaterial({
    side: BackSide, transparent: true, blending: AdditiveBlending, depthWrite: false,
    uniforms: { uSun: { value: sunDir } },
    vertexShader: /* glsl */ `varying vec3 vN; varying vec3 vW; void main(){ vN = normalize(position); vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uSun; varying vec3 vN; varying vec3 vW;
      void main(){
        vec3 v = normalize(cameraPosition - vW);
        float rim = pow(1.0 - abs(dot(normalize(vN), v)), 2.5);
        float lit = 0.25 + max(dot(normalize(vN), uSun), 0.0);
        gl_FragColor = vec4(vec3(0.3, 0.55, 1.0) * rim * lit * 0.9, 1.0);
      }`,
  })));

  // stars
  const R = rng(3);
  const sp = new Float32Array(3000 * 3);
  for (let i = 0; i < 3000; i++) {
    const v = new Vector3(R() - 0.5, R() - 0.5, R() - 0.5).normalize().multiplyScalar(50000);
    sp.set([v.x, v.y, v.z], i * 3);
  }
  const sg = new BufferGeometry();
  sg.setAttribute("position", new BufferAttribute(sp, 3));
  scene.add(new Points(sg, new ShaderMaterial({
    transparent: true, depthWrite: false,
    vertexShader: /* glsl */ `void main(){ gl_PointSize = 1.5; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: /* glsl */ `void main(){ gl_FragColor = vec4(vec3(0.85), 0.7); }`,
  })));

  // ---------------------------------------------------------------- fire cells
  const fireUniforms = { uTime: uniforms.uTime, uScale: { value: 600 } };
  const fireMat = new ShaderMaterial({
    transparent: true, depthWrite: false, blending: AdditiveBlending, uniforms: fireUniforms,
    vertexShader: /* glsl */ `
      uniform float uTime, uScale; attribute float aVal; attribute float aSeed; varying float vA; varying float vHot;
      void main(){
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float dist = -mv.z;
        vHot = clamp(aVal / 12.0, 0.0, 1.0);
        vA = (0.55 + 0.45 * sin(uTime * (2.0 + aSeed * 5.0) + aSeed * 40.0)) * (0.55 + 0.45 * vHot);
        gl_PointSize = clamp((26.0 + 34.0 * vHot) * uScale / dist, 2.4, 30.0);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      varying float vA; varying float vHot;
      void main(){
        float d = length(gl_PointCoord - 0.5);
        float core = smoothstep(0.5, 0.0, d);
        vec3 col = mix(vec3(1.0, 0.35, 0.05), vec3(1.0, 0.85, 0.5), vHot * core);
        float a = (core * core + 0.25 * core) * vA;
        gl_FragColor = vec4(col * a, a);
      }`,
  });
  const firePts = new Points(new BufferGeometry(), fireMat);
  firePts.frustumCulled = false;
  scene.add(firePts);

  // ---------------------------------------------------------------- camera
  // The end view fits the whole archipelago into the free band of the screen between the header and the
  // finale text (set by the page with setFrame), at any size or aspect, and centres it in that band.
  const INDO = { lon: 118, lat: -2.6, halfW: 2850, halfH: 980 };      // centre and half-extent in km (with a little slack)
  const frame = { w: 1, h: 1, top: 0, bottom: 1 };
  const target = new Vector3(), north = new Vector3(), upv = new Vector3(), pos = new Vector3();
  function endFraming(tilt: number): { alt: number; shift: number } {
    const tanV = Math.tan(((camera.fov / 2) * Math.PI) / 180);
    const band = Math.max(80, frame.bottom - frame.top);
    const fitW = INDO.halfW / (tanV * (frame.w / frame.h) * 0.8);            // 10 % margin each side
    const fitH = (INDO.halfH * Math.cos(tilt)) / (tanV * (band / frame.h) * 0.8);
    const alt = Math.min(26000, Math.max(3800, fitW, fitH));           // tall phones need to be far out to fit the width
    const shift = frame.h / 2 - (frame.top + frame.bottom) / 2;              // px to move the centre up
    return { alt, shift };
  }
  function setView(t: number, time: number): void {
    uniforms.uTime.value = time;
    const e = t * t * (3 - 2 * t);
    const tilt = 4 * (1 - e) * (Math.PI / 180);                       // ends looking straight down: the globe sits square
    const end = endFraming(tilt);
    const lon = 113.6 + (INDO.lon - 113.6) * e + Math.sin(time * 0.05) * 0.25 * e;
    const lat = -1.2 + (INDO.lat + 1.2) * e;
    const alt = 380 * Math.pow(end.alt / 380, e);
    target.copy(lonLat(lon, lat));
    upv.copy(target).normalize();
    north.copy(lonLat(lon, lat + 0.5)).sub(target).normalize();
    pos.copy(target).addScaledVector(upv, alt * Math.cos(tilt)).addScaledVector(north, -alt * Math.sin(tilt));
    camera.position.copy(pos);
    camera.up.copy(north);
    camera.lookAt(target);
    camera.setViewOffset(frame.w, frame.h, 0, end.shift * e, frame.w, frame.h);
  }

  return {
    scene, camera, setView,
    setProvinces(polys) {
      mg.fillStyle = "#000"; mg.fillRect(0, 0, W, H);
      mg.fillStyle = "#fff";
      for (const g of polys) {
        for (const poly of g.coordinates) {
          mg.beginPath();
          for (const ring of poly) {
            ring.forEach(([lo, la], i) => (i ? mg.lineTo(px(lo), py(la)) : mg.moveTo(px(lo), py(la))));
            mg.closePath();
          }
          mg.fill("evenodd");
        }
      }
      maskTex.needsUpdate = true;
      repaintCombo();
    },
    setCells(cells, g) {
      const p = new Float32Array(cells.length * 3), v = new Float32Array(cells.length), s = new Float32Array(cells.length);
      burnCanvas = document.createElement("canvas");
      burnCanvas.width = W / 4; burnCanvas.height = Math.round(H / 4);
      const bg = burnCanvas.getContext("2d")!;
      bg.fillStyle = "#000"; bg.fillRect(0, 0, burnCanvas.width, burnCanvas.height);
      cells.forEach(([cx, cy, n], i) => {
        const lon = (cx + 0.5) * g, lat = (cy + 0.5) * g;
        const q = lonLat(lon, lat, EARTH_R + 1.5);
        p.set([q.x, q.y, q.z], i * 3);
        v[i] = n;
        s[i] = R();
        bg.fillStyle = `rgba(255,255,255,${Math.min(1, 0.25 + n / 15)})`;
        bg.fillRect(px(lon) / 4 - 1, py(lat) / 4 - 1, 2.2, 2.2);
      });
      const geo = new BufferGeometry();
      geo.setAttribute("position", new BufferAttribute(p, 3));
      geo.setAttribute("aVal", new BufferAttribute(v, 1));
      geo.setAttribute("aSeed", new BufferAttribute(s, 1));
      firePts.geometry.dispose();
      firePts.geometry = geo;
      repaintCombo();
    },
    resize(w, h) {
      frame.w = w; frame.h = h;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      fireUniforms.uScale.value = h * 0.9;
    },
    setFrame(top, bottom) {
      frame.top = top; frame.bottom = bottom;
    },
  };
}
