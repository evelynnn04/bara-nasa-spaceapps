import type { Insets } from "./map-view";

/** The right-hand card left open, remembered per viewer; `null` when the viewer closed it. */
const OPEN_KEY = "bcal.openCard";
/** Left-hand cards the viewer folded, remembered per viewer. */
const FOLD_KEY = "bcal.folded";
/** Wide screens show the cards one at a time from the side rails; narrower ones stack them all. */
const RAIL_QUERY = "(min-width: 1100px)";

function readStore<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeStore(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage can be unavailable in private windows; the setting just is not remembered */
  }
}

const CHEVRON = `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 14l6-6 6 6"/></svg>`;
const ENLARGE = `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 5h5v5M10 19H5v-5M19 5l-5.5 5.5M5 19l5.5-5.5"/></svg>`;
const CLOSE = `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17"/></svg>`;

/**
 * Adds a header button that opens the card in a centred modal dialog and puts it back on close.
 * The card element itself moves, so its controls and state carry over.
 */
function makeExpandable(card: HTMLElement, head: Element, title: string): void {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "icon-btn expand-btn";
  btn.setAttribute("aria-haspopup", "dialog");
  head.append(btn);
  const dialog = document.createElement("dialog");
  dialog.className = "card-dialog";
  const titleId = card.querySelector(".gc-title")?.id;
  if (titleId) dialog.setAttribute("aria-labelledby", titleId);
  document.body.append(dialog);
  const slot = document.createElement("div");
  slot.className = "gc-slot";
  slot.dataset.card = card.dataset.card;
  slot.setAttribute("aria-hidden", "true");

  const label = (open: boolean) => {
    btn.innerHTML = open ? CLOSE : ENLARGE;
    btn.title = open ? "Close" : "Enlarge";
    btn.setAttribute("aria-label", open ? `Close the larger view of ${title}` : `Open ${title} in a larger view`);
  };
  label(false);

  btn.addEventListener("click", () => {
    if (dialog.open) {
      dialog.close();
      return;
    }
    slot.style.height = `${card.offsetHeight}px`;
    card.replaceWith(slot);
    dialog.append(card);
    card.classList.add("is-expanded");
    label(true);
    dialog.showModal();
    btn.focus();
  });
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close();
  });
  dialog.addEventListener("close", () => {
    card.classList.remove("is-expanded");
    slot.replaceWith(card);
    label(false);
    btn.focus();
  });
}

/** Wraps a card's body in a fold container; returns the wrapper. */
function wrapBody(card: HTMLElement): HTMLElement {
  const body = card.querySelector<HTMLElement>(".gc-body")!;
  const wrap = document.createElement("div");
  wrap.className = "fold is-open";
  const inner = document.createElement("div");
  inner.className = "fold-inner";
  body.replaceWith(wrap);
  inner.append(body);
  wrap.append(inner);
  return wrap;
}

/** Left-hand cards stay in their column; those marked `data-foldable` fold to their title, remembered per viewer. */
function initLeftCards(onChange: () => void): void {
  const folded = new Set(readStore<string[]>(FOLD_KEY, []));
  document.querySelectorAll<HTMLElement>(".g-left .gc[data-card]").forEach((card) => {
    const wrap = wrapBody(card);
    if (!card.hasAttribute("data-foldable")) return;
    const id = card.dataset.card!;
    const title = card.querySelector(".gc-title")?.textContent ?? id;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "icon-btn fold-btn";
    btn.innerHTML = CHEVRON;
    const set = (isFolded: boolean) => {
      card.classList.toggle("is-folded", isFolded);
      wrap.classList.toggle("is-open", !isFolded);
      wrap.inert = isFolded;
      btn.setAttribute("aria-expanded", String(!isFolded));
      btn.setAttribute("aria-label", `${isFolded ? "Expand" : "Fold"} ${title}`);
    };
    set(folded.has(id));
    btn.addEventListener("click", () => {
      const next = !card.classList.contains("is-folded");
      set(next);
      if (next) folded.add(id);
      else folded.delete(id);
      writeStore(FOLD_KEY, [...folded]);
      setTimeout(onChange, 400);
    });
    card.querySelector(".gc-head")!.append(btn);
  });
}

