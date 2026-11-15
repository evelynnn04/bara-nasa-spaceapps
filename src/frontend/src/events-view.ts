import type { FireEvent } from "./api";
import { formatDay, toDay } from "./dates";
import { UNIT_SHORT, escapeXml, fmtInt, fmtVal } from "./format";
import type { RegionIndex } from "./regions";

/** "Largest fire events": the biggest events active in the selected period, each one clickable. */
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
      .map((e, i) => {
        const span = e.start === e.end ? formatDay(toDay(e.start)) : `${formatDay(toDay(e.start))} – ${formatDay(toDay(e.end))}`;
        return `<li><button type="button" class="ev-item" data-event="${e.event}" aria-pressed="false">
          <span class="ev-rank" aria-hidden="true">${i + 1}</span>
          <span class="ev-main"><span class="ev-place">${escapeXml(this.place(e))}</span>
            <span class="mini-note">${span} &middot; ${e.duration_days} day${e.duration_days === 1 ? "" : "s"}, peak ${formatDay(toDay(e.peak_day))}</span>
            <span class="mini-note">${fmtInt(e.cells)} cells &middot; ${fmtInt(e.pixels)} raw hotspots &middot; up to ${fmtInt(e.frp_max)} MW</span></span>
          <span class="ev-v">${fmtVal(e.harmonised)}<span class="mini-note">${UNIT_SHORT}</span></span></button></li>`;
      })
      .join("");
    this.root.innerHTML = `<ol class="ev-list">${items}</ol>
      <p class="mini-note">An event joins burning cells that touch and are active within a day of each other. Its figures cover the whole event, also outside the selected dates, and always count day and night detections. Pick one to frame it on the map.</p>`;
  }
}
