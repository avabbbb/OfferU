// Searchable combobox/select writing — uses option-picker for dropdown discovery
import type { FrameworkHint } from "../core/types.js";
import { simulateClick, simulateFocus, simulateInput, simulateKeydown, setNativeValue } from "./event-simulator.js";
import { normalizeText } from "../shared/text-utils.js";
import {
  captureOpenDropdownPanels,
  collectDropdownOptions,
  resolveTargetDropdown,
} from "./option-picker.js";
import type { OptionSelectorConfig } from "../ats/adapters/adapter.interface.js";
import { isCascaderField, splitCascadeValue, writeCascader } from "./cascade-writer.js";
import { WRITE } from "../shared/constants.js";

const OPTION_MATCH_CACHE = new Map<string, { value: string; matchType: string; confidence: number }>();

function buildOptionMatchCacheKey(
  candidates: string[],
  resumeValue: string,
  level1Title: string,
  level2Title: string,
): string {
  const sorted = [...candidates].sort().join("|");
  return `${level1Title}::${level2Title}::${resumeValue}::${sorted}`;
}

export async function requestOptionMatch(
  candidates: string[],
  resumeValue: string,
  level1Title: string,
  level2Title: string,
): Promise<{ value: string; matchType: string; confidence: number } | null> {
  const cacheKey = buildOptionMatchCacheKey(candidates, resumeValue, level1Title, level2Title);
  const cached = OPTION_MATCH_CACHE.get(cacheKey);
  if (cached) return cached;

  try {
    const response = await chrome.runtime.sendMessage({
      type: "SMART_FILL_OPTION_MATCH",
      candidates,
      resumeValue,
      level1Title,
      level2Title,
    }) as { ok?: boolean; value?: string; matchType?: string; confidence?: number; error?: string };

    if (response?.ok && response.value) {
      const result = {
        value: response.value,
        matchType: response.matchType || "AI",
        confidence: response.confidence ?? 0.9,
      };
      OPTION_MATCH_CACHE.set(cacheKey, result);
      return result;
    }
  } catch {
    // backend unavailable, fall through to local matching
  }

  return null;
}

// Fallback selectors — used only when option-picker returns no results
const FALLBACK_OPTION_SELECTORS = [
  '[role="option"]', '[role="listitem"]', "li",
  ".ant-select-item-option", ".ant-select-item",
  ".el-select-dropdown__item", ".el-cascader-node__label",
  ".arco-select-option", ".rc-select-item-option",
  ".kuma-select2-option",
  ".ivu-select-item", ".atsx-select-option",
  ".brick-select-option", ".next-select-item",
  ".ud__select__list__item",
  ".semi-select-option", ".t-select__item",
  '[class*="option"]', '[class*="Option"]',
  '[class*="select-item"]', '[class*="dropdown-item"]',
];

const FALLBACK_SEARCH_INPUTS = [
  ".ant-select-selection-search-input", ".ant-select-search__field",
  ".el-select__input", ".el-input__inner",
  ".arco-select-view-search-input", ".rc-select-search__field",
  ".ivu-select-input", ".atsx-select-search input",
  ".brick-select-search input", ".next-select-input",
  ".ud__select-search input",
  "input[type=search]", 'input[role="searchbox"]', 'input[role="combobox"]',
];

export interface OptionMatch {
  text: string;
  element: HTMLElement;
}

export function pickBestSearchOption(options: OptionMatch[], value: string): HTMLElement | null {
  const normalized = normalizeText(value).toLowerCase();
  let best: OptionMatch | null = null;
  let bestScore = 0;

  for (const opt of options) {
    const text = normalizeText(opt.text).toLowerCase();
    if (!text || text === "请选择" || text === "select") continue;

    let score = 0;
    if (text === normalized) score = 120;
    else if (text.startsWith(normalized)) score = 90;
    else if (text.includes(normalized)) score = 70;
    else if (normalized.includes(text)) score = 45;

    if (score > bestScore) {
      bestScore = score;
      best = opt;
    }
  }

  return best?.element || null;
}