/**
 * Sets up the overview cards. Left-hand cards stay in their column. Right-hand cards open from the
 * icon rail beside the map, one at a time: a rail button opens its card next to the rail (with a
 * pointer to the button); pressing it again, the card's close button or Escape closes it. On narrow
 * screens the rail is hidden and every card is shown in the page. Cards marked `data-expandable` also
 * open in a larger view. `onChange` runs when the free space beside the map changes.
 */
export function initCards(onChange: () => void): void {
  initLeftCards(onChange);
  const cards = [...document.querySelectorAll<HTMLElement>(".g-right .gc[data-card]")];
  const buttons = [...document.querySelectorAll<HTMLButtonElement>(".rail-btn[data-open]")];
  const wide = window.matchMedia(RAIL_QUERY);
  const ids = new Set(cards.map((c) => c.dataset.card!));
  const stored = readStore<string | null>(OPEN_KEY, "calendar");
  let open: string | null = stored && ids.has(stored) ? stored : null;

  cards.forEach((card) => {
    const head = card.querySelector(".gc-head")!;
    const title = card.querySelector(".gc-title")?.textContent ?? card.dataset.card!;
    wrapBody(card);
    const close = document.createElement("button");
    close.type = "button";
    close.className = "icon-btn close-btn";
    close.innerHTML = CLOSE;
    close.title = "Close";
    close.setAttribute("aria-label", `Close ${title}`);
    close.addEventListener("click", () => {
      const from = buttons.find((b) => b.dataset.open === card.dataset.card);
      show(null);
      from?.focus();
    });
    if (card.hasAttribute("data-expandable")) makeExpandable(card, head, title);
    head.append(close);
  });

  /** Points the open card's arrow at the middle of its rail button. */
  function placeArrow(): void {
    const card = cards.find((c) => c.dataset.card === open);
    const btn = buttons.find((b) => b.dataset.open === open);
    if (!card || !btn) return;
    const c = card.getBoundingClientRect();
    const b = btn.getBoundingClientRect();
    const y = Math.max(18, Math.min(c.height - 18, b.top + b.height / 2 - c.top));
    card.style.setProperty("--arrow-y", `${y}px`);
  }

  function show(id: string | null): void {
    open = id;
    for (const card of cards) {
      const on = card.dataset.card === open;
      card.classList.toggle("is-open", on);
      card.inert = wide.matches && !on;
    }
    document.querySelector(".g-right")!.classList.toggle("has-open", open !== null);
    for (const b of buttons) b.setAttribute("aria-expanded", String(b.dataset.open === open));
    writeStore(OPEN_KEY, open);
    placeArrow();
    onChange();
  }

  for (const b of buttons) b.addEventListener("click", () => show(open === b.dataset.open ? null : b.dataset.open!));
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !open || !wide.matches || document.querySelector("dialog[open]")) return;
    const btn = buttons.find((b) => b.dataset.open === open);
    show(null);
    btn?.focus();
  });
  document.querySelector(".g-right")!.addEventListener("scroll", placeArrow, { passive: true });
  window.addEventListener("resize", placeArrow);
  wide.addEventListener("change", () => show(open));
  show(open);
}

/** Map padding that frames the selection in the gap between the floating cards. */
export function measureInsets(): Insets {
  const stage = document.querySelector<HTMLElement>(".g-stage")!.getBoundingClientRect();
  const pad = 36;
  const base = { top: pad, bottom: pad, left: pad, right: pad };
  if (window.innerWidth < 1100) return base;
  const rect = (sel: string) => document.querySelector<HTMLElement>(sel)?.getBoundingClientRect();
  // The open right-hand card covers the map beside the rail; with none open, only the rail does.
  const left = rect(".g-left");
  const right = rect(".g-right.has-open .gc.is-open") ?? rect(".g-rail-right");
  const tools = rect(".g-tools");
  const timeline = rect(".g-time");
  return {
    left: left ? left.right - stage.left + pad : pad,
    right: right ? stage.right - right.left + pad : pad,
    top: tools ? tools.bottom - stage.top + pad / 2 : pad,
    bottom: pad + 30 + (timeline ? stage.bottom - timeline.top : 0),
  };
}
