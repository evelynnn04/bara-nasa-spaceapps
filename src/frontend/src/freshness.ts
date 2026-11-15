import type { Meta } from "./api";

/** How often an open dashboard asks whether the backend has newer data. */
const CHECK_EVERY_MS = 5 * 60_000;

/** Whether the backend's data differs from what the page loaded: tables replaced by an update, or a record ending on another day. */
export function dataChanged(loaded: Meta, now: Meta): boolean {
  return now.record.end !== loaded.record.end || (now.data?.updated ?? null) !== (loaded.data?.updated ?? null);
}

/**
 * Asks the backend every few minutes, while the tab is visible, whether its data changed since
 * `loaded`, and calls `onChange` once with the new description. A failed check is tried again.
 */
export function watchData(fetchMeta: () => Promise<Meta>, loaded: Meta, onChange: (now: Meta) => void, everyMs = CHECK_EVERY_MS): void {
  const timer = setInterval(async () => {
    if (document.visibilityState !== "visible") return;
    try {
      const now = await fetchMeta();
      if (!dataChanged(loaded, now)) return;
      clearInterval(timer);
      onChange(now);
    } catch {
      /* the backend may be restarting; the next round asks again */
    }
  }, everyMs);
}
