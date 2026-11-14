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

/** Lets every overview card fold to its title. Folded cards are remembered per viewer. */
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
    head.append(btn);
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
    set(folded.has(id));
    btn.addEventListener("click", () => {
      const next = !card.classList.contains("is-folded");
      set(next);
      if (next) folded.add(id);
      else folded.delete(id);
      writeStore(FOLD_KEY, [...folded]);
      setTimeout(onChange, 400);
    });
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
  return {
    left: left ? left.right - stage.left + pad : pad,
    right: right ? stage.right - right.left + pad : pad,
    top: tools ? tools.bottom - stage.top + pad / 2 : pad,
    bottom: pad + 30,
  };
}
