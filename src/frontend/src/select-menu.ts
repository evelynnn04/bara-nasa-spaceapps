import { escapeXml } from "./format";

export interface MenuOption {
  value: string;
  label: string;
  hint?: string;
  /** Extra markup shown before the label, e.g. a colour strip. */
  preview?: string;
}

const CHECK = `<svg class="ico ico-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`;
const CHEVRON = `<svg class="ico ico-sm sm-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>`;

let uid = 0;

/** A single-choice dropdown in the glass style, used instead of a native select so the open list matches the app. */
export class SelectMenu {
  private value: string;
  private active = 0;
  private readonly button: HTMLButtonElement;
  private readonly list: HTMLUListElement;
  private readonly id = `sm${++uid}`;

  constructor(
    private readonly root: HTMLElement,
    label: string,
    private readonly options: MenuOption[],
    value: string,
    private readonly onChange: (value: string) => void,
  ) {
    this.value = value;
    root.classList.add("sm");
    root.innerHTML = `
      <button type="button" class="hf sm-button" aria-haspopup="listbox" aria-expanded="false" aria-controls="${this.id}-list"
        aria-labelledby="${this.id}-k ${this.id}-v">
        <span class="hf-k" id="${this.id}-k">${escapeXml(label)}</span>
        <span class="sm-current"></span>
        ${CHEVRON}
      </button>
      <ul class="sm-list" id="${this.id}-list" role="listbox" tabindex="-1" aria-labelledby="${this.id}-k">
        ${options
          .map(
            (o, i) => `<li class="sm-option" role="option" id="${this.id}-o${i}" data-i="${i}">
              ${o.preview ?? ""}
              <span class="sm-text"><span class="sm-label">${escapeXml(o.label)}</span>${o.hint ? `<span class="sm-hint">${escapeXml(o.hint)}</span>` : ""}</span>
              <span class="sm-check">${CHECK}</span>
            </li>`,
          )
          .join("")}
      </ul>`;
    this.button = root.querySelector(".sm-button")!;
    this.list = root.querySelector(".sm-list")!;
    this.render();

    this.button.addEventListener("click", () => (this.isOpen() ? this.close() : this.open()));
    this.button.addEventListener("keydown", (e) => {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
        e.preventDefault();
        this.open();
      }
    });
    this.list.addEventListener("click", (e) => {
      const li = (e.target as Element).closest<HTMLLIElement>(".sm-option");
      if (li) this.choose(+li.dataset.i!);
    });
    this.list.addEventListener("pointermove", (e) => {
      const li = (e.target as Element).closest<HTMLLIElement>(".sm-option");
      if (li) this.setActive(+li.dataset.i!);
    });
    this.list.addEventListener("keydown", (e) => this.onKey(e));
    document.addEventListener("pointerdown", (e) => {
      if (this.isOpen() && !root.contains(e.target as Node)) this.close(false);
    });
  }

  /** Sets the value without notifying. */
  set(value: string): void {
    this.value = value;
    this.render();
  }

  private index(): number {
    return Math.max(0, this.options.findIndex((o) => o.value === this.value));
  }

  private render(): void {
    const o = this.options[this.index()];
    this.root.querySelector(".sm-current")!.innerHTML = `${o.preview ?? ""}<span id="${this.id}-v" class="sm-value">${escapeXml(o.label)}</span>`;
    this.list.querySelectorAll<HTMLElement>(".sm-option").forEach((li, i) => li.setAttribute("aria-selected", String(i === this.index())));
  }

  private isOpen(): boolean {
    return this.button.getAttribute("aria-expanded") === "true";
  }

  private open(): void {
    this.button.setAttribute("aria-expanded", "true");
    this.root.classList.add("is-open");
    this.setActive(this.index());
    this.list.focus({ preventScroll: true });
  }

  private close(returnFocus = true): void {
    this.button.setAttribute("aria-expanded", "false");
    this.root.classList.remove("is-open");
    if (returnFocus) this.button.focus();
  }

  private setActive(i: number): void {
    this.active = (i + this.options.length) % this.options.length;
    this.list.setAttribute("aria-activedescendant", `${this.id}-o${this.active}`);
    this.list.querySelectorAll<HTMLElement>(".sm-option").forEach((li, j) => li.classList.toggle("is-active", j === this.active));
  }

  private choose(i: number): void {
    const next = this.options[i].value;
    this.close();
    if (next === this.value) return;
    this.value = next;
    this.render();
    this.onChange(next);
  }

  private onKey(e: KeyboardEvent): void {
    const moves: Record<string, number> = { ArrowDown: this.active + 1, ArrowUp: this.active - 1, Home: 0, End: this.options.length - 1 };
    if (e.key in moves) {
      e.preventDefault();
      this.setActive(moves[e.key]);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      this.choose(this.active);
    } else if (e.key === "Escape") {
      e.preventDefault();
      this.close();
    } else if (e.key === "Tab") {
      this.close(false);
    }
  }
}
