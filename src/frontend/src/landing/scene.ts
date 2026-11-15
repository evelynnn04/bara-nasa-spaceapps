// The burned-forest backdrop for the landing page: a smouldering horizon, three layers of charred
// trunks, drifting smoke, rising embers and falling ash. The page drives it with setStory(): the
// camera dollies into the forest as the story plays, and each scene sets how hard the fire burns.
// One canvas, no libraries. Paused while the tab is hidden; a single still frame under
// prefers-reduced-motion.

import { rng } from "./world/common";

interface Ember { x: number; y: number; vx: number; vy: number; r: number; life: number; max: number; hue: number; phase: number }
interface Ash { x: number; y: number; vy: number; r: number; spin: number; phase: number }
interface Smoke { x: number; y: number; r: number; vx: number; a: number }
interface Coal { x: number; y: number; r: number; phase: number }

const rand = (a: number, b: number) => a + Math.random() * (b - a);

/** One layer of burnt forest: ground ridge plus trunks, some snapped, with stub branches. */
function drawTreeline(w: number, h: number, opt: { seed: number; base: number; height: number; density: number; fill: string; rim: string }): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;
  const r = rng(opt.seed);
  const groundY = (x: number) => opt.base + Math.sin(x / (w * 0.13) + opt.seed) * h * 0.012 + Math.sin(x / (w * 0.041)) * h * 0.006;

  g.fillStyle = opt.fill;
  g.beginPath();
  g.moveTo(0, h);
  for (let x = 0; x <= w; x += 8) g.lineTo(x, groundY(x));
  g.lineTo(w, h);
  g.closePath();
  g.fill();

  const n = Math.round((w / 1000) * opt.density);
  for (let i = 0; i < n; i++) {
    const x = r() * w;
    const snapped = r() < 0.32;
    const th = opt.height * h * (snapped ? rand(0.25, 0.55) * (0.6 + r() * 0.4) : 0.55 + r() * 0.45);
    const lean = (r() - 0.5) * th * 0.08;
    const bw = Math.max(1.2, (th / h) * 9 * (0.6 + r() * 0.6));
    const y0 = groundY(x) + 2;
    const tipX = x + lean, tipY = y0 - th;

    g.fillStyle = opt.fill;
    g.beginPath();
    g.moveTo(x - bw, y0);
    g.quadraticCurveTo(x - bw * 0.6 + lean * 0.4, y0 - th * 0.5, tipX - bw * 0.15, tipY);
    if (snapped) g.lineTo(tipX + bw * 0.4, tipY + bw * 1.6); // jagged break
    g.lineTo(tipX + bw * 0.15, tipY + (snapped ? bw * 0.5 : 0));
    g.quadraticCurveTo(x + bw * 0.6 + lean * 0.4, y0 - th * 0.5, x + bw, y0);
    g.closePath();
    g.fill();

    // A few broken branch stubs, angled up.
    const stubs = Math.floor(r() * (snapped ? 2 : 5));
    g.strokeStyle = opt.fill;
    g.lineCap = "round";
    for (let k = 0; k < stubs; k++) {
      const t = 0.35 + r() * 0.55;
      const sx = x + lean * t, sy = y0 - th * t;
      const dir = r() < 0.5 ? -1 : 1;
      const len = th * (0.05 + r() * 0.12);
      g.lineWidth = Math.max(0.8, bw * 0.45);
      g.beginPath();
      g.moveTo(sx, sy);
      g.lineTo(sx + dir * len, sy - len * (0.4 + r() * 0.6));
      g.stroke();
    }
    // Lit edge on the side facing the glow.
    if (opt.rim !== "none") {
      g.strokeStyle = opt.rim;
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(x + bw * 0.9, y0 - 2);
      g.quadraticCurveTo(x + bw * 0.5 + lean * 0.4, y0 - th * 0.5, tipX + bw * 0.1, tipY + 2);
      g.stroke();
    }
  }
  return c;
}

export interface SceneControl {
  /** p: story progress 0–1; mood: fire intensity for the current scene (about 0.5–1.3). */
  setStory(p: number, mood: number): void;
}

