// Textures painted at start-up on canvases, so the landing page ships no image files: leaf clusters,
// palm fronds, bark, forest-floor litter and a soft smoke puff.

import { CanvasTexture, LinearMipmapLinearFilter, RepeatWrapping, SRGBColorSpace, type Texture } from "three";
import { rng } from "./common";

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return [c, c.getContext("2d")!];
}

function tex(c: HTMLCanvasElement, repeat = false): CanvasTexture {
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 8;
  t.minFilter = LinearMipmapLinearFilter;
  if (repeat) t.wrapS = t.wrapT = RepeatWrapping;
  return t;
}

/** One tropical leaf: a pointed oval with a midrib, filled with a light-to-dark gradient. */
function leaf(g: CanvasRenderingContext2D, x: number, y: number, len: number, wid: number, ang: number, hue: number, sat: number, lit: number): void {
  g.save();
  g.translate(x, y);
  g.rotate(ang);
  const grad = g.createLinearGradient(0, -wid, 0, wid);
  grad.addColorStop(0, `hsl(${hue},${sat}%,${lit + 9}%)`);
  grad.addColorStop(0.5, `hsl(${hue},${sat}%,${lit}%)`);
  grad.addColorStop(1, `hsl(${hue + 4},${sat - 6}%,${lit - 8}%)`);
  g.fillStyle = grad;
  g.beginPath();
  g.moveTo(0, 0);
  g.bezierCurveTo(len * 0.25, -wid, len * 0.7, -wid * 0.9, len, 0);
  g.bezierCurveTo(len * 0.7, wid * 0.9, len * 0.25, wid, 0, 0);
  g.fill();
  g.strokeStyle = `hsla(${hue - 10},${sat}%,${lit + 18}%,0.55)`;
  g.lineWidth = Math.max(1, wid * 0.08);
  g.beginPath();
  g.moveTo(len * 0.04, 0);
  g.lineTo(len * 0.92, 0);
  g.stroke();
  g.restore();
}

/** A dense cluster of broad leaves with alpha, for crown cards. Bright on top, shaded underneath. */
export function leafClusterTexture(seed: number, hueShift = 0): Texture {
  const [c, g] = canvas(512, 512);
  const r = rng(seed);
  for (let i = 0; i < 230; i++) {
    const a = r() * Math.PI * 2, d = Math.sqrt(r()) * 200;
    const x = 256 + Math.cos(a) * d, y = 256 + Math.sin(a) * d * 0.85;
    const shade = (y - 56) / 400;                       // darker towards the bottom of the clump
    const len = 46 + r() * 62;
    leaf(g, x, y, len, len * (0.2 + r() * 0.14), r() * Math.PI * 2,
      88 + hueShift + r() * 28, 40 + r() * 28, 38 - shade * 18 + r() * 12);
  }
  return tex(c);
}

/** A palm frond: a long rachis with drooping leaflets on both sides, along the texture's length. */
export function frondTexture(seed: number): Texture {
  const [c, g] = canvas(256, 1024);
  const r = rng(seed);
  g.strokeStyle = "hsl(70,35%,32%)";
  g.lineWidth = 6;
  g.beginPath();
  g.moveTo(128, 1020);
  g.lineTo(128, 6);
  g.stroke();
  for (let y = 980; y > 20; y -= 11 + r() * 5) {
    const t = 1 - y / 1024;
    const len = 118 * Math.sin(Math.PI * Math.min(1, t * 1.15)) + 10;
    for (const s of [-1, 1]) {
      g.save();
      g.translate(128, y);
      g.rotate(s * (0.95 + r() * 0.25));
      g.strokeStyle = `hsl(${88 + r() * 18},${42 + r() * 16}%,${24 + r() * 14}%)`;
      g.lineWidth = 7 - t * 3;
      g.lineCap = "round";
      g.beginPath();
      g.moveTo(0, 0);
      g.quadraticCurveTo(s * 0, -len * 0.5, 0, -len);
      g.stroke();
      g.restore();
    }
  }
  return tex(c);
}

