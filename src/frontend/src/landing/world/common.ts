// Shared maths for the landing world: deterministic randomness, value noise, the river that the
// flight follows, the ground height, and the fire's spread. Every function that the shaders also
// need exists twice, here and as GLSL in WORLD_GLSL, and the two must stay identical.

export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash2(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
export function vnoise(x: number, y: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi), c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
export function fbm(x: number, y: number, oct = 4): number {
  let s = 0, a = 0.5, f = 1;
  for (let i = 0; i < oct; i++) { s += a * vnoise(x * f, y * f); f *= 2.03; a *= 0.5; }
  return s;
}

// ---------------------------------------------------------------- the river (world units are metres)

/** Water surface height. */
export const WATER_Y = 2;
/** Half-width of the river channel. */
export const RIVER_HALF = 22;
/** Trees grow from the bank out to this distance from the river; the canopy surface takes over beyond. */
export const FOREST_HALF = 260;

/** Centre line of the river: a meandering x for every z. The low flight follows it. */
export function riverX(z: number): number {
  return 70 * Math.sin(z / 330) + 38 * Math.sin(z / 170 + 1.3) + 14 * Math.sin(z / 83 + 0.4);
}

/** Ground height: rolling lowland hills, carved down into the river channel near the centre line. */
export function groundY(x: number, z: number): number {
  const hills = 70 * fbm(x * 0.0009 + 3.1, z * 0.0009 - 1.7, 4) + 18 * fbm(x * 0.006, z * 0.006, 3) - 30;
  const d = Math.abs(x - riverX(z));
  const bank = Math.min(1, Math.max(0, (d - RIVER_HALF * 0.6) / 90));
  const floodplain = 4.5 + 3 * fbm(x * 0.02, z * 0.02, 2);
  const valley = floodplain + (hills - floodplain) * bank * bank * (3 - 2 * bank);
  return d < RIVER_HALF ? Math.min(valley, WATER_Y - 3 + (d / RIVER_HALF) * 4) : Math.max(valley, WATER_Y + 0.8);
}

// ---------------------------------------------------------------- the fire

/** Ignition points: x, z, and the fire clock at which each one starts. The first is on the river bank
 *  just ahead of where the flight is when the fire act begins. */
export const ORIGINS: [number, number, number][] = [
  [riverX(-1720) + 46, -1720, 0],
  // the rest lie ahead of the climb, where the aerial view looks: several fronts at once
  [-900, -3300, 4],
  [1300, -3900, 7],
  [-400, -4700, 10],
  [1700, -5300, 14],
  [-2000, -2500, 18],
];
/** Metres the fire front advances per unit of fire clock. */
export const SPREAD = 30;

/** Fire clock at which the ground at (x, z) ignites. Uneven on purpose: fronts finger out. */
export function igniteTime(x: number, z: number): number {
  let t = 1e9;
  for (const [ox, oz, off] of ORIGINS) t = Math.min(t, Math.hypot(x - ox, z - oz) / SPREAD + off);
  return t + 3.2 * Math.sin(x * 0.0071 + z * 0.0043) * Math.sin(z * 0.0091 - x * 0.0027) + 1.6 * Math.sin(x * 0.031) * Math.sin(z * 0.027);
}

/** GLSL twins of the functions above, plus noise helpers the shaders share. */
export const WORLD_GLSL = /* glsl */ `
  float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
    float a = h21(i), b = h21(i + vec2(1.0, 0.0)), c = h21(i + vec2(0.0, 1.0)), d = h21(i + vec2(1.0, 1.0));
    return a + (b - a) * u.x + (c - a) * u.y + (a - b - c + d) * u.x * u.y;
  }
  float fbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { s += a * vnoise(p); p *= 2.03; a *= 0.5; } return s; }
  float riverX(float z) { return 70.0 * sin(z / 330.0) + 38.0 * sin(z / 170.0 + 1.3) + 14.0 * sin(z / 83.0 + 0.4); }
  uniform vec3 uOrigins[${ORIGINS.length}];
  float igniteTime(vec2 xz) {
    float t = 1e9;
    for (int i = 0; i < ${ORIGINS.length}; i++) t = min(t, length(xz - uOrigins[i].xy) / ${SPREAD.toFixed(1)} + uOrigins[i].z);
    return t + 3.2 * sin(xz.x * 0.0071 + xz.y * 0.0043) * sin(xz.y * 0.0091 - xz.x * 0.0027) + 1.6 * sin(xz.x * 0.031) * sin(xz.y * 0.027);
  }
`;
