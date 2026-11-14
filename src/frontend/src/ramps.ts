/**
 * Sequential ramps for "amount of burning", darkest first. Each step must be brighter than the last, so every ramp
 * also reads by lightness alone. The hues are chosen so each colour-vision type keeps a clear ramp.
 */
export const RAMPS = {
  ember: {
    label: "Default",
    hint: "Typical colour vision",
    steps: ["#3a1a10", "#5a2410", "#80300f", "#a8400e", "#cf5a12", "#ef7d26", "#ffa65a", "#ffd39c"],
  },
  cividis: {
    label: "Protanopia & deuteranopia",
    hint: "Red-green colour blindness",
    steps: ["#1b2a4a", "#2b3d63", "#45506e", "#646575", "#857c72", "#a99467", "#d0ae55", "#fbd13c"],
  },
  rose: {
    label: "Tritanopia",
    hint: "Blue-yellow colour blindness",
    steps: ["#3d1424", "#5e1a34", "#842244", "#a52f55", "#cc5574", "#e57f96", "#f2abbb", "#fbd8e0"],
  },
  grey: {
    label: "Achromatopsia",
    hint: "No colour vision",
    steps: ["#2c2c2c", "#404040", "#535353", "#646464", "#8f8f8f", "#ababab", "#cbcbcb", "#ececec"],
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

/** Lower bound of each ramp step, for the legend. */
export function stepBounds(max: number, steps: number): number[] {
  return Array.from({ length: steps }, (_, i) => Math.max(1, Math.ceil(max * (i / steps) ** 2)));
}
