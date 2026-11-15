import type { FireEvent } from "./api";
import { badgeText, causeLabel, evidenceRows, groupIndicators, indicatorState, type Attribution, type AttributionInfo, type Cause } from "./attribution";
import { formatDay, toDay } from "./dates";
import { UNIT_SHORT, escapeXml, fmtInt, fmtVal } from "./format";
import type { RegionIndex } from "./regions";

/** What the events card needs besides the events: the disclaimer, source citations and the active cause filter. */
export interface EventsContext {
  disclaimer: string | null;
  sources: AttributionInfo["sources"];
  cause: Cause | null;
}

const NO_CONTEXT: EventsContext = { disclaimer: null, sources: {}, cause: null };

/** "Largest fire events": the biggest events active in the selected period, each one clickable, with its likely cause. */
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
        const panel = root.querySelector<HTMLElement>(`#${why.getAttribute("aria-controls")}`);
        const open = why.getAttribute("aria-expanded") !== "true";
        why.setAttribute("aria-expanded", String(open));
        if (panel) panel.hidden = !open;
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

  /** Where an event is: its main city/regency and province. */
  place(e: FireEvent): string {
    const regency = e.regency_id ? this.regions.byId.get(e.regency_id) : undefined;
    const province = e.province_id ? this.regions.byId.get(e.province_id) : undefined;
    if (regency && province) return `${regency.name}, ${province.name}`;
    return regency?.name ?? province?.name ?? `${e.lat.toFixed(2)}°, ${e.lon.toFixed(2)}°`;
  }

  render(events: FireEvent[], ctx: EventsContext = NO_CONTEXT): void {
    this.events = events;
    if (!events.length) {
      const what = ctx.cause ? (ctx.cause === "unknown" ? "fire events with an unclear cause" : `${causeLabel(ctx.cause).toLowerCase()} events`) : "fire events";
      this.root.innerHTML = `<p class="reading">No ${what} in this area and period.</p>`;
      return;
    }
    const items = events
      .map((e, i) => {
        const span = e.start === e.end ? formatDay(toDay(e.start)) : `${formatDay(toDay(e.start))} – ${formatDay(toDay(e.end))}`;
        return `<li class="ev-row"><button type="button" class="ev-item" data-event="${e.event}" aria-pressed="false">
          <span class="ev-rank" aria-hidden="true">${i + 1}</span>
          <span class="ev-main"><span class="ev-place">${escapeXml(this.place(e))}</span>
            <span class="mini-note">${span} &middot; ${e.duration_days} day${e.duration_days === 1 ? "" : "s"}, peak ${formatDay(toDay(e.peak_day))}</span>
            <span class="mini-note">${fmtInt(e.cells)} cells &middot; ${fmtInt(e.pixels)} raw hotspots &middot; up to ${fmtInt(e.frp_max)} MW</span></span>
          <span class="ev-v">${fmtVal(e.harmonised)}<span class="mini-note">${UNIT_SHORT}</span></span></button>
          ${causeRow(e, ctx.sources)}</li>`;
      })
      .join("");
    const attributed = events.some((e) => e.attribution);
    const disclaimer = attributed && ctx.disclaimer ? `<p class="ev-disclaimer" role="note">${escapeXml(ctx.disclaimer)}</p>` : "";
    this.root.innerHTML = `<ol class="ev-list">${items}</ol>${disclaimer}
      <p class="mini-note">An event joins burning cells that touch and are active within a day of each other. Its figures cover the whole event, also outside the selected dates, and always count day and night detections. Pick one to frame it on the map.</p>`;
  }
}

/** The badge under an event, with a "Why" button and its drawer when the event has an attribution. */
function causeRow(e: FireEvent, sources: AttributionInfo["sources"]): string {
  const a = e.attribution;
  if (!a) return `<div class="ev-cause is-none"><span class="ev-dot" aria-hidden="true"></span><span>${badgeText(a)}</span></div>`;
  const id = `ev-why-${e.event}`;
  const hint = a.category === "unknown" ? `<span class="mini-note">The evidence does not favour one cause.</span>` : "";
  return `<div class="ev-cause" data-cause="${a.category}"><span class="ev-dot" aria-hidden="true"></span>
      <span class="ev-cause-text"><span class="ev-cause-label">${escapeXml(badgeText(a))}</span>${hint}</span>
      <button type="button" class="pill pill-xs ev-why-btn" data-why aria-expanded="false" aria-controls="${id}">Why<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg></button></div>
    <div class="ev-why" id="${id}" hidden>${whyPanel(a, sources)}</div>`;
}

/** Indicators grouped by cause, the evidence figures and the numbered sources they cite. */
export function whyPanel(a: Attribution, sources: AttributionInfo["sources"]): string {
  const cited: string[] = [];
  const cite = (key: string) => {
    if (!cited.includes(key)) cited.push(key);
    return cited.indexOf(key) + 1;
  };
  const refs = (keys: string[]) => (keys.length ? `<sup class="ev-ref">${keys.map(cite).join(",")}</sup>` : "");
  const groups = groupIndicators(a.indicators)
    .map((g) => {
      const score = a.scores[g.category];
      const items = g.items
        .map((ind) => {
          const st = indicatorState(ind.met);
          const state = ind.met === null ? "na" : ind.met ? "met" : "no";
          return `<li class="ev-ind" data-state="${state}"><span class="ev-mark" aria-hidden="true">${st.mark}</span>
            <span class="ev-ind-text">${escapeXml(ind.text)}${refs(ind.sources)}<span class="visually-hidden"> (${st.word})</span>${ind.met === null ? `<span class="ev-na">data unavailable</span>` : ""}</span>
            <span class="ev-pts">+${ind.points}</span></li>`;
        })
        .join("");
      return `<li class="ev-group" data-cause="${g.category}"><p class="ev-group-head"><span class="ev-dot" aria-hidden="true"></span>${causeLabel(g.category)}${score != null ? `<span class="ev-score">${score} pts</span>` : ""}</p><ul class="ev-inds">${items}</ul></li>`;
    })
    .join("");
  const ev = a.evidence;
  const evSources = [ev.forest_cover_2000?.source, ev.forest_loss?.source, ev.landcover?.source, ev.peat?.source, ev.rainfall?.source, ev.climate?.sources];
  const rows = evidenceRows(ev)
    .map((r, i) => {
      const src = evSources[i];
      const keys = src ? (Array.isArray(src) ? src : [src]) : [];
      return `<dt>${r.label}</dt><dd${r.value === "unavailable" ? ` class="ev-na"` : ""}>${escapeXml(r.value)}${refs(keys)}</dd>`;
    })
    .join("");
  const list = cited
    .map((key) => {
      const s = sources[key];
      const text = escapeXml(s?.citation ?? key);
      return `<li>${s?.url ? `<a href="${escapeXml(s.url)}" target="_blank" rel="noopener">${text}</a>` : text}</li>`;
    })
    .join("");
  return `<p class="ev-why-k">Indicators</p><ul class="ev-groups">${groups}</ul>
    <p class="ev-why-k">Evidence</p><dl class="ev-evidence">${rows}</dl>
    <p class="ev-why-k">Sources</p><ol class="ev-sources">${list}</ol>`;
}