export async function writeComboboxValue(
  host: HTMLElement,
  value: string,
  framework: FrameworkHint,
  optionConfig?: OptionSelectorConfig,
  context?: { level1Title?: string; level2Title?: string },
): Promise<boolean> {
  if (!host.isConnected) return false;

  const cascaderConfig = optionConfig?.cascaderConfig;
  if (cascaderConfig && isCascaderField(host, cascaderConfig)) {
    const segments = splitCascadeValue(value);
    if (segments.length > 1) {
      const result = await writeCascader(host, segments, cascaderConfig);
      return result.success;
    }
  }

  const scope = findComboboxScope(host);

  try {
    try { host.scrollIntoView({ block: "center", behavior: "smooth" }); } catch { /* ignore */ }

    const previouslyOpenPanels = captureOpenDropdownPanels(host, optionConfig);
    simulateClick(host);
    await sleep(WRITE.datePanelOpenDelayMs);

    let targetPanel = resolveTargetDropdown(
      host,
      optionConfig,
      previouslyOpenPanels,
      true,
    );
    const collectionOptions = () => ({
      shouldRetry: true,
      portalSnapshotCaptured: true,
      ...(
        targetPanel
          ? { preselectedContainer: targetPanel }
          : { excludePanels: previouslyOpenPanels }
      ),
    });
    let options = await collectDropdownOptions(host, optionConfig, {
      ...collectionOptions(),
    });

    if (options.length === 0 || isOnlyEmptyState(options)) {
      await sleep(WRITE.comboBoxOptionRetryDelayMs);
      targetPanel = resolveTargetDropdown(
        host,
        optionConfig,
        previouslyOpenPanels,
        true,
      );
      options = await collectDropdownOptions(host, optionConfig, {
        ...collectionOptions(),
      });
    }

    if (options.length > 0 && !isOnlyEmptyState(options)) {
      const filtered = options.filter((o) => !isEmptyStateOption(o));
      const result = await selectFromOptions(filtered, host, value, context);
      if (result) return true;
    }

    targetPanel = resolveTargetDropdown(
      host,
      optionConfig,
      previouslyOpenPanels,
      true,
    );
    const searchInput = findSearchInput(scope, optionConfig?.searchInputSelector, targetPanel);
    if (searchInput) {
      simulateClick(host);
      await sleep(WRITE.datePanelOpenDelayMs);

      simulateFocus(searchInput);
      const searchTerm = extractSearchTerm(value);
      setNativeValue(searchInput, searchTerm);
      simulateInput(searchInput, searchTerm);
      await sleep(WRITE.searchInputDelayMs);

      targetPanel = resolveTargetDropdown(
        host,
        optionConfig,
        previouslyOpenPanels,
        true,
      );
      options = await collectDropdownOptions(host, optionConfig, {
        ...collectionOptions(),
      });
      if (options.length === 0 || isOnlyEmptyState(options)) {
        await sleep(WRITE.comboBoxOptionRetryDelayMs);
        targetPanel = resolveTargetDropdown(
          host,
          optionConfig,
          previouslyOpenPanels,
          true,
        );
        options = await collectDropdownOptions(host, optionConfig, {
          ...collectionOptions(),
        });
      }

      if (options.length > 0 && !isOnlyEmptyState(options)) {
        const filtered = options.filter((o) => !isEmptyStateOption(o));
        const result = await selectFromOptions(filtered, host, value, context);
        if (result) return true;
      }
    }

    const fallbackOptions = findVisibleOptionsFallback(scope, targetPanel);
    if (fallbackOptions.length > 0) {
      const result = await selectFromOptions(fallbackOptions, host, value, context);
      if (result) return true;
    }

    return false;
  } catch {
    return false;
  }
}

async function selectFromOptions(
  options: OptionMatch[],
  host: HTMLElement,
  value: string,
  context?: { level1Title?: string; level2Title?: string },
): Promise<boolean> {
  const backendMatch = await tryBackendOptionMatch(options, value, context);
  if (backendMatch) {
    simulateClick(backendMatch);
    await sleep(WRITE.verificationDelayMs);
    simulateKeydown(host, "Enter");
    await sleep(WRITE.verificationDelayMs);
    return true;
  }

  const match = pickBestSearchOption(options, value);
  if (match) {
    simulateClick(match);
    await sleep(WRITE.verificationDelayMs);
    simulateKeydown(host, "Enter");
    await sleep(WRITE.verificationDelayMs);
    return true;
  }

  return false;
}

