/**
 * Sequential ramps for "amount of burning", darkest first. Each step must be brighter than the last, so every ramp
 * also reads by lightness alone. The hues are chosen so each colour-vision type keeps a clear ramp. `forecast` and
 * `forecastInk` colour the forecast part of the timeline in a neutral grey, set apart from the accent of the
 * observed record (for the grey palette, by lightness). `accent` and
 * `accentInk` colour the rest of the dashboard (buttons, highlights, chart lines, area outlines) in the same hue;
 * `alert` marks unusual points in charts and `ref` the median line, each picked to stand out for that vision type.
 */
export const RAMPS = {
  ember: {
    label: "Default",
    hint: "Typical colour vision",
    steps: ["#3a1a10", "#5a2410", "#80300f", "#a8400e", "#cf5a12", "#ef7d26", "#ffa65a", "#ffd39c"],
    forecast: "#9a948f",
    forecastInk: "#d9d4cf",
    accent: "#ff7a2e",
    accentInk: "#ffb27a",
    alert: "#ff6b5e",
    ref: "#9fc7ff",
  },
  cividis: {
    label: "Protanopia & deuteranopia",
    hint: "Red-green colour blindness",
    steps: ["#1b2a4a", "#2b3d63", "#45506e", "#646575", "#857c72", "#a99467", "#d0ae55", "#fbd13c"],
    forecast: "#9a9a9a",
    forecastInk: "#dcdcdc",
    accent: "#d0ae55",
    accentInk: "#fbd13c",
    alert: "#7cb1ff",
    ref: "#e8e2d0",
  },
  rose: {
    label: "Tritanopia",
    hint: "Blue-yellow colour blindness",
    steps: ["#3d1424", "#5e1a34", "#842244", "#a52f55", "#cc5574", "#e57f96", "#f2abbb", "#fbd8e0"],
    forecast: "#9a9a9a",
    forecastInk: "#dcdcdc",
    accent: "#e57f96",
    accentInk: "#f2abbb",
    alert: "#ff3355",
    ref: "#d9d9d9",
  },
  grey: {
    label: "Achromatopsia",
    hint: "No colour vision",
    steps: ["#2c2c2c", "#404040", "#535353", "#646464", "#8f8f8f", "#ababab", "#cbcbcb", "#ececec"],
    forecast: "#6e6e6e",
    forecastInk: "#e0e0e0",
    accent: "#cbcbcb",
    accentInk: "#ececec",
    alert: "#ffffff",
    ref: "#8f8f8f",
  },
} as const;

export type RampName = keyof typeof RAMPS;

/** Page surface the ramps are read against; matches `--surface` in style.css. */
export const SURFACE = "#15100d";
export const INK_DARK = "#140c08";
export const INK_LIGHT = "#f4e7d6";

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of a #rrggbb colour. */
export function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

/** WCAG contrast ratio between two colours. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Text colour that reads best on the given fill. */
export function inkOn(fill: string): string {
  return contrast(fill, INK_DARK) >= contrast(fill, INK_LIGHT) ? INK_DARK : INK_LIGHT;
}

/**
 * Picks the ramp step for a positive count. A square-root scale keeps small fires visible
 * next to extreme months. Zero and missing data are drawn separately, never with the ramp.
 */
export function stepFor(value: number, max: number, steps: number): number {
  if (value <= 0 || max <= 0) return -1;
  const t = Math.sqrt(value / max);
  return Math.min(steps - 1, Math.floor(t * steps));
}

export function colorFor(value: number, max: number, ramp: RampName): string | null {
  const steps = RAMPS[ramp].steps;
  const i = stepFor(value, max, steps.length);
  return i < 0 ? null : steps[i];
}

/** Lower bound of each ramp step, for the legend: whole numbers from a maximum of 10 up, else tenths. */
export function stepBounds(max: number, steps: number): number[] {
  return Array.from({ length: steps }, (_, i) => {
    const b = max * (i / steps) ** 2;
    return max >= 10 ? Math.max(1, Math.ceil(b)) : Math.max(0.1, Math.ceil(b * 10) / 10);
  });
}

/**
 * Lower bounds of `steps` colour classes for skewed values (most map cells are small, a few are
 * very large): quantile breaks, rounded to two significant digits and strictly increasing.
 */
export function quantileBreaks(values: number[], steps: number): number[] {
  const sorted = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (!sorted.length) return [0];
  return breaksFrom(QUANTILES.slice(0, steps - 1).map((q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]), steps);
}

/** Lower bounds of the colour classes of forecast chances, fixed so every lead shares one legend. */
export const CHANCE_BREAKS = [0, 0.02, 0.05, 0.1, 0.2, 0.3, 0.5, 0.7];

/** Quantiles of the colour classes above the first; the backend's `/cells/scale` uses the same ones. */
export const QUANTILES = [0.35, 0.55, 0.7, 0.8, 0.88, 0.94, 0.98, 0.995];

/** Colour class lower bounds from value quantiles at `QUANTILES`, rounded to two significant digits and strictly increasing. */
export function breaksFrom(quantiles: number[], steps: number): number[] {
  const out = [0];
  for (const v of quantiles.slice(0, steps - 1)) {
    if (!(v > 0)) continue;
    const p = 10 ** (Math.floor(Math.log10(v)) - 1);
    const nice = +(Math.round(v / p) * p).toPrecision(2);
    if (nice > out[out.length - 1]) out.push(nice);
  }
  return out;
}

/**
 * CSS custom properties that carry a ramp's accent through the page: the accent and its lighter ink,
 * and the translucent washes, glows and hairlines derived from the accent.
 */
export function accentVars(name: RampName): Record<string, string> {
  const { accent, accentInk, forecast, forecastInk } = RAMPS[name];
  const n = parseInt(accent.slice(1), 16);
  const rgb = `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
  return {
    "--accent": accent,
    "--accent-ink": accentInk,
    "--accent-glow": `rgba(${rgb}, 0.35)`,
    "--accent-wash": `rgba(${rgb}, 0.08)`,
    "--accent-wash-2": `rgba(${rgb}, 0.16)`,
    "--hair": `rgba(${rgb}, 0.2)`,
    "--ember-clear": `rgba(${rgb}, 0)`,
    "--ember-grade": `rgba(${rgb}, 0.05)`,
    "--forecast": forecast,
    "--forecast-ink": forecastInk,
  };
}
