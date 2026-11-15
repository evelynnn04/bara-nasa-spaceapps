import { yearOnYear } from "./analytics";
import { formatRange } from "./dates";
import { escapeXml, fmtPct, fmtVal } from "./format";
import { countUp } from "./fx";
import type { Selection } from "./store";

const UP = `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6"/></svg>`;
const DOWN = `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M6 13l6 6 6-6"/></svg>`;

/**
 * Total for the selected area and dates. For a range shorter than a year it also shows the change
 * from the same dates one year earlier, with an arrow (up means more fire).
 */
export class AnalyticsView {
  constructor(private readonly root: HTMLElement) {}

  render(sel: Selection): void {
    const c = yearOnYear(sel, sel.from, sel.to);
    const shown = c.shorterThanYear && c.change !== null && c.previous !== null;
    const up = (c.change ?? 0) >= 0;
    const delta = shown
      ? `<span class="an-delta ${up ? "is-up" : "is-down"}">${up ? UP : DOWN}${escapeXml(fmtPct(c.change))}</span>`
      : "";
    const note = shown
      ? `<p class="mini-note">vs ${fmtVal(c.previous!)} in ${escapeXml(formatRange(c.previousFrom, c.previousTo))}</p>`
      : "";
    this.root.innerHTML = `
      <p class="tile-label">Total hotspots</p>
      <div class="an-total"><p class="big" data-count></p>${delta}</div>
      ${note}`;
    countUp(this.root.querySelector<HTMLElement>("[data-count]")!, c.total, fmtVal);
  }
}
