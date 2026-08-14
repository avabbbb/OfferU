import type { ScannedField } from "../../core/types.js";
import { simulateClick, simulateFocus, simulateBlur, simulateInput, simulateChange, setNativeValue } from "../event-simulator.js";
import {
  captureOpenDropdownPanels,
  collectDropdownOptions,
  resolveTargetDropdown,
} from "../option-picker.js";
import { pickBestSearchOption, tryBackendOptionMatch } from "../combobox-writer.js";

const MOKA_OPTION_CONTAINER = '[class*="sd-Dropdown-dropdown-"]';
const MOKA_OPTION_ITEM = '[class*="sd-Menu-content-item"]';
const MOKA_SEARCH_INPUT = "[class*='sd-Select'] input, [class*='sd-Search'] input";

export async function writeMokaField(field: ScannedField, value: string): Promise<{ handled: boolean; success: boolean }> {
  const el = field.element;

  const mokaAncestor = el.closest('[class*="apply-block-"]');
  if (!mokaAncestor) return { handled: false, success: false };

  const hasMokaSelect = el.closest('[class*="sd-Dropdown"]')
    || el.closest('[class*="sd-Select"]')
    || el.closest('[class*="sd-Menu"]');

  if (hasMokaSelect) {
    return writeMokaSelect(field, value);
  }

  const hasMokaRichText = el.closest('[class*="sd-RichText"]')
    || el.closest('[class*="sd-Comment"]');

  if (hasMokaRichText) {
    return writeMokaRichText(field, value);
  }

  const isTextarea = el.tagName.toLowerCase() === "textarea";
  const isContentEditable = (el as HTMLElement).contentEditable === "true"
    || el.hasAttribute("contenteditable");

  if ((isTextarea || isContentEditable) && mokaAncestor) {
    return writeMokaText(field, value);
  }

  return { handled: false, success: false };
}

async function writeMokaSelect(field: ScannedField, value: string): Promise<{ handled: boolean; success: boolean }> {
  const el = field.element;
  try {
    try { el.scrollIntoView({ block: "center", behavior: "smooth" }); } catch { /* ignore */ }

    const optionConfig = {
      dropdownSelector: MOKA_OPTION_CONTAINER,
      optionSelector: MOKA_OPTION_ITEM,
    };
    const previouslyOpenPanels = captureOpenDropdownPanels(el, optionConfig);
    simulateClick(el);
    await sleep(150);

    let targetPanel = resolveTargetDropdown(
      el,
      optionConfig,
      previouslyOpenPanels,
      true,
    );
    const collectionOptions = () => ({
      portalSnapshotCaptured: true,
      ...(
        targetPanel
          ? { preselectedContainer: targetPanel }
          : { excludePanels: previouslyOpenPanels }
      ),
    });
    let options = await collectDropdownOptions(el, optionConfig, collectionOptions());

    if (options.length > 0) {
      const result = await matchAndSelectOption(options, el, value, field);
      if (result) return { handled: true, success: true };
    }

    targetPanel = resolveTargetDropdown(
      el,
      optionConfig,
      previouslyOpenPanels,
      true,
    );
    const searchInput = findMokaSearchInput(el, targetPanel);
    if (searchInput) {
      simulateFocus(searchInput);
      setNativeValue(searchInput, value.slice(0, Math.min(value.length, 4)));
      simulateInput(searchInput, value.slice(0, Math.min(value.length, 4)));
      await sleep(200);

      targetPanel = resolveTargetDropdown(
        el,
        optionConfig,
        previouslyOpenPanels,
        true,
      );
      options = await collectDropdownOptions(el, optionConfig, collectionOptions());

      if (options.length > 0) {
        const result = await matchAndSelectOption(options, el, value, field);
        if (result) return { handled: true, success: true };
      }
    }

    return { handled: true, success: false };
  } catch { return { handled: true, success: false }; }
}

async function matchAndSelectOption(
  options: Array<{ text: string; element: HTMLElement }>,
  host: HTMLElement,
  value: string,
  field: ScannedField,
): Promise<boolean> {
  const backendMatch = await tryBackendOptionMatch(options, value, { level1Title: field.level1Title, level2Title: field.level2Title });
  if (backendMatch) { simulateClick(backendMatch); return true; }
  const match = pickBestSearchOption(options, value);
  if (match) { simulateClick(match); return true; }
  return false;
}

