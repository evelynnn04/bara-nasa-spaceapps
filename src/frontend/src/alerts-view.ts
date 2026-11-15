import { escapeXml } from "./format";
import { LEVEL_LABEL, type RegionIndex } from "./regions";
import type { Region } from "./types";

/** Answer of `POST /api/alerts/subscribe`. */
export interface SubscribeResult {
  ok: boolean;
  message: string;
}

/** Regions whose name matches `query` (case-insensitive, any word start), provinces first, at most `limit`. */
export function matchRegions(regions: Region[], query: string, exclude: Set<string>, limit = 8): Region[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const order = { country: 0, province: 1, regency: 2 } as const;
  return regions
    .filter((r) => !exclude.has(r.id) && r.name.toLowerCase().split(/[\s-]+/).some((w) => w.startsWith(q) || r.name.toLowerCase().startsWith(q)))
    .sort((a, b) => order[a.level] - order[b.level] || a.name.localeCompare(b.name))
    .slice(0, limit);
}

/**
 * "Email alerts" dialog: an email address and up to `max` provinces or cities/regencies, sent to the
 * backend, which emails a confirmation link. The hidden `website` field catches form-filling bots.
 */
export class AlertsDialog {
  private chosen: string[] = [];
  private readonly form: HTMLFormElement;
  private readonly email: HTMLInputElement;
  private readonly search: HTMLInputElement;
  private readonly suggestions: HTMLElement;
  private readonly chips: HTMLElement;
  private readonly status: HTMLElement;
  private readonly submit: HTMLButtonElement;

  constructor(
    private readonly dialog: HTMLDialogElement,
    private readonly index: RegionIndex,
    private readonly send: (email: string, regions: string[], website: string) => Promise<SubscribeResult>,
    private readonly max = 10,
  ) {
    this.form = dialog.querySelector("form")!;
    this.email = dialog.querySelector("#alert-email")!;
    this.search = dialog.querySelector("#alert-search")!;
    this.suggestions = dialog.querySelector(".alert-suggest")!;
    this.chips = dialog.querySelector(".alert-chips")!;
    this.status = dialog.querySelector(".alert-status")!;
    this.submit = dialog.querySelector('button[type="submit"]')!;
    dialog.querySelector(".alert-close")!.addEventListener("click", () => dialog.close());
    dialog.addEventListener("click", (e) => {
      if (e.target === dialog) dialog.close();
    });
    this.search.addEventListener("input", () => this.renderSuggestions());
    this.search.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const first = this.suggestions.querySelector<HTMLButtonElement>("[data-id]");
        if (first) this.add(first.dataset.id!);
      }
    });
    this.suggestions.addEventListener("click", (e) => {
      const btn = (e.target as Element).closest<HTMLButtonElement>("[data-id]");
      if (btn) this.add(btn.dataset.id!);
    });
    this.chips.addEventListener("click", (e) => {
      const btn = (e.target as Element).closest<HTMLButtonElement>("[data-remove]");
      if (!btn) return;
      this.chosen = this.chosen.filter((id) => id !== btn.dataset.remove);
      this.renderChips();
    });
    this.form.addEventListener("submit", (e) => {
      e.preventDefault();
      void this.onSubmit();
    });
  }

  /** Opens the dialog with `initial` (the areas selected on the dashboard) as the regions. */
  open(initial: string[]): void {
    this.chosen = initial.filter((id) => this.index.byId.has(id)).slice(0, this.max);
    this.search.value = "";
    this.setStatus("");
    this.renderChips();
    this.renderSuggestions();
    this.dialog.showModal();
    this.email.focus();
  }

  private add(id: string): void {
    if (this.chosen.length >= this.max) {
      this.setStatus(`You can follow up to ${this.max} regions.`, true);
      return;
    }
    if (!this.chosen.includes(id)) this.chosen.push(id);
    this.search.value = "";
    this.renderSuggestions();
    this.renderChips();
    this.search.focus();
  }

  private renderSuggestions(): void {
    const found = matchRegions(this.index.regions, this.search.value, new Set(this.chosen));
    this.suggestions.innerHTML = found
      .map((r) => `<li><button type="button" class="alert-option" data-id="${escapeXml(r.id)}">${escapeXml(r.name)}<span class="chip-level">${LEVEL_LABEL[r.level]}${r.parentId && r.level === "regency" ? `, ${escapeXml(this.index.byId.get(r.parentId)?.name ?? "")}` : ""}</span></button></li>`)
      .join("");
    this.suggestions.hidden = found.length === 0;
  }

  private renderChips(): void {
    this.chips.innerHTML = this.chosen
      .map((id) => {
        const r = this.index.byId.get(id)!;
        return `<li class="chip">${escapeXml(r.name)}<span class="chip-level">${LEVEL_LABEL[r.level]}</span><button type="button" class="chip-x" data-remove="${escapeXml(id)}" aria-label="Remove ${escapeXml(r.name)}">×</button></li>`;
      })
      .join("");
  }

  private setStatus(text: string, error = false): void {
    this.status.textContent = text;
    this.status.classList.toggle("is-error", error);
  }

  private async onSubmit(): Promise<void> {
    if (!this.chosen.length) {
      this.setStatus("Choose at least one region.", true);
      this.search.focus();
      return;
    }
    const website = (this.form.elements.namedItem("website") as HTMLInputElement).value;
    this.submit.disabled = true;
    this.setStatus("Sending…");
    try {
      const r = await this.send(this.email.value.trim(), this.chosen, website);
      this.setStatus(r.message, !r.ok);
    } finally {
      this.submit.disabled = false;
    }
  }
}
