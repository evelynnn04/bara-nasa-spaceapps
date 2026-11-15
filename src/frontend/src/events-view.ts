import type { FireEvent } from "./api";
import { badgeText, causeLabel, whySummary, type AttributionInfo, type Cause } from "./attribution";
import { formatDay, toDay } from "./dates";
import { UNIT_SHORT, escapeXml, fmtVal } from "./format";
import type { RegionIndex } from "./regions";
import { openTip } from "./tooltip";

/** What the events card needs besides the events: the disclaimer, source citations and the active cause filter. */
export interface EventsContext {
  disclaimer: string | null;
  sources: AttributionInfo["sources"];
  cause: Cause | null;
}

const NO_CONTEXT: EventsContext = { disclaimer: null, sources: {}, cause: null };

/** "Largest fire events": the biggest events active in the selected period (place, hotspots, dates), each one clickable, with its likely cause. */
export class EventsView {
  private events: FireEvent[] = [];

  constructor(
    private readonly root: HTMLElement,
    private readonly regions: RegionIndex,
    onPick: (e: FireEvent) => void,
  ) {
    root.addEventListener("click", (ev) => {
      const why = (ev.target as Element).closest<HTMLButtonElement>("[data-why]");
      if (why) {
        // Touch screens have no hover, so a tap opens the same card
        openTip(why);
        return;
      }
      const btn = (ev.target as Element).closest<HTMLButtonElement>("[data-event]");
      if (!btn) return;
      const e = this.events.find((x) => x.event === +btn.dataset.event!);
      if (!e) return;
      root.querySelectorAll("[data-event]").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
      onPick(e);
    });
  }

  /** Where an event is: its main city/regency, and its province (empty when there is no city/regency). */
  place(e: FireEvent): { name: string; province: string } {
    const regency = e.regency_id ? this.regions.byId.get(e.regency_id) : undefined;
    const province = e.province_id ? this.regions.byId.get(e.province_id) : undefined;
    if (regency) return { name: regency.name, province: province?.name ?? "" };
    return { name: province?.name ?? `${e.lat.toFixed(2)}°, ${e.lon.toFixed(2)}°`, province: "" };
  }

  render(events: FireEvent[], ctx: EventsContext = NO_CONTEXT): void {
    this.events = events;
    if (!events.length) {
      const what = ctx.cause ? (ctx.cause === "unknown" ? "fire events with an unclear cause" : `${causeLabel(ctx.cause).toLowerCase()} events`) : "fire events";
      this.root.innerHTML = `<p class="reading">No ${what} in this area and period.</p>`;
      return;
    }
    const items = events
      .map((e) => {
        const span = e.start === e.end ? formatDay(toDay(e.start)) : `${formatDay(toDay(e.start))} – ${formatDay(toDay(e.end))}`;
        const place = this.place(e);
        return `<li class="ev-row"><button type="button" class="ev-item" data-event="${e.event}" aria-pressed="false">
          <span class="ev-main"><span class="ev-place">${escapeXml(place.name)}</span>
            ${place.province ? `<span class="mini-note">${escapeXml(place.province)}</span>` : ""}
            <span class="mini-note">${span}</span></span>
          <span class="ev-v">${fmtVal(e.harmonised)}<span class="mini-note">${UNIT_SHORT}</span></span></button>
          ${causeRow(e, ctx.sources)}</li>`;
      })
      .join("");
    const attributed = events.some((e) => e.attribution);
    const disclaimer = attributed && ctx.disclaimer ? `<p class="ev-disclaimer" role="note">${escapeXml(ctx.disclaimer)}</p>` : "";
    this.root.innerHTML = `<ol class="ev-list">${items}</ol>${disclaimer}`;
  }
}

/** The badge under an event, with a "Why" button whose hover card sums up the evidence. */
function causeRow(e: FireEvent, sources: AttributionInfo["sources"]): string {
  const a = e.attribution;
  if (!a) return `<div class="ev-cause is-none"><span class="ev-dot" aria-hidden="true"></span><span>${badgeText(a)}</span></div>`;
  return `<div class="ev-cause" data-cause="${escapeXml(a.category)}"><span class="ev-dot" aria-hidden="true"></span>
      <span class="ev-cause-label">${escapeXml(badgeText(a))}</span>
      <button type="button" class="pill pill-xs ev-why-btn" data-why title="${escapeXml(whySummary(a, sources))}">Why</button></div>`;
}
