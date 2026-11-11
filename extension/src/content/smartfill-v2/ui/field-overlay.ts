// 逐字段填写浮层：灰色预览 + 单项「填入」+ 批量 + 逐项撤销。
// 只挂一个 Shadow DOM 宿主，不往表单 DOM 插节点；字段位置用 getBoundingClientRect 跟随。
import type { CriticalPlanItem, CriticalSmartFillPlan, ScannedField } from "../core/types.js";
import { readCurrentFieldValue } from "../core/critical-plan.js";

export type FieldFillResult = { ok: boolean; message?: string };

export interface FieldOverlayHandlers {
  onFillField: (item: CriticalPlanItem) => Promise<FieldFillResult>;
  onRestoreField?: (item: CriticalPlanItem, value: string) => Promise<boolean>;
  onClose: () => void;
}

export type FieldSnapshot =
  | { kind: "input"; type: string; value: string; checked: boolean }
  | { kind: "textarea"; value: string }
  | { kind: "select"; value: string; index: number }
  | { kind: "editable"; text: string }
  | { kind: "other"; value: string };

interface ChipView {
  item: CriticalPlanItem;
  el: HTMLDivElement;
  fillBtn: HTMLButtonElement;
  undoBtn: HTMLButtonElement;
  stateEl: HTMLSpanElement;
  filled: boolean;
  manual: boolean;
}

const HOST_ID = "offeru-ext-field-overlay";
const CHIP_WIDTH = 264;