export function startScene(canvas: HTMLCanvasElement): SceneControl {
  const ctx = canvas.getContext("2d");
  if (!ctx) return { setStory: () => {} };
  let story = 0, mood = 1, moodNow = 1;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  let w = 0, h = 0, dpr = 1;
  let layers: { img: HTMLCanvasElement; depth: number }[] = [];
  let embers: Ember[] = [], ash: Ash[] = [], smoke: Smoke[] = [], coals: Coal[] = [];
  let raf = 0, last = performance.now(), t = 0;

  const spawnEmber = (anywhere: boolean): Ember => ({
    x: rand(-0.05, 1.05) * w,
    y: anywhere ? rand(0.2, 1) * h : h * rand(0.82, 1.02),
    vx: rand(-8, 8), vy: -rand(18, 70), r: rand(0.6, 2.3), life: 0, max: rand(4, 11),
    hue: rand(14, 42), phase: rand(0, Math.PI * 2),
  });

  function build(): void {
    dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    // A background tab can report a 0×0 window; draw at a sane size until the first resize.
    w = window.innerWidth || document.documentElement.clientWidth || 1280;
    h = window.innerHeight || document.documentElement.clientHeight || 800;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);

    const lw = Math.round(w * 1.1), lh = h;
    layers = [
      { img: drawTreeline(lw, lh, { seed: 11, base: lh * 0.74, height: 0.34, density: 70, fill: "#2a1611", rim: "none" }), depth: 0.04 },
      { img: drawTreeline(lw, lh, { seed: 23, base: lh * 0.82, height: 0.46, density: 46, fill: "#140b08", rim: "rgba(255,110,40,0.18)" }), depth: 0.09 },
      { img: drawTreeline(lw, lh, { seed: 37, base: lh * 0.93, height: 0.62, density: 22, fill: "#070504", rim: "rgba(255,120,50,0.28)" }), depth: 0.16 },
    ];
    const count = Math.round(Math.min(170, Math.max(60, w / 8)));
    embers = Array.from({ length: count }, () => spawnEmber(true));
    ash = Array.from({ length: Math.round(count / 4) }, () => ({ x: rand(0, w), y: rand(0, h), vy: rand(6, 18), r: rand(0.8, 2), spin: rand(0.5, 2), phase: rand(0, 6) }));
    smoke = Array.from({ length: 7 }, () => ({ x: rand(0, w), y: rand(h * 0.25, h * 0.75), r: rand(w * 0.18, w * 0.42), vx: rand(3, 10), a: rand(0.05, 0.12) }));
    coals = Array.from({ length: Math.round(w / 40) }, () => ({ x: rand(0, w), y: rand(h * 0.9, h), r: rand(10, 40), phase: rand(0, 6) }));
  }

  function draw(dt: number): void {
    const g = ctx!;
    moodNow += (mood - moodNow) * Math.min(1, dt * 3 || 1); // ease between scene moods
    const flicker = (0.85 + Math.sin(t * 1.7) * 0.06 + Math.sin(t * 4.3) * 0.04) * moodNow;

    // Sky: soot black above, a burning horizon below.
    const sky = g.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, "#0b0908");
    sky.addColorStop(0.45, "#160c09");
    sky.addColorStop(0.72, "#3a140a");
    sky.addColorStop(0.86, "#6e260d");
    sky.addColorStop(1, "#1a0905");
    g.fillStyle = sky;
    g.fillRect(0, 0, w, h);

    const glow = g.createRadialGradient(w * 0.62, h * 0.86, 0, w * 0.62, h * 0.86, w * 0.7);
    glow.addColorStop(0, `rgba(255,120,40,${0.32 * flicker})`);
    glow.addColorStop(0.4, `rgba(200,70,20,${0.14 * flicker})`);
    glow.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = glow;
    g.fillRect(0, 0, w, h);

    // Smoke banks drift right and wrap.
    for (const s of smoke) {
      s.x += s.vx * dt;
      if (s.x - s.r > w) s.x = -s.r;
      const sg = g.createRadialGradient(s.x, s.y, 0, s.x, s.y, s.r);
      sg.addColorStop(0, `rgba(70,48,40,${s.a})`);
      sg.addColorStop(1, "rgba(70,48,40,0)");
      g.fillStyle = sg;
      g.fillRect(s.x - s.r, s.y - s.r, s.r * 2, s.r * 2);
    }

    // Charred trees, far to near. The camera dollies in as the story plays: near layers grow more.
    layers.forEach((l, i) => {
      if (!l.img.width || !l.img.height) return;
      const zoom = 1 + story * l.depth * 2.2;
      const dx = -((w * 0.1) / 2) + Math.sin(t * 0.05 + i) * 4;
      g.save();
      g.translate(w * 0.5, h);
      g.scale(zoom, zoom);
      g.translate(-w * 0.5, -h);
      g.drawImage(l.img, dx, 0, l.img.width, l.img.height);
      g.restore();
      if (i === 0) { // haze between the far and middle layers
        g.fillStyle = `rgba(110,38,13,${0.18 * flicker})`;
        g.fillRect(0, h * 0.6, w, h * 0.4);
      }
    });

    // Smouldering ground.
    g.globalCompositeOperation = "lighter";
    for (const c of coals) {
      const a = 0.12 + 0.1 * Math.sin(t * 2 + c.phase);
      const cg = g.createRadialGradient(c.x, c.y, 0, c.x, c.y, c.r);
      cg.addColorStop(0, `rgba(255,110,30,${a})`);
      cg.addColorStop(1, "rgba(255,80,20,0)");
      g.fillStyle = cg;
      g.fillRect(c.x - c.r, c.y - c.r, c.r * 2, c.r * 2);
    }

    // Embers rise, sway, cool and fade.
    for (let i = 0; i < embers.length; i++) {
      const e = embers[i];
      e.life += dt;
      e.x += (e.vx + Math.sin(t * 1.3 + e.phase) * 14) * dt;
      e.y += e.vy * dt;
      if (e.life > e.max || e.y < -10) { embers[i] = spawnEmber(false); continue; }
      const k = 1 - e.life / e.max;
      const a = Math.min(1, Math.min(1, e.life * 2) * k * (0.6 + 0.4 * Math.sin(t * 9 + e.phase)) * moodNow);
      const light = 50 + 30 * k;
      g.fillStyle = `hsla(${e.hue},100%,${light}%,${a * 0.22})`;
      g.beginPath(); g.arc(e.x, e.y, e.r * 3.2, 0, Math.PI * 2); g.fill();
      g.fillStyle = `hsla(${e.hue + 10},100%,${light + 12}%,${a})`;
      g.beginPath(); g.arc(e.x, e.y, e.r, 0, Math.PI * 2); g.fill();
    }
    g.globalCompositeOperation = "source-over";

    // Ash drifts down.
    g.fillStyle = "rgba(170,160,150,0.35)";
    for (const a of ash) {
      a.y += a.vy * dt;
      a.x += Math.sin(t * a.spin + a.phase) * 10 * dt;
      if (a.y > h + 4) { a.y = -4; a.x = rand(0, w); }
      g.save();
      g.translate(a.x, a.y);
      g.rotate(t * a.spin + a.phase);
      g.fillRect(-a.r, -a.r * 0.4, a.r * 2, a.r * 0.8);
      g.restore();
    }
  }

  function frame(now: number): void {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    t += dt;
    draw(dt);
    raf = requestAnimationFrame(frame);
  }

  function run(): void {
    cancelAnimationFrame(raf);
    if (reduced.matches) { t = 3; draw(0); return; }
    last = performance.now();
    raf = requestAnimationFrame(frame);
  }

  build();
  run();
  let resizeTimer = 0;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => { build(); if (reduced.matches) draw(0); }, 150);
  });
  document.addEventListener("visibilitychange", () => (document.hidden ? cancelAnimationFrame(raf) : run()));
  reduced.addEventListener("change", run);

  return {
    setStory(p: number, m: number): void {
      story = Math.max(0, Math.min(1, p));
      mood = m;
      if (reduced.matches) { moodNow = m; draw(0); } // no loop running: repaint the still frame
    },
  };
}