function findMokaSearchInput(
  host: HTMLElement,
  dropdown?: HTMLElement | null,
): HTMLInputElement | null {
  const scope = host.closest('[class*="sd-Select"], [class*="sd-Dropdown"]');
  const roots = [dropdown, scope].filter(
    (root): root is HTMLElement => root instanceof HTMLElement,
  );
  for (const root of roots) {
    try {
      const inputs = root.querySelectorAll(MOKA_SEARCH_INPUT);
      for (const input of inputs) {
        const el = input as HTMLInputElement;
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0 && !el.disabled) return el;
      }
    } catch { /* ignore */ }
  }
  return null;
}

async function writeMokaRichText(field: ScannedField, value: string): Promise<{ handled: boolean; success: boolean }> {
  const el = field.element;
  try {
    try { el.scrollIntoView({ block: "center", behavior: "smooth" }); } catch { /* ignore */ }

    const editable = findEditableTarget(el);
    if (!editable) return { handled: true, success: false };

    simulateFocus(editable);
    simulateClick(editable);
    await sleep(50);

    const ok = tryExecCommandInsert(editable, value);
    if (ok) {
      simulateInput(editable, value);
      simulateChange(editable);
      simulateBlur(editable);
      return { handled: true, success: verifyWrittenContent(editable, value) };
    }

    if (/<[a-z][\s\S]*>/i.test(value)) {
      editable.innerHTML = value;
    } else {
      editable.textContent = value;
    }
    simulateInput(editable, value);
    simulateChange(editable);
    simulateBlur(editable);
    return { handled: true, success: verifyWrittenContent(editable, value) };
  } catch { return { handled: true, success: false }; }
}

async function writeMokaText(field: ScannedField, value: string): Promise<{ handled: boolean; success: boolean }> {
  const el = field.element;
  try {
    try { el.scrollIntoView({ block: "center", behavior: "smooth" }); } catch { /* ignore */ }

    simulateFocus(el);
    simulateClick(el);
    await sleep(30);

    const isContentEditable = (el as HTMLElement).contentEditable === "true";

    const ok = tryExecCommandInsert(el, value);
    if (ok) {
      simulateInput(el, value);
      simulateChange(el);
      simulateBlur(el);
      return { handled: true, success: verifyWrittenContent(el, value) };
    }

    if (isContentEditable) {
      el.textContent = value;
    } else {
      setNativeValue(el as HTMLTextAreaElement, value);
    }
    simulateInput(el, value);
    simulateChange(el);
    simulateBlur(el);
    await sleep(30);
    return { handled: true, success: verifyWrittenContent(el, value) };
  } catch { return { handled: true, success: false }; }
}

function findEditableTarget(el: HTMLElement): HTMLElement | null {
  if ((el as HTMLElement).contentEditable === "true") return el;
  const ce = el.querySelector("[contenteditable=true]");
  if (ce instanceof HTMLElement) return ce;
  const ta = el.querySelector("textarea");
  if (ta) return ta;
  const inp = el.querySelector("input:not([type=hidden])");
  if (inp instanceof HTMLInputElement) return inp;
  return el;
}

function tryExecCommandInsert(el: HTMLElement, value: string): boolean {
  try {
    el.focus();
    document.execCommand("selectAll", false);
    const result = document.execCommand("insertText", false, value);
    if (result === false) return false;
    const current = readElementValue(el);
    return current.length > 0 && current.includes(value.slice(0, Math.min(value.length, 3)));
  } catch {
    return false;
  }
}

function verifyWrittenContent(el: HTMLElement, expected: string): boolean {
  const current = readElementValue(el).trim();
  const exp = expected.trim();
  if (!current) return false;
  const prefixLen = Math.min(exp.length, 10);
  if (current.includes(exp.slice(0, prefixLen))) return true;
  if (exp.includes(current.slice(0, prefixLen))) return true;
  return false;
}

function readElementValue(el: HTMLElement): string {
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    return el.value || "";
  }
  return el.textContent || "";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const __MokaWriterInternals = {
  MOKA_OPTION_CONTAINER,
  MOKA_OPTION_ITEM,
  MOKA_SEARCH_INPUT,
  findEditableTarget,
  tryExecCommandInsert,
  verifyWrittenContent,
  readElementValue,
};