/** A fern clump: fronds of small paired leaflets fanning out from the base. */
export function fernTexture(seed: number): Texture {
  const [c, g] = canvas(512, 512);
  const r = rng(seed);
  for (let f = 0; f < 11; f++) {
    const a = -Math.PI / 2 + (r() - 0.5) * 2.4;
    const len = 170 + r() * 80;
    const hue = 86 + r() * 22, lit = 22 + r() * 16;
    g.save();
    g.translate(256, 500);
    g.rotate(a + Math.PI / 2);
    g.strokeStyle = `hsl(${hue},40%,${lit - 6}%)`;
    g.lineWidth = 3;
    g.beginPath(); g.moveTo(0, 0); g.quadraticCurveTo(14, -len * 0.5, 4, -len); g.stroke();
    for (let y = 18; y < len; y += 9) {
      const w = 34 * Math.sin(Math.PI * (y / len)) + 4;
      for (const s of [-1, 1]) {
        g.fillStyle = `hsl(${hue + r() * 8},${45 + r() * 15}%,${lit + r() * 10}%)`;
        g.beginPath();
        g.ellipse(s * w * 0.5 + 4 * (y / len), -y, w * 0.5, 3.5, s * 0.35, 0, Math.PI * 2);
        g.fill();
      }
    }
    g.restore();
  }
  return tex(c);
}

/** Bark: vertical fissures and lichen patches, tiling. */
export function barkTexture(): Texture {
  const [c, g] = canvas(256, 512);
  const r = rng(11);
  g.fillStyle = "#5a5046";
  g.fillRect(0, 0, 256, 512);
  for (let i = 0; i < 900; i++) {
    const x = r() * 256, y = r() * 512, h = 20 + r() * 90;
    g.fillStyle = `hsla(${25 + r() * 15},${10 + r() * 15}%,${18 + r() * 30}%,${0.25 + r() * 0.4})`;
    g.fillRect(x, y, 1 + r() * 3, h);
  }
  for (let i = 0; i < 60; i++) {
    g.fillStyle = `hsla(${70 + r() * 40},20%,${45 + r() * 15}%,0.18)`;
    g.beginPath();
    g.ellipse(r() * 256, r() * 512, 6 + r() * 20, 4 + r() * 14, 0, 0, Math.PI * 2);
    g.fill();
  }
  return tex(c, true);
}

/** Forest floor: soil, fallen leaves and moss, tiling. */
export function groundTexture(): Texture {
  const [c, g] = canvas(512, 512);
  const r = rng(5);
  g.fillStyle = "#3b3122";
  g.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 2600; i++) {
    const x = r() * 512, y = r() * 512, s = 2 + r() * 9;
    const kind = r();
    g.fillStyle = kind < 0.45 ? `hsla(${28 + r() * 18},${35 + r() * 25}%,${18 + r() * 18}%,0.8)`   // dead leaves
      : kind < 0.8 ? `hsla(${80 + r() * 30},${30 + r() * 20}%,${16 + r() * 14}%,0.7)`               // moss
        : `hsla(30,15%,${12 + r() * 10}%,0.8)`;                                                   // soil
    g.beginPath();
    g.ellipse(x, y, s, s * (0.4 + r() * 0.5), r() * 3.14, 0, Math.PI * 2);
    g.fill();
  }
  return tex(c, true);
}

/** Soft, lumpy smoke puff (white; tinted in the shader). */
export function puffTexture(): Texture {
  const [c, g] = canvas(256, 256);
  const r = rng(7);
  for (let i = 0; i < 40; i++) {
    const x = 128 + (r() - 0.5) * 110, y = 128 + (r() - 0.5) * 110, rad = 30 + r() * 70;
    const grad = g.createRadialGradient(x, y, 0, x, y, rad);
    grad.addColorStop(0, `rgba(255,255,255,${0.1 + r() * 0.1})`);
    grad.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 256, 256);
  }
  return tex(c);
}
