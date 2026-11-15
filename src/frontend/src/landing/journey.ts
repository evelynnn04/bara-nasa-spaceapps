// Bara's flight, in four acts, all played by scrolling (0 → 1):
//   1. 0.00–0.27  first person, a few metres above a jungle river, between real rainforest trees;
//   2. 0.27–0.45  fire breaks out on the bank ahead and spreads; you rise above the burning canopy;
//   3. 0.45–0.76  you climb into the sky: fronts and smoke plumes across the whole landscape;
//   4. 0.68–0.765 up through the smoke deck above the fire, looking down as the fire disappears under it;
//   5. 0.765–1.00 orbit: Indonesia, with the real 2015 fire cells, among its (muted) neighbours.
// Scroll sets a target; the camera eases towards it, so the flight glides.

import {
  ACESFilmicToneMapping, BackSide, Color, DirectionalLight, FogExp2, HemisphereLight, InstancedBufferAttribute,
  InstancedBufferGeometry, MathUtils, Mesh, NormalBlending, PCFSoftShadowMap, PerspectiveCamera, PlaneGeometry, Scene,
  ShaderMaterial, SphereGeometry, Vector3, WebGLRenderer,
} from "three";
import { Sky } from "three/examples/jsm/objects/Sky.js";
import type { PolygonGeometry } from "../types";
import { riverX, rng, WATER_Y } from "./world/common";
import { buildEarth } from "./world/earth";
import { buildFire } from "./world/fire";
import { buildForest } from "./world/forest";
import { puffTexture } from "./world/textures";

export const ACTS = { fire: 0.27, sky: 0.45, haze0: 0.68, swap: 0.765, haze1: 0.8, end: 1 } as const;

export interface FrameState {
  p: number;
  /** 0–1 opacity of the smoke whiteout between the forest and orbit. */
  haze: number;
}

export interface Journey {
  setTarget(p: number): void;
  onFrame(cb: (s: FrameState) => void): void;
  setPointer(x: number, y: number): void;
  setProvinces(polys: PolygonGeometry[]): void;
  setCells(cells: [number, number, number][], gridDeg: number): void;
  /** The free band (px from the top) between the header and the finale text, for the orbit framing. */
  setFrame(top: number, bottom: number): void;
}

/** WebGL available? Checked before the heavy build so the page can fall back at once. */
export function webglOk(): boolean {
  try { return !!document.createElement("canvas").getContext("webgl2"); } catch { return false; }
}

// ---------------------------------------------------------------- atmosphere keyframes along the flight
interface Mood {
  p: number; elev: number; turb: number; ray: number; mie: number; exp: number;
  fog: number; dens: number; sun: number; sunI: number; sky: number; gnd: number; hemiI: number; wind: number;
}
const MOODS: Mood[] = [
  { p: 0.0, elev: 17, turb: 2.2, ray: 1.7, mie: 0.004, exp: 0.44, fog: 0xa9b8ae, dens: 0.0032, sun: 0xfff0d6, sunI: 3.0, sky: 0xc4dceb, gnd: 0x2b3a1a, hemiI: 1.35, wind: 0.8 },
  { p: 0.25, elev: 15, turb: 3.0, ray: 1.7, mie: 0.006, exp: 0.44, fog: 0xa4ae9c, dens: 0.003, sun: 0xffe6c0, sunI: 2.8, sky: 0xc8d6d6, gnd: 0x2e3a1c, hemiI: 1.25, wind: 1.0 },
  { p: 0.36, elev: 12, turb: 7, ray: 3.0, mie: 0.03, exp: 0.34, fog: 0x7a6252, dens: 0.0042, sun: 0xffa060, sunI: 1.9, sky: 0xc89878, gnd: 0x3c2414, hemiI: 0.85, wind: 1.6 },
  { p: 0.5, elev: 10, turb: 8, ray: 3.2, mie: 0.04, exp: 0.3, fog: 0x6a5244, dens: 0.0046, sun: 0xff9050, sunI: 1.8, sky: 0xb88a6a, gnd: 0x40200e, hemiI: 0.8, wind: 1.8 },
  { p: 0.72, elev: 10, turb: 8, ray: 3.2, mie: 0.04, exp: 0.3, fog: 0x7a6252, dens: 0.0046, sun: 0xffa060, sunI: 1.8, sky: 0xc09878, gnd: 0x40200e, hemiI: 0.8, wind: 1.8 },
];

