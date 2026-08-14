// Feishu UD (Unified Design) / Throne Biz specialized writer
import type { ScannedField } from "../../core/types.js";
import { simulateClick, simulateFocus, simulateInput, setNativeValue } from "../event-simulator.js";
import { captureOpenDropdownPanels, collectDropdownOptions } from "../option-picker.js";
import { pickBestSearchOption, tryBackendOptionMatch, requestOptionMatch } from "../combobox-writer.js";
import { normalizeText } from "../../shared/text-utils.js";

const FEISHU_SELECT_ANCESTOR = ".ud__select";
const FEISHU_DATE_INPUT_ANCESTOR = ".ud__picker-dateInput";
const FEISHU_DATE_RANGE_ANCESTOR = ".throne-biz-date-range-picker-input";
const FEISHU_DROPDOWN_VISIBLE = ".ud__select__dropdown:not(.ud__select__dropdown-hidden)";
const FEISHU_TREE_WRAPPER = ".ud__tree, .ud__tree__list";
const FEISHU_TREE_NODE = ".ud__tree__node";
const FEISHU_TREE_TITLE = ".ud__tree__node__label";
const FEISHU_TREE_SWITCHER = ".ud__expandButton, .ud__tree__node__expandIcon";
const FEISHU_OPTION = ".ud__select__list__item";

export async function writeFeishuUDField(field: ScannedField, value: string): Promise<{ handled: boolean; success: boolean }> {
  const el = field.element;

  // 1. Feishu UD Select
  const selectAncestor = el.closest(FEISHU_SELECT_ANCESTOR);
  if (selectAncestor) {
    const success = await writeFeishuSelect(el, value, { level1Title: field.level1Title, level2Title: field.level2Title });
    return { handled: true, success };
  }

  // 2. Feishu UD Date Input
  if (el.closest(FEISHU_DATE_INPUT_ANCESTOR)) {
    const success = await writeFeishuDate(el, value);
    return { handled: true, success };
  }

  // 3. Feishu UD Date Range
  if (el.closest(FEISHU_DATE_RANGE_ANCESTOR)) {
    const success = await writeFeishuDate(el, value);
    return { handled: true, success };
  }

  // 4. Feishu UD Tree Select
  if (el.closest(FEISHU_TREE_WRAPPER)) {
    const success = await writeFeishuTreeSelect(el, value, { level1Title: field.level1Title, level2Title: field.level2Title });
    return { handled: true, success };
  }

  return { handled: false, success: false };
}

async function writeFeishuSelect(host: HTMLElement, value: string, context?: { level1Title?: string; level2Title?: string }): Promise<boolean> {
  try {
    const optionConfig = {
      dropdownSelector: FEISHU_DROPDOWN_VISIBLE,
      optionSelector: FEISHU_OPTION,
    };
    const previouslyOpenPanels = captureOpenDropdownPanels(host, optionConfig);
    simulateClick(host);
    await sleep(120);

    const options = await collectDropdownOptions(host, optionConfig, {
      excludePanels: previouslyOpenPanels,
      portalSnapshotCaptured: true,
    });
    if (options.length > 0) {
      const backendMatch = await tryBackendOptionMatch(options, value, context);
      if (backendMatch) { simulateClick(backendMatch); return true; }
      const match = pickBestSearchOption(options, value);
      if (match) { simulateClick(match); return true; }
    }
    return false;
  } catch { return false; }
}

async function writeFeishuDate(host: HTMLElement, value: string): Promise<boolean> {
  try {
    if (host instanceof HTMLInputElement) {
      simulateFocus(host);
      setNativeValue(host, value);
      simulateInput(host, value);
      await sleep(60);
      if (host.value === value || host.value.includes(value.slice(0, 10))) return true;
    }
    return false;
  } catch { return false; }
}

async function writeFeishuTreeSelect(host: HTMLElement, value: string, context?: { level1Title?: string; level2Title?: string }): Promise<boolean> {
  try {
    const segments = value.split(/[/\\|｜，,\s]+/).map((s) => s.trim()).filter((s) => s.length > 0);
    if (segments.length === 0) return false;

    const wrapper = host.closest(FEISHU_TREE_WRAPPER) || host;
    const target = normalizeText(value);

    for (const segment of segments) {
      const nodes = wrapper.querySelectorAll(FEISHU_TREE_NODE);
      let found = false;
      for (const node of nodes) {
        const titleEl = node.querySelector(FEISHU_TREE_TITLE);
        const titleText = normalizeText(titleEl?.textContent || "");
        if (titleText === target || titleText === normalizeText(segment)) {
          simulateClick((titleEl || node) as HTMLElement);
          found = true;
          break;
        }
        const switcher = node.querySelector(FEISHU_TREE_SWITCHER);
        const isExpanded = node.getAttribute("aria-expanded") === "true";
        if (!isExpanded && switcher) {
          simulateClick(switcher as HTMLElement);
          await sleep(80);
        }
      }
      if (found) break;
    }

    await sleep(80);
    const titles = wrapper.querySelectorAll(FEISHU_TREE_TITLE);
    const titleTexts = Array.from(titles).map((t) => t.textContent?.trim() || "");
    if (context?.level1Title || context?.level2Title) {
      const backendResult = await requestOptionMatchForTree(titleTexts, value, context);
      if (backendResult) {
        for (const t of titles) {
          if (normalizeText(t.textContent || "") === normalizeText(backendResult)) {
            simulateClick(t as HTMLElement);
            return true;
          }
        }
      }
    }
    for (const t of titles) {
      if (normalizeText(t.textContent || "") === target) {
        simulateClick(t as HTMLElement);
        return true;
      }
    }
    return false;
  } catch { return false; }
}

async function requestOptionMatchForTree(
  candidates: string[],
  resumeValue: string,
  context: { level1Title?: string; level2Title?: string },
): Promise<string | null> {
  const result = await requestOptionMatch(
    candidates,
    resumeValue,
    context.level1Title || "",
    context.level2Title || "",
  );
  if (result && result.value && result.matchType !== "NONE") {
    return result.value;
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const __FeishuUDWriterInternals = {
  FEISHU_SELECT_ANCESTOR,
  FEISHU_DATE_INPUT_ANCESTOR,
  FEISHU_DATE_RANGE_ANCESTOR,
  writeFeishuSelect,
  writeFeishuDate,
  writeFeishuTreeSelect,
};
