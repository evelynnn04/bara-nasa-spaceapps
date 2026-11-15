import type { Insets } from "./map-view";

const FOLD_KEY = "bcal.folded";

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
 * The card element itself moves, so its controls and state carry over. `unfold` opens a folded card first.
 */
function makeExpandable(card: HTMLElement, head: Element, title: string, unfold: () => void): void {
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
    unfold();
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

/**
 * Lets every overview card fold to its title, and cards marked `data-expandable` open in a larger view.
 * Folded cards are remembered per viewer.
 */
export function initCards(onChange: () => void): void {
  const folded = new Set(readStore<string[]>(FOLD_KEY, []));
  document.querySelectorAll<HTMLElement>(".gc[data-card]").forEach((card) => {
    const id = card.dataset.card!;
    const head = card.querySelector(".gc-head")!;
    const body = card.querySelector<HTMLElement>(".gc-body")!;
    const title = card.querySelector(".gc-title")?.textContent ?? id;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "icon-btn fold-btn";
    btn.innerHTML = CHEVRON;
    const wrap = document.createElement("div");
    wrap.className = "fold is-open";
    const inner = document.createElement("div");
    inner.className = "fold-inner";
    body.replaceWith(wrap);
    inner.append(body);
    wrap.append(inner);
    const set = (isFolded: boolean) => {
      card.classList.toggle("is-folded", isFolded);
      wrap.classList.toggle("is-open", !isFolded);
      wrap.inert = isFolded;
      btn.setAttribute("aria-expanded", String(!isFolded));
      btn.setAttribute("aria-label", `${isFolded ? "Expand" : "Fold"} ${title}`);
    };
    const fold = (next: boolean) => {
      set(next);
      if (next) folded.add(id);
      else folded.delete(id);
      writeStore(FOLD_KEY, [...folded]);
      setTimeout(onChange, 400);
    };
    set(folded.has(id));
    btn.addEventListener("click", () => fold(!card.classList.contains("is-folded")));
    if (card.hasAttribute("data-expandable")) makeExpandable(card, head, title, () => card.classList.contains("is-folded") && fold(false));
    head.append(btn);
  });
}

/** Map padding that frames the selection in the gap between the floating cards. */
export function measureInsets(): Insets {
  const stage = document.querySelector<HTMLElement>(".g-stage")!.getBoundingClientRect();
  const pad = 36;
  const base = { top: pad, bottom: pad, left: pad, right: pad };
  if (window.innerWidth < 1100) return base;
  const rect = (sel: string) => document.querySelector<HTMLElement>(sel)?.getBoundingClientRect();
  const left = rect(".g-left");
  const right = rect(".g-right");
  const tools = rect(".g-tools");
  const timeline = rect(".g-time");
  return {
    left: left ? left.right - stage.left + pad : pad,
    right: right ? stage.right - right.left + pad : pad,
    top: tools ? tools.bottom - stage.top + pad / 2 : pad,
    bottom: pad + 30 + (timeline ? stage.bottom - timeline.top : 0),
  };
}
