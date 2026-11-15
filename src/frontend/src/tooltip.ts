/** Wait before a tooltip opens under a resting mouse pointer, so passing over controls does not flash them. */
const HOVER_DELAY = 350;
/** Gap between the tooltip and its element, and the least distance it keeps from the window edges. */
const GAP = 8;
const EDGE = 8;

/**
 * Takes an element's tooltip text and stops the browser's own tooltip from showing: a `title` attribute moves
 * to `data-tip`, and an SVG shape's `<title>` child moves the same way. The text stays available to assistive
 * technology as the element's description (or its name, for an SVG shape that had no other).
 */
function claim(el: Element): string {
  const title = el.getAttribute("title");
  if (title !== null) {
    el.removeAttribute("title");
    if (title) {
      el.setAttribute("data-tip", title);
      if (!el.hasAttribute("aria-label") && !el.hasAttribute("aria-labelledby")) el.setAttribute("aria-description", title);
    } else el.removeAttribute("data-tip");
  }
  const svgTitle = el instanceof SVGElement ? [...el.children].find((c) => c.tagName.toLowerCase() === "title") : undefined;
  if (svgTitle) {
    const text = svgTitle.textContent ?? "";
    svgTitle.remove();
    el.setAttribute("data-tip", text);
    if (!el.hasAttribute("aria-label")) el.setAttribute("aria-label", text);
  }
  return el.getAttribute("data-tip") ?? "";
}

/** Nearest element at or above `target` that carries a tooltip. */
function tipTarget(target: EventTarget | null): Element | null {
  if (!(target instanceof Element)) return null;
  for (let el: Element | null = target; el; el = el.parentElement) {
    if (el.hasAttribute("title") || el.hasAttribute("data-tip")) return el;
    if (el instanceof SVGElement && [...el.children].some((c) => c.tagName.toLowerCase() === "title")) return el;
  }
  return null;
}

/**
 * Replaces the browser's plain tooltips with ones in the app's glass style, matching the dropdown menus. Works for
 * every `title` on the page, including those added or changed later, by event delegation: nothing needs to opt in.
 */
export function initTooltips(): void {
  const tip = document.createElement("div");
  tip.className = "tip";
  tip.setAttribute("role", "tooltip");
  tip.setAttribute("aria-hidden", "true");
  document.body.append(tip);
  let owner: Element | null = null;
  let timer = 0;

  const hide = () => {
    window.clearTimeout(timer);
    owner = null;
    tip.classList.remove("is-open");
  };

  const place = (el: Element) => {
    const r = el.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    const below = r.top - GAP - t.height < EDGE;
    const left = Math.max(EDGE, Math.min(window.innerWidth - EDGE - t.width, r.left + r.width / 2 - t.width / 2));
    const top = below ? r.bottom + GAP : r.top - GAP - t.height;
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
    tip.dataset.side = below ? "below" : "above";
  };

  const show = (el: Element, delay: number) => {
    const text = claim(el);
    window.clearTimeout(timer);
    if (!text) {
      hide();
      return;
    }
    owner = el;
    timer = window.setTimeout(() => {
      if (owner !== el || !el.isConnected) return;
      tip.textContent = text;
      place(el);
      tip.classList.add("is-open");
    }, delay);
  };

  document.addEventListener("pointerover", (e) => {
    const el = tipTarget(e.target);
    if (e.pointerType !== "mouse" || !el) {
      // A title can be added while the pointer rests on its element; claim it so the browser's own does not show
      if (el) claim(el);
      if (owner && !el) hide();
      return;
    }
    if (el === owner) {
      // The text may have changed while the tooltip was open (a play button turning into pause)
      if (el.hasAttribute("title")) show(el, 0);
      return;
    }
    show(el, tip.classList.contains("is-open") ? 0 : HOVER_DELAY);
  });
  document.addEventListener("pointerout", (e) => {
    if (owner && !owner.contains(e.relatedTarget as Node | null)) hide();
  });
  document.addEventListener("focusin", (e) => {
    const el = tipTarget(e.target);
    if (el && (e.target as Element).matches(":focus-visible")) show(el, 0);
  });
  document.addEventListener("focusout", hide);
  document.addEventListener("pointerdown", hide, true);
  document.addEventListener("scroll", hide, true);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && owner) hide();
  });
}