export function startJourney(canvas: HTMLCanvasElement): Journey | null {
  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
  } catch {
    return null;
  }
  const small = window.innerWidth < 760 || navigator.hardwareConcurrency <= 4;
  const shadows = !small;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, small ? 1.25 : 1.5));
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.shadowMap.enabled = shadows;
  renderer.shadowMap.type = PCFSoftShadowMap;

  // ---------------------------------------------------------------- forest world
  const scene = new Scene();
  const fog = new FogExp2(0xa9b8ae, 0.003);
  scene.fog = fog;
  const camera = new PerspectiveCamera(60, 1, 0.6, 16000);

  const sky = new Sky();
  sky.scale.setScalar(12000);
  scene.add(sky);
  const skyU = sky.material.uniforms;

  // A layer of smoke over the sky that thickens as the fire grows; its horizon takes the fog's colour,
  // so sky and land meet without a seam.
  const smokeU = { uAmt: { value: 0 }, uTop: { value: new Color(0x241c1a) }, uHor: { value: new Color(0x7a6252) } };
  const smokeDome = new Mesh(new SphereGeometry(5200, 32, 16), new ShaderMaterial({
    side: BackSide, transparent: true, depthWrite: false, fog: false, uniforms: smokeU,
    vertexShader: /* glsl */ `varying vec3 vD; void main(){ vD = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform float uAmt; uniform vec3 uTop, uHor; varying vec3 vD;
      void main(){
        float h = clamp(vD.y * 1.8, 0.0, 1.0);
        gl_FragColor = vec4(mix(uHor, uTop, pow(h, 0.6)), uAmt * mix(1.0, 0.82, h));   // opaque below the horizon
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  }));
  scene.add(smokeDome);

  const sun = new DirectionalLight(0xfff0d6, 2.7);
  const sunDir = new Vector3();
  if (shadows) {
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const c = sun.shadow.camera;
    c.left = c.bottom = -130; c.right = c.top = 130; c.near = 1; c.far = 900;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.5;
  }
  const hemi = new HemisphereLight(0xc4dceb, 0x2b3a1a, 0.95);
  scene.add(sun, sun.target, hemi);

  const forest = buildForest(small, shadows);
  scene.add(forest.group);
  const fire = buildFire(forest, small);
  scene.add(fire.group);

  // ---------------------------------------------------------------- the smoke deck
  // A layer of smoke cloud 2–3 km up, over where the climb ends. You rise into it from below (fire glow
  // lights its underside), pass through, and the burning land disappears under it.
  const DECK = { x: 260, z: -3620, r: 1700, y0: 1950, y1: 3050 };
  const R = rng(77);
  const deckN = small ? 240 : 420;
  const dOff = new Float32Array(deckN * 3), dScale = new Float32Array(deckN), dSeed = new Float32Array(deckN);
  // Clumped into cloud cells with gaps between them; cells nearer the top are bigger, so the gaps
  // close as you climb and the fire below vanishes under the smoke.
  const cells = Array.from({ length: 30 }, () => {
    const a = R() * Math.PI * 2, d = Math.sqrt(R()) * DECK.r;
    return { x: DECK.x + Math.cos(a) * d, z: DECK.z + Math.sin(a) * d, r: 220 + R() * 260 };
  });
  for (let i = 0; i < deckN; i++) {
    const c = cells[i % cells.length];
    const h = Math.pow(R(), 0.75);
    const a = R() * Math.PI * 2, d = Math.sqrt(R()) * c.r * (0.6 + h * 0.9);
    dOff.set([c.x + Math.cos(a) * d, DECK.y0 + (DECK.y1 - DECK.y0) * h, c.z + Math.sin(a) * d], i * 3);
    dScale[i] = (200 + R() * 260) * (0.7 + h * 0.8);
    dSeed[i] = R();
  }
  const quad = new PlaneGeometry(1, 1);
  const deckGeo = new InstancedBufferGeometry();
  deckGeo.index = quad.index;
  deckGeo.setAttribute("position", quad.attributes.position);
  deckGeo.setAttribute("uv", quad.attributes.uv);
  deckGeo.setAttribute("aOff", new InstancedBufferAttribute(dOff, 3));
  deckGeo.setAttribute("aScale", new InstancedBufferAttribute(dScale, 1));
  deckGeo.setAttribute("aSeed", new InstancedBufferAttribute(dSeed, 1));
  deckGeo.instanceCount = deckN;
  const deckU = { uTime: { value: 0 }, uAmt: { value: 0 }, uMap: { value: puffTexture() }, uLo: { value: DECK.y0 }, uHi: { value: DECK.y1 } };
  const deck = new Mesh(deckGeo, new ShaderMaterial({
    transparent: true, depthWrite: false, blending: NormalBlending, uniforms: deckU,
    vertexShader: /* glsl */ `
      uniform float uTime, uLo, uHi; attribute vec3 aOff; attribute float aScale, aSeed;
      varying vec2 vUv; varying float vH; varying float vDepth;
      void main() {
        vec3 o = aOff + vec3(sin(uTime * 0.03 + aSeed * 6.0) * 40.0, 0.0, uTime * 4.0 * (aSeed - 0.3));
        vec4 mv = viewMatrix * vec4(o, 1.0);
        float r = aSeed * 6.28 + uTime * 0.01;
        mv.xy += mat2(cos(r), -sin(r), sin(r), cos(r)) * position.xy * aScale;
        vDepth = -mv.z; vUv = uv; vH = (o.y - uLo) / (uHi - uLo);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap; uniform float uAmt;
      varying vec2 vUv; varying float vH; varying float vDepth;
      void main() {
        float a = texture2D(uMap, vUv).a;
        vec3 top = vec3(0.82, 0.76, 0.69), under = vec3(0.46, 0.38, 0.32);
        vec3 col = mix(under, top, smoothstep(0.0, 1.0, vH * 0.7 + vUv.y * 0.3));
        col += vec3(0.5, 0.18, 0.04) * (1.0 - vH) * (1.0 - vUv.y) * 0.55;    // fire light on the underside
        float fade = smoothstep(18.0, 260.0, vDepth);                        // soft as you fly through
        gl_FragColor = vec4(col, a * uAmt * fade * 1.1);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  }));
  deck.frustumCulled = false;
  deck.renderOrder = 6;
  scene.add(deck);

  // ---------------------------------------------------------------- orbit world
  const earth = buildEarth();

  // ---------------------------------------------------------------- camera path
  const A_LEN = 2450, Z0 = 160;
  const pos = new Vector3(), look = new Vector3(), pos0 = new Vector3(), look0 = new Vector3();
  const sm = (x: number, a: number, b: number) => MathUtils.smoothstep(x, a, b);

  function lowPath(p: number, outPos: Vector3, outLook: Vector3): void {
    const s = Math.min(p, ACTS.sky) / ACTS.sky;
    const z = Z0 - A_LEN * s;
    const lift = sm(p, 0.23, ACTS.sky);
    const y = WATER_Y + 7 + lift * 62;
    outPos.set(riverX(z), y, z);
    const zl = z - 55;
    outLook.set(riverX(zl), y - 2 - lift * 10, zl);
  }

  function cameraAt(p: number): void {
    if (p <= ACTS.sky) { lowPath(p, pos, look); return; }
    lowPath(ACTS.sky, pos0, look0);
    const e = sm(p, ACTS.sky, ACTS.swap + 0.02);
    pos.set(MathUtils.lerp(pos0.x, 260, e), pos0.y + (1750 - pos0.y) * Math.pow(e, 1.7), pos0.z - 1300 * e);
    look.lerpVectors(look0, new Vector3(-250, 0, pos.z - 2300), sm(p, ACTS.sky, ACTS.sky + 0.16));
    // Up through the smoke deck, turning to look down: the land below is always in view, never the
    // horizon or the edge of the world.
    const climb = sm(p, ACTS.haze0, ACTS.swap);
    pos.y += climb * 1750;
    look.lerp(new Vector3(pos.x - 120, 0, pos.z - 650), sm(p, ACTS.haze0 - 0.04, ACTS.haze0 + 0.05));
  }

  // ---------------------------------------------------------------- moods
  const ca = new Color(), cb = new Color();
  const mix = (a: number, b: number, t: number, out: Color) => out.copy(ca.setHex(a)).lerp(cb.setHex(b), t);
  let baseDensity = 0.003;
  function applyMood(p: number): void {
    let i = 0;
    while (i < MOODS.length - 2 && p > MOODS[i + 1].p) i++;
    const a = MOODS[i], b = MOODS[i + 1];
    const t = MathUtils.clamp((p - a.p) / (b.p - a.p), 0, 1);
    const L = (x: number, y: number) => x + (y - x) * t;
    const elev = MathUtils.degToRad(L(a.elev, b.elev)), az = MathUtils.degToRad(200);
    sunDir.set(Math.cos(elev) * Math.sin(az), Math.sin(elev), Math.cos(elev) * Math.cos(az)).normalize();
    skyU.sunPosition.value.copy(sunDir);
    skyU.turbidity.value = L(a.turb, b.turb);
    skyU.rayleigh.value = L(a.ray, b.ray);
    skyU.mieCoefficient.value = L(a.mie, b.mie);
    skyU.mieDirectionalG.value = 0.8;
    renderer.toneMappingExposure = L(a.exp, b.exp);
    mix(a.fog, b.fog, t, fog.color);
    baseDensity = L(a.dens, b.dens);
    mix(a.sun, b.sun, t, sun.color);
    sun.intensity = L(a.sunI, b.sunI);
    mix(a.sky, b.sky, t, hemi.color);
    mix(a.gnd, b.gnd, t, hemi.groundColor);
    hemi.intensity = L(a.hemiI, b.hemiI);
    forest.uniforms.uWind.value = L(a.wind, b.wind);
    forest.water.uSky.value.copy(fog.color).lerp(hemi.color, 0.4);
    forest.water.uSunDir.value.copy(sunDir);
  }

  /** Fire clock (front radius = clock × 30 m from each origin). It creeps while you fly past the first
   *  trees catching (0 → 5 by p 0.40), then races once you are above the canopy (→ 135 at the swap). */
  const fireClock = (p: number) => {
    if (p < ACTS.fire) return 0;
    if (p < 0.4) return 5 * Math.pow((p - ACTS.fire) / (0.4 - ACTS.fire), 1.3);
    return 5 + 68 * Math.pow(Math.min(1, (p - 0.4) / (ACTS.swap - 0.4)), 1.2);
  };

  // ---------------------------------------------------------------- loop
  let target = 0, p = 0, last = performance.now(), time = 0, raf = 0;
  const pointer = { x: 0, y: 0 }, sway = { x: 0, y: 0 };
  let frameCb: (s: FrameState) => void = () => {};
  const fwd = new Vector3(), right = new Vector3(), up = new Vector3(0, 1, 0), tmp = new Vector3();

  function tick(now: number): void {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    time += dt;
    p += (target - p) * Math.min(1, dt * 2.2);
    sway.x += (pointer.x - sway.x) * Math.min(1, dt * 2);
    sway.y += (pointer.y - sway.y) * Math.min(1, dt * 2);

    // The overlay only covers the instant the world swaps; the deck itself does the whiteout.
    const haze = sm(p, ACTS.swap - 0.02, ACTS.swap) * (1 - sm(p, ACTS.swap, ACTS.haze1));

    if (p < ACTS.swap) {
      applyMood(p);
      cameraAt(p);
      // breathing motion of a low flight, and a little look-around with the pointer
      const low = 1 - sm(p, 0.3, 0.5);
      pos.y += Math.sin(time * 0.9) * 0.35 * low;
      fwd.subVectors(look, pos).normalize();
      right.crossVectors(fwd, up).normalize();
      look.addScaledVector(right, sway.x * 8).addScaledVector(up, -sway.y * 4);
      camera.position.copy(pos);
      camera.lookAt(look);
      // bank a little into the river's bends
      tmp.set(riverX(pos.z - 80) - riverX(pos.z - 20), 0, 0);
      camera.rotateZ(MathUtils.clamp(-tmp.x * 0.004, -0.12, 0.12) * low);

      fog.density = baseDensity / (1 + Math.max(0, pos.y - 10) / 28) + sm(p, 0.74, ACTS.swap) * 0.0004;   // thinner as you climb
      forest.uniforms.uTime.value = time;
      forest.uniforms.uFireClock.value = fireClock(p);
      fire.uniforms.uCam.value.copy(pos);
      fire.uniforms.uEmbers.value = sm(p, ACTS.fire + 0.02, 0.34) * (1 - sm(p, 0.48, 0.58));
      sky.position.copy(camera.position);
      smokeDome.position.copy(camera.position);
      smokeU.uAmt.value = Math.max(sm(p, 0.3, 0.42) * (1 - 0.35 * sm(p, 0.5, 0.65)), sm(p, 0.62, 0.7));
      deckU.uTime.value = time;
      deckU.uAmt.value = sm(p, 0.6, 0.7);
      smokeU.uHor.value.copy(fog.color);
      if (shadows) {
        sun.castShadow = pos.y < 160;
        sun.position.copy(pos).addScaledVector(sunDir, 420);
        sun.target.position.copy(pos).addScaledVector(fwd, 70);
      }
      renderer.render(scene, camera);
    } else {
      const t = sm(p, ACTS.swap, ACTS.end);
      earth.setView(t, time);
      renderer.toneMappingExposure = 1.0;
      renderer.render(earth.scene, earth.camera);
    }
    frameCb({ p, haze });
    raf = requestAnimationFrame(tick);
  }

  function resize(): void {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.fov = w < h ? 72 : 60;
    camera.updateProjectionMatrix();
    earth.resize(w, h);
  }
  resize();
  window.addEventListener("resize", resize);
  document.addEventListener("visibilitychange", () => {
    cancelAnimationFrame(raf);
    if (!document.hidden) { last = performance.now(); raf = requestAnimationFrame(tick); }
  });
  raf = requestAnimationFrame(tick);
  if (import.meta.env.DEV) (window as unknown as { __bara: unknown }).__bara = { scene, forest, fire, earth, renderer, camera };

  return {
    setTarget: (v) => { target = MathUtils.clamp(v, 0, 1); },
    onFrame: (f) => { frameCb = f; },
    setPointer: (x, y) => { pointer.x = x; pointer.y = y; },
    setProvinces: (polys) => earth.setProvinces(polys),
    setCells: (cells, g) => earth.setCells(cells, g),
    setFrame: (top, bottom) => earth.setFrame(top, bottom),
  };
}
