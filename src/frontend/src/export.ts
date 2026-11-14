import { CHART } from "./charts";
import { escapeXml } from "./format";

export type Cell = string | number;

function csvCell(v: Cell): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV with leading `# key,value` rows that record the filters behind the numbers. */
export function toCsv(meta: [string, string][], header: string[], rows: Cell[][]): string {
  const lines = [
    ...meta.map(([k, v]) => `# ${csvCell(k)},${csvCell(v)}`),
    header.map(csvCell).join(","),
    ...rows.map((r) => r.map(csvCell).join(",")),
  ];
  return lines.join("\n") + "\n";
}

function save(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadCsv(name: string, csv: string): void {
  save(name, new Blob([csv], { type: "text/csv;charset=utf-8" }));
}

/** Height of an SVG string when drawn at `width`, from its viewBox. */
export function svgHeight(svg: string, width: number): number {
  const m = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
  return m ? (width * +m[2]) / +m[1] : width / 2;
}

/** Places a chart SVG string at a position inside a larger SVG. */
export function place(svg: string, x: number, y: number, width: number): string {
  return svg.replace(/^<svg /, `<svg x="${x}" y="${y}" height="${svgHeight(svg, width)}" `).replace('width="100%"', `width="${width}"`);
}

/** Wraps content in a dark export frame with a title and a line describing the active filters. */
export function frame(title: string, subtitle: string, body: string, width: number, bodyHeight: number): { svg: string; height: number } {
  const height = bodyHeight + 92;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="${CHART.font}">
  <rect width="100%" height="100%" fill="#120d0b"/>
  <text x="24" y="38" fill="${CHART.ink}" font-size="18" font-weight="700" letter-spacing="1">${escapeXml(title.toUpperCase())}</text>
  <text x="24" y="60" fill="${CHART.ink3}" font-size="12">${escapeXml(subtitle)}</text>
  <g transform="translate(0 76)">${body}</g>
</svg>`;
  return { svg, height };
}

/** Renders an SVG string to a PNG at twice its size and downloads it. */
export async function downloadPng(name: string, svg: string, width: number, height: number): Promise<void> {
  const img = new Image();
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
  try {
    img.src = url;
    await img.decode();
    const scale = 2;
    const canvas = document.createElement("canvas");
    canvas.width = width * scale;
    canvas.height = height * scale;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas is not available");
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/png"));
    if (!blob) throw new Error("Could not encode the PNG");
    save(name, blob);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "all-areas";
}