function setNativeValue(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): void {
  const prototype = Object.getPrototypeOf(element);
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  if (setter) setter.call(element, value);
  else element.value = value;
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

function setNativeChecked(element: HTMLInputElement, checked: boolean): void {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "checked")?.set;
  if (setter) setter.call(element, checked);
  else element.checked = checked;
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

export function captureFieldState(field: ScannedField): FieldSnapshot {
  const element = field.element;
  if (element instanceof HTMLInputElement) {
    return { kind: "input", type: element.type, value: element.value, checked: element.checked };
  }
  if (element instanceof HTMLTextAreaElement) {
    return { kind: "textarea", value: element.value };
  }
  if (element instanceof HTMLSelectElement) {
    return { kind: "select", value: element.value, index: element.selectedIndex };
  }
  if (element.isContentEditable) {
    return { kind: "editable", text: element.innerText || element.textContent || "" };
  }
  return { kind: "other", value: readCurrentFieldValue(field) };
}

export function restoreFieldState(field: ScannedField, snapshot: FieldSnapshot): boolean {
  const element = field.element;
  try {
    if (snapshot.kind === "input" && element instanceof HTMLInputElement) {
      setNativeValue(element, snapshot.value);
      if (snapshot.type === "checkbox" || snapshot.type === "radio") {
        setNativeChecked(element, snapshot.checked);
      }
      return true;
    }
    if (snapshot.kind === "textarea" && element instanceof HTMLTextAreaElement) {
      setNativeValue(element, snapshot.value);
      return true;
    }
    if (snapshot.kind === "select" && element instanceof HTMLSelectElement) {
      element.selectedIndex = snapshot.index >= 0 ? snapshot.index : -1;
      element.value = snapshot.value;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }
    if (snapshot.kind === "editable" && element.isContentEditable) {
      element.focus({ preventScroll: true });
      let replaced = false;
      try {
        replaced = document.execCommand("selectAll", false, undefined) && document.execCommand("insertText", false, snapshot.text);
      } catch {
        replaced = false;
      }
      if (!replaced) {
        element.textContent = snapshot.text;
        element.dispatchEvent(new Event("input", { bubbles: true }));
      }
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

function sourceLabel(item: CriticalPlanItem): string {
  if (item.candidate.source === "ai") return "AI";
  if (item.candidate.source === "field-map") return "字段映射";
  return "档案";
}

function previewText(item: CriticalPlanItem): string {
  const value = item.valuePreview || item.candidate.value;
  if (!value) return "（空）";
  return value.length > 34 ? `${value.slice(0, 34)}…` : value;
}

function createChip(item: CriticalPlanItem): ChipView {
  const el = document.createElement("div");
  el.className = "offeru-chip";
  el.dataset.fieldId = item.field.fieldId;

  const main = document.createElement("div");
  main.className = "offeru-chip-main";

  const label = document.createElement("div");
  label.className = "offeru-chip-label";
  label.textContent = item.label || item.field.label || "字段";

  const preview = document.createElement("div");
  preview.className = "offeru-chip-preview";
  const prefix = item.field.controlType === "select" || item.field.controlType === "radio"
    ? "将选择："
    : "将填写：";
  preview.textContent = prefix + previewText(item);

  const source = document.createElement("span");
  source.className = "offeru-chip-source";
  source.textContent = sourceLabel(item);
  preview.appendChild(source);

  main.append(label, preview);

  const fillBtn = document.createElement("button");
  fillBtn.type = "button";
  fillBtn.className = "offeru-chip-fill";
  fillBtn.dataset.action = "fill";
  fillBtn.textContent = "填入";

  const undoBtn = document.createElement("button");
  undoBtn.type = "button";
  undoBtn.className = "offeru-chip-undo";
  undoBtn.dataset.action = "undo";
  undoBtn.textContent = "撤销";
  undoBtn.hidden = true;

  const stateEl = document.createElement("span");
  stateEl.className = "offeru-chip-state";

  el.append(main, fillBtn, undoBtn, stateEl);
  // 预览只是提示；点卡片本身也可以填入，但按钮是主入口。
  el.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (target.closest(".offeru-chip-fill")) return;
    if (target.closest(".offeru-chip-undo")) return;
    fillBtn.click();
  });

  return { item, el, fillBtn, undoBtn, stateEl, filled: false, manual: false };
}

function snapshotValue(snapshot: FieldSnapshot): string {
  if (snapshot.kind === "input" || snapshot.kind === "textarea" || snapshot.kind === "select" || snapshot.kind === "other") {
    return snapshot.value;
  }
  return snapshot.text;
}

export class FieldOverlay {
  private host: HTMLDivElement | null = null;
  private root: ShadowRoot | null = null;
  private plan: CriticalSmartFillPlan | null = null;
  private handlers: FieldOverlayHandlers | null = null;
  private chips = new Map<string, ChipView>();
  private snapshots = new Map<string, FieldSnapshot>();
  private toolbarTitle: HTMLSpanElement | null = null;
  private fillAllBtn: HTMLButtonElement | null = null;
  private undoAllBtn: HTMLButtonElement | null = null;
  private busy = false;
  private rafId = 0;
  private readonly onViewportChange = () => this.schedulePosition();

  isVisible(): boolean {
    return this.host !== null;
  }

  show(plan: CriticalSmartFillPlan, handlers: FieldOverlayHandlers): void {
    this.hide();
    this.plan = plan;
    this.handlers = handlers;

    const host = document.createElement("div");
    host.id = HOST_ID;
    host.style.cssText = [
      "all: initial",
      "position: fixed",
      "inset: 0",
      "z-index: 2147483647",
      "pointer-events: none",
      "display: block",
    ].join(";");
    const root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      :host { all: initial; }
      .offeru-toolbar {
        position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%);
        display: flex; align-items: center; gap: 8px;
        padding: 8px 10px; border: 1px solid #d1d5db; border-radius: 10px;
        background: #ffffff; color: #111827; box-shadow: 0 8px 24px rgba(0,0,0,.14);
        font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
        pointer-events: auto; max-width: calc(100vw - 24px);
      }
      .offeru-toolbar-title { color: #6b7280; white-space: nowrap; }
      .offeru-toolbar button {
        font: inherit; border-radius: 7px; padding: 4px 9px; cursor: pointer;
        border: 1px solid #d1d5db; background: #ffffff; color: #111827;
      }
      .offeru-toolbar button.primary { border-color: #2563eb; background: #2563eb; color: #ffffff; }
      .offeru-toolbar button:disabled { opacity: .45; cursor: default; }
      .offeru-chip {
        position: fixed; left: 0; top: 0; width: ${CHIP_WIDTH}px; box-sizing: border-box;
        display: flex; align-items: flex-start; gap: 8px;
        padding: 8px 9px; border: 1px solid #d1d5db; border-radius: 9px;
        background: #ffffff; color: #111827; box-shadow: 0 6px 18px rgba(0,0,0,.12);
        font: 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
        pointer-events: auto;
      }
      .offeru-chip-main { min-width: 0; flex: 1; }
      .offeru-chip-label { color: #6b7280; font-size: 11px; margin-bottom: 2px; }
      .offeru-chip-preview { color: #111827; overflow-wrap: anywhere; }
      .offeru-chip-source {
        margin-left: 5px; padding: 0 4px; border: 1px solid #e5e7eb; border-radius: 4px;
        color: #9ca3af; font-size: 10px; white-space: nowrap;
      }
      .offeru-chip-fill, .offeru-chip-undo {
        flex: none; font: inherit; font-size: 11px; line-height: 1;
        padding: 5px 7px; border-radius: 6px; cursor: pointer;
      }
      .offeru-chip-fill { border: 1px solid #2563eb; background: #2563eb; color: #ffffff; }
      .offeru-chip-undo { border: 1px solid #d1d5db; background: #ffffff; color: #6b7280; }
      .offeru-chip-fill:disabled, .offeru-chip-undo:disabled { opacity: .45; cursor: default; }
      .offeru-chip-state { flex: none; color: #6b7280; font-size: 11px; max-width: 72px; }
      .offeru-chip.is-filled { border-color: #bbf7d0; }
      .offeru-chip.is-failed { border-color: #fecaca; }
    `;
    root.appendChild(style);

    const toolbar = document.createElement("div");
    toolbar.className = "offeru-toolbar";
    this.toolbarTitle = document.createElement("span");
    this.toolbarTitle.className = "offeru-toolbar-title";
    this.fillAllBtn = document.createElement("button");
    this.fillAllBtn.type = "button";
    this.fillAllBtn.className = "primary";
    this.fillAllBtn.dataset.action = "fill-all";
    this.fillAllBtn.textContent = "填写本页";
    this.undoAllBtn = document.createElement("button");
    this.undoAllBtn.type = "button";
    this.undoAllBtn.dataset.action = "undo-all";
    this.undoAllBtn.textContent = "撤销全部";
    this.undoAllBtn.disabled = true;
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.dataset.action = "close";
    closeBtn.textContent = "关闭";
    toolbar.append(this.toolbarTitle, this.fillAllBtn, this.undoAllBtn, closeBtn);
    root.appendChild(toolbar);

    for (const item of plan.items) {
      const chip = createChip(item);
      const fieldId = item.field.fieldId;
      this.snapshots.set(fieldId, captureFieldState(item.field));
      chip.fillBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        void this.fillOne(item);
      });
      chip.undoBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        if (this.busy) return;
        void this.undoOne(item);
      });
      this.chips.set(fieldId, chip);
      root.appendChild(chip.el);
    }

    this.fillAllBtn.addEventListener("click", () => void this.fillAll());
    this.undoAllBtn.addEventListener("click", () => void this.undoAll());
    closeBtn.addEventListener("click", () => this.handlers?.onClose());

    (document.documentElement || document.body).appendChild(host);
    this.host = host;
    this.root = root;
    this.updateToolbar();
    window.addEventListener("scroll", this.onViewportChange, true);
    window.addEventListener("resize", this.onViewportChange, true);
    this.schedulePosition();
  }

  hide(): void {
    window.removeEventListener("scroll", this.onViewportChange, true);
    window.removeEventListener("resize", this.onViewportChange, true);
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    this.host?.remove();
    this.host = null;
    this.root = null;
    this.plan = null;
    this.handlers = null;
    this.chips.clear();
    this.snapshots.clear();
    this.toolbarTitle = null;
    this.fillAllBtn = null;
    this.undoAllBtn = null;
    this.busy = false;
  }

  private schedulePosition(): void {
    if (!this.host || this.rafId) return;
    if (typeof requestAnimationFrame !== "function") {
      this.position();
      return;
    }
    this.rafId = requestAnimationFrame(() => {
      this.rafId = 0;
      this.position();
    });
  }

  private position(): void {
    if (!this.host) return;
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    for (const chip of this.chips.values()) {
      const element = chip.item.field.element;
      if (!element?.isConnected) {
        chip.el.style.display = "none";
        continue;
      }
      const rect = element.getBoundingClientRect();
      const visible = rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < viewportHeight
        && rect.right > 0 && rect.left < viewportWidth;
      if (!visible) {
        chip.el.style.display = "none";
        continue;
      }
      chip.el.style.display = "flex";
      let left = rect.right + 8;
      if (left + CHIP_WIDTH > viewportWidth - 8) {
        left = rect.left - CHIP_WIDTH - 8;
      }
      left = Math.max(8, Math.min(viewportWidth - CHIP_WIDTH - 8, left));
      const top = Math.max(8, Math.min(viewportHeight - 72, rect.top + Math.min(8, Math.max(0, rect.height / 2 - 14))));
      chip.el.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
    }
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    for (const chip of this.chips.values()) {
      chip.fillBtn.disabled = busy || chip.filled;
      chip.undoBtn.disabled = busy || !chip.filled || chip.manual;
    }
    if (this.fillAllBtn) this.fillAllBtn.disabled = busy;
    if (this.undoAllBtn) {
      this.undoAllBtn.disabled = busy || !Array.from(this.chips.values()).some((chip) => chip.filled);
    }
  }

  private updateToolbar(): void {
    if (!this.toolbarTitle) return;
    const total = this.chips.size;
    const filled = Array.from(this.chips.values()).filter((chip) => chip.filled).length;
    this.toolbarTitle.textContent = filled > 0
      ? `OfferU · 已填 ${filled}/${total} 项`
      : `OfferU · 本页可填 ${total} 项`;
    if (this.undoAllBtn) this.undoAllBtn.disabled = this.busy || filled === 0;
  }

  private async fillOne(item: CriticalPlanItem): Promise<void> {
    if (this.busy) return;
    const chip = this.chips.get(item.field.fieldId);
    if (!chip || chip.filled || !this.handlers) return;
    this.setBusy(true);
    chip.stateEl.textContent = "填写中…";
    try {
      const result = await this.handlers.onFillField(item);
      if (result.ok) {
        chip.filled = true;
        chip.manual = false;
        chip.el.classList.add("is-filled");
        chip.stateEl.textContent = "已填";
        chip.fillBtn.hidden = true;
        chip.undoBtn.hidden = false;
      } else {
        chip.el.classList.add("is-failed");
        chip.stateEl.textContent = result.message || "失败";
      }
    } catch (error) {
      chip.el.classList.add("is-failed");
      chip.stateEl.textContent = error instanceof Error ? error.message : "失败";
    } finally {
      this.setBusy(false);
      this.updateToolbar();
      this.schedulePosition();
    }
  }

  private async fillAll(): Promise<void> {
    if (this.busy || !this.plan) return;
    this.setBusy(true);
    if (this.toolbarTitle) this.toolbarTitle.textContent = `OfferU · 正在填写 0/${this.chips.size}`;
    let done = 0;
    for (const chip of Array.from(this.chips.values())) {
      if (chip.filled) {
        done += 1;
        continue;
      }
      const item = chip.item;
      chip.stateEl.textContent = "填写中…";
      try {
        const result = await this.handlers?.onFillField(item);
        if (result?.ok) {
          chip.filled = true;
          chip.el.classList.add("is-filled");
          chip.stateEl.textContent = "已填";
          chip.fillBtn.hidden = true;
          chip.undoBtn.hidden = false;
        } else {
          chip.el.classList.add("is-failed");
          chip.stateEl.textContent = result?.message || "失败";
        }
      } catch {
        chip.el.classList.add("is-failed");
        chip.stateEl.textContent = "失败";
      }
      done += 1;
      if (this.toolbarTitle) this.toolbarTitle.textContent = `OfferU · 正在填写 ${done}/${this.chips.size}`;
    }
    this.setBusy(false);
    this.updateToolbar();
    this.schedulePosition();
  }

  private async undoOne(item: CriticalPlanItem): Promise<void> {
    const chip = this.chips.get(item.field.fieldId);
    const snapshot = this.snapshots.get(item.field.fieldId);
    if (!chip || !snapshot || !chip.filled || chip.manual) return;
    let restored = restoreFieldState(item.field, snapshot);
    if (!restored && this.handlers?.onRestoreField) {
      restored = await this.handlers.onRestoreField(item, snapshotValue(snapshot));
    }
    if (!restored) {
      chip.manual = true;
      chip.undoBtn.disabled = true;
      chip.stateEl.textContent = "需手动撤销";
      return;
    }
    chip.filled = false;
    chip.manual = false;
    chip.el.classList.remove("is-filled", "is-failed");
    chip.fillBtn.hidden = false;
    chip.undoBtn.hidden = true;
    chip.stateEl.textContent = "";
    this.updateToolbar();
    this.schedulePosition();
  }

  private async undoAll(): Promise<void> {
    if (this.busy) return;
    this.setBusy(true);
    for (const chip of Array.from(this.chips.values())) {
      await this.undoOne(chip.item);
    }
    this.setBusy(false);
    this.updateToolbar();
  }
}
