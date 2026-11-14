import { LEVEL_LABEL, type RegionIndex } from "./regions";
import { escapeXml } from "./format";
import type { Region } from "./types";

/**
 * Multi-select checkbox dropdown over the country, province and city/regency tree.
 * Checking a parent includes all its children; partly selected parents show as indeterminate.
 */
export class AreaPicker {
  private selected = new Set<string>();
  private expanded = new Set<string>();
  private query = "";
  private disabledLabel: string | null = null;
  private readonly trigger: HTMLButtonElement;
  private readonly pop: HTMLElement;
  private readonly tree: HTMLElement;
  private readonly chips: HTMLElement;
  private readonly search: HTMLInputElement;

  constructor(root: HTMLElement, private readonly index: RegionIndex, private readonly onChange: (ids: string[]) => void) {
    root.innerHTML = `
      <button type="button" class="btn area-trigger" aria-expanded="false" aria-controls="area-pop">
        <span class="area-trigger-label"></span><span class="chev" aria-hidden="true"></span>
      </button>
      <div class="area-pop fold" id="area-pop" inert>
        <div class="fold-inner">
          <label class="visually-hidden" for="area-search">Search areas</label>
          <input id="area-search" class="input" type="search" placeholder="Search country, province or city" autocomplete="off" />
          <div class="area-tree" role="group" aria-label="Areas"></div>
          <div class="area-foot">
            <button type="button" class="pill" data-act="clear">Clear</button>
            <button type="button" class="pill is-primary" data-act="done">Done</button>
          </div>
        </div>
      </div>
      <ul class="chips" aria-label="Selected areas"></ul>`;
    this.trigger = root.querySelector(".area-trigger")!;
    this.pop = root.querySelector(".area-pop")!;
    this.tree = root.querySelector(".area-tree")!;
    this.chips = root.querySelector(".chips")!;
    this.search = root.querySelector("#area-search")!;
    for (const r of index.roots) this.expanded.add(r.id);

    this.trigger.addEventListener("click", () => this.toggle());
    this.search.addEventListener("input", () => {
      this.query = this.search.value.trim().toLowerCase();
      this.renderTree();
    });
    document.addEventListener("pointerdown", (e) => {
      if (this.isOpen() && !root.contains(e.target as Node)) this.toggle(false);
    });
    root.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.isOpen()) {
        this.toggle(false);
        this.trigger.focus();
      }
    });
    root.querySelector('[data-act="clear"]')!.addEventListener("click", () => this.apply([]));
    root.querySelector('[data-act="done"]')!.addEventListener("click", () => {
      this.toggle(false);
      this.trigger.focus();
    });
    this.tree.addEventListener("change", (e) => {
      const box = e.target as HTMLInputElement;
      const id = box.dataset.id;
      if (!id) return;
      const next = new Set(this.selected);
      if (box.checked) {
        next.add(id);
        for (const d of this.descendants(id)) next.delete(d.id);
      } else next.delete(id);
      this.apply([...next]);
    });
    this.tree.addEventListener("click", (e) => {
      const btn = (e.target as Element).closest<HTMLButtonElement>("[data-expand]");
      if (!btn) return;
      const id = btn.dataset.expand!;
      if (this.expanded.has(id)) this.expanded.delete(id);
      else this.expanded.add(id);
      this.renderTree();
      this.tree.querySelector<HTMLButtonElement>(`[data-expand="${id}"]`)?.focus();
    });
    this.chips.addEventListener("click", (e) => {
      const btn = (e.target as Element).closest<HTMLButtonElement>("[data-remove]");
      if (btn) this.apply([...this.selected].filter((id) => id !== btn.dataset.remove));
    });
  }

  /** Sets the selection without notifying. */
  set(ids: string[]): void {
    this.selected = new Set(this.index.normalise(ids));
    this.render();
  }

  private apply(ids: string[]): void {
    this.set(ids);
    this.onChange([...this.selected]);
  }

  /** Disables the dropdown in place (keeping its slot in the header) and shows `label` instead of the selection. */
  setDisabled(disabled: boolean, label: string): void {
    if (disabled && this.isOpen()) this.toggle(false);
    this.trigger.disabled = disabled;
    this.disabledLabel = disabled ? label : null;
    this.render();
  }

  private isOpen(): boolean {
    return this.trigger.getAttribute("aria-expanded") === "true";
  }

  private toggle(open = !this.isOpen()): void {
    this.trigger.setAttribute("aria-expanded", String(open));
    this.pop.classList.toggle("is-open", open);
    this.pop.inert = !open;
    if (open) this.search.focus();
  }

  private descendants(id: string): Region[] {
    const out: Region[] = [];
    const walk = (pid: string) => {
      for (const c of this.index.children.get(pid) ?? []) {
        out.push(c);
        walk(c.id);
      }
    };
    walk(id);
    return out;
  }

  private matches(r: Region): boolean {
    if (!this.query) return true;
    return r.name.toLowerCase().includes(this.query) || this.descendants(r.id).some((d) => d.name.toLowerCase().includes(this.query));
  }

  private render(): void {
    this.trigger.querySelector(".area-trigger-label")!.textContent = this.disabledLabel ?? this.index.label([...this.selected]);
    this.chips.innerHTML = [...this.selected]
      .map((id) => {
        const r = this.index.byId.get(id)!;
        return `<li class="chip"><span><span class="chip-level">${LEVEL_LABEL[r.level]}</span> ${escapeXml(r.name)}</span>
          <button type="button" class="chip-x" data-remove="${id}" aria-label="Remove ${escapeXml(r.name)}">&times;</button></li>`;
      })
      .join("");
    this.renderTree();
  }

  private renderTree(): void {
    const rows: string[] = [];
    const walk = (list: Region[], depth: number, inheritedFrom: Region | null) => {
      for (const r of list) {
        if (!this.matches(r)) continue;
        const kids = this.index.children.get(r.id) ?? [];
        const open = this.query ? true : this.expanded.has(r.id);
        const own = this.selected.has(r.id);
        const partial = !own && !inheritedFrom && this.descendants(r.id).some((d) => this.selected.has(d.id));
        const checked = own || inheritedFrom !== null;
        const note = inheritedFrom ? ` title="Included in ${escapeXml(inheritedFrom.name)}"` : "";
        rows.push(`<div class="area-row" style="--depth:${depth}"${note}>
          ${kids.length ? `<button type="button" class="tree-toggle" data-expand="${r.id}" aria-expanded="${open}" aria-label="${open ? "Collapse" : "Expand"} ${escapeXml(r.name)}"><span class="chev" aria-hidden="true"></span></button>` : `<span class="tree-spacer"></span>`}
          <label class="check">
            <input type="checkbox" data-id="${r.id}" ${checked ? "checked" : ""} ${inheritedFrom ? "disabled" : ""} ${partial ? 'data-partial="1"' : ""} />
            <span class="check-name">${escapeXml(r.name)}</span>
          </label>
        </div>`);
        if (kids.length && open) walk(kids, depth + 1, own ? r : inheritedFrom);
      }
    };
    walk(this.index.roots, 0, null);
    this.tree.innerHTML = rows.join("") || `<p class="hint">No area matches "${escapeXml(this.query)}".</p>`;
    this.tree.querySelectorAll<HTMLInputElement>("[data-partial]").forEach((b) => (b.indeterminate = true));
  }
}
