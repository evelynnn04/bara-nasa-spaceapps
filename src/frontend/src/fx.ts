/** True when the viewer asked for reduced motion. */
export function reducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Delegated pointer effects: the ripple origin on buttons (`--rx`/`--ry`) and the
 * pointer-following glow on cards (`--mx`/`--my`). Both are decoration only.
 */
export function initFx(): void {
  document.addEventListener("pointerdown", (e) => {
    const btn = (e.target as Element).closest<HTMLElement>(".btn, .pill");
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    btn.style.setProperty("--rx", `${e.clientX - r.left}px`);
    btn.style.setProperty("--ry", `${e.clientY - r.top}px`);
    btn.classList.remove("rippling");
    void btn.offsetWidth;
    btn.classList.add("rippling");
  });
  document.addEventListener("animationend", (e) => {
    if (e.animationName === "ripple") (e.target as Element).closest(".rippling")?.classList.remove("rippling");
  });
  document.addEventListener("pointermove", (e) => {
    const card = (e.target as Element).closest<HTMLElement>(".card");
    if (!card) return;
    const r = card.getBoundingClientRect();
    card.style.setProperty("--mx", `${e.clientX - r.left}px`);
    card.style.setProperty("--my", `${e.clientY - r.top}px`);
  });
}

/** Short ember pulse on a button to confirm an action. Always paired with a text message. */
export function pulse(el: HTMLElement): void {
  el.classList.remove("pulse");
  void el.offsetWidth;
  el.classList.add("pulse");
}

/** Counts a number up to its value in under 0.7 s, ending exactly on the value. */
export function countUp(el: HTMLElement, to: number, format: (n: number) => string): void {
  if (reducedMotion() || !document.body.classList.contains("is-fresh")) {
    el.textContent = format(to);
    return;
  }
  const start = performance.now();
  const dur = 620;
  const tick = (now: number) => {
    const t = Math.min(1, (now - start) / dur);
    const eased = 1 - (1 - t) ** 3;
    el.textContent = format(t < 1 ? to * eased : to);
    if (t < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