const EMPTY_STATE_TEXTS = ["暂无数据", "无匹配结果", "没有找到", "no data", "no results", "not found", "暂无选项", "无数据"];

function isEmptyStateOption(opt: OptionMatch): boolean {
  const text = normalizeText(opt.text).toLowerCase();
  return EMPTY_STATE_TEXTS.some((t) => text.includes(t.toLowerCase()));
}

function isOnlyEmptyState(options: OptionMatch[]): boolean {
  if (options.length === 0) return true;
  return options.every((o) => isEmptyStateOption(o));
}

function extractSearchTerm(value: string): string {
  if (value.length <= 2) return value;
  return value.slice(0, Math.min(value.length, 4));
}

export async function tryBackendOptionMatch(
  options: OptionMatch[],
  value: string,
  context?: { level1Title?: string; level2Title?: string },
): Promise<HTMLElement | null> {
  if (!context?.level1Title && !context?.level2Title) {
    const bestLocal = pickBestSearchOption(options, value);
    return bestLocal || null;
  }

  const candidateTexts = options.map((o) => o.text);
  const result = await requestOptionMatch(
    candidateTexts,
    value,
    context?.level1Title || "",
    context?.level2Title || "",
  );
  if (!result || !result.value || result.matchType === "NONE") return null;

  const normalized = normalizeText(result.value).toLowerCase();
  for (const opt of options) {
    if (normalizeText(opt.text).toLowerCase() === normalized) {
      return opt.element;
    }
  }
  for (const opt of options) {
    if (normalizeText(opt.text).toLowerCase().includes(normalized) || normalized.includes(normalizeText(opt.text).toLowerCase())) {
      return opt.element;
    }
  }

  return null;
}

function findComboboxScope(host: HTMLElement): HTMLElement | null {
  return host.closest(
    ".ant-select, .el-select, .arco-select, .kuma-select2,"
    + " [class*=select], [class*=Select], [class*=combobox], [class*=ComboBox],"
    + " [role=combobox]"
  ) as HTMLElement | null;
}

function findSearchInput(
  scope: HTMLElement | null,
  preferredSelector?: string,
  dropdown?: HTMLElement | null,
): HTMLInputElement | null {
  const roots: ParentNode[] = [dropdown, scope].filter(
    (root): root is HTMLElement => root instanceof HTMLElement,
  );
  const selectors = preferredSelector ? [preferredSelector, ...FALLBACK_SEARCH_INPUTS] : FALLBACK_SEARCH_INPUTS;
  for (const selector of selectors) {
    for (const root of roots) {
      try {
        if (
          root instanceof HTMLInputElement
          && root.matches(selector)
          && root.getBoundingClientRect().width > 0
          && root.getBoundingClientRect().height > 0
          && !root.disabled
        ) return root;
        const inputs = root.querySelectorAll(selector);
        for (const input of inputs) {
          const el = input as HTMLInputElement;
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0 && !el.disabled) return el;
        }
      } catch { /* invalid selector */ }
    }
  }
  return null;
}

function findVisibleOptionsFallback(
  scope: HTMLElement | null,
  dropdown?: HTMLElement | null,
): OptionMatch[] {
  const results: OptionMatch[] = [];
  const roots: ParentNode[] = [dropdown || scope].filter(
    (root): root is HTMLElement => root instanceof HTMLElement,
  );
  for (const selector of FALLBACK_OPTION_SELECTORS) {
    for (const root of roots) {
      try {
        const elements = root.querySelectorAll(selector);
        for (const el of elements) {
          const htmlEl = el as HTMLElement;
          const rect = htmlEl.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            const text = htmlEl.textContent?.trim() || "";
            if (text && text.length > 0) results.push({ text, element: htmlEl });
          }
        }
      } catch { /* invalid selector */ }
    }
  }
  const seen = new Set<HTMLElement>();
  return results.filter((r) => {
    if (seen.has(r.element)) return false;
    seen.add(r.element);
    return true;
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const __ComboboxWriterInternals = {
  pickBestSearchOption,
  findVisibleOptionsFallback,
  findSearchInput,
  FALLBACK_OPTION_SELECTORS,
  FALLBACK_SEARCH_INPUTS,
};
