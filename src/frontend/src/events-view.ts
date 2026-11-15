import type { FireEvent } from "./api";
import { formatDay, toDay } from "./dates";
import { UNIT_SHORT, escapeXml, fmtVal } from "./format";
import type { RegionIndex } from "./regions";

/** "Largest fire events": the biggest events active in the selected period (place, hotspots, dates), each one clickable. */
export class EventsView {
  private events: FireEvent[] = [];

  constructor(
    private readonly root: HTMLElement,
    private readonly regions: RegionIndex,
    onPick: (e: FireEvent) => void,
  ) {
    root.addEventListener("click", (ev) => {
      const btn = (ev.target as Element).closest<HTMLButtonElement>("[data-event]");
      if (!btn) return;
      const e = this.events.find((x) => x.event === +btn.dataset.event!);
      if (!e) return;
      root.querySelectorAll("[data-event]").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
      onPick(e);
    });
  }

  /** Where an event is: its main city/regency and province. */
  place(e: FireEvent): string {
    const regency = e.regency_id ? this.regions.byId.get(e.regency_id) : undefined;
    const province = e.province_id ? this.regions.byId.get(e.province_id) : undefined;
    if (regency && province) return `${regency.name}, ${province.name}`;
    return regency?.name ?? province?.name ?? `${e.lat.toFixed(2)}°, ${e.lon.toFixed(2)}°`;
  }

  render(events: FireEvent[]): void {
    this.events = events;
    if (!events.length) {
      this.root.innerHTML = `<p class="reading">No fire events in this area and period.</p>`;
      return;
    }
    const items = events
      .map((e) => {
        const span = e.start === e.end ? formatDay(toDay(e.start)) : `${formatDay(toDay(e.start))} – ${formatDay(toDay(e.end))}`;
        return `<li><button type="button" class="ev-item" data-event="${e.event}" aria-pressed="false">
          <span class="ev-main"><span class="ev-place">${escapeXml(this.place(e))}</span>
            <span class="mini-note">${span}</span></span>
          <span class="ev-v">${fmtVal(e.harmonised)}<span class="mini-note">${UNIT_SHORT}</span></span></button></li>`;
      })
      .join("");
    this.root.innerHTML = `<ol class="ev-list">${items}</ol>`;
  }
}
