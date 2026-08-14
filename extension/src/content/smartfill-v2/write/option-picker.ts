// Configuration-driven dropdown option collector
// Layer 1: resolveOptionConfig — framework-aware selector config resolver
// Layer 2: collectDropdownOptions — framework-branching option collector with MutationObserver

import type { FrameworkHint } from "../core/types.js";
import type { OptionSelectorConfig } from "../ats/adapters/adapter.interface.js";
import { detectFrameworkHint } from "../scan/complex-control-detector.js";
import { normalizeText } from "../shared/text-utils.js";

export interface DropdownOption {
  text: string;
  element: HTMLElement;
}

export interface ResolvedOptionConfig {
  optionContainerSelector: string;
  optionSelector: string;
  searchInputSelector?: string;
}

// ===== Layer 1: Framework-Aware Config Resolver =====

export function resolveOptionConfig(
  element: HTMLElement,
  adapterConfig?: OptionSelectorConfig,
): ResolvedOptionConfig | null {
  // 1. Adapter-provided config takes priority
  if (adapterConfig?.dropdownSelector && adapterConfig?.optionSelector) {
    return {
      optionContainerSelector: adapterConfig.dropdownSelector,
      optionSelector: adapterConfig.optionSelector,
      searchInputSelector: adapterConfig.searchInputSelector,
    };
  }

  // 2. Framework detection — use framework-specific selectors
  const framework = detectFrameworkHint(element);

  switch (framework) {
    case "antd":
      return {
        optionContainerSelector: ".ant-select-dropdown:not(.ant-select-dropdown-hidden), .ant-picker-dropdown",
        optionSelector: ".ant-select-item-option, .ant-select-item, li[role='option']",
        searchInputSelector: ".ant-select-selection-search-input, .ant-select-search__field",
      };
    case "element-ui":
      return {
        optionContainerSelector: ".el-select-dropdown, .el-dropdown-menu",
        optionSelector: ".el-select-dropdown__item, .el-dropdown-menu__item",
        searchInputSelector: ".el-select__input, .el-input__inner",
      };
    case "arco":
      return {
        optionContainerSelector: ".arco-select-popup, .arco-picker-panel",
        optionSelector: ".arco-select-option, li",
        searchInputSelector: ".arco-select-view-search-input",
      };
    case "kuma":
      return {
        optionContainerSelector: ".kuma-select2-dropdown, .kuma-calendar-picker-panel",
        optionSelector: ".kuma-select2-option, .kuma-calendar-panel-cell",
        searchInputSelector: ".kuma-select2-search-input",
      };
    case "iview":
      return {
        optionContainerSelector: '.ivu-select-dropdown:not([style*="display: none"])',
        optionSelector: ".ivu-select-item, .ivu-cascader-menu-item",
        searchInputSelector: ".ivu-select-input",
      };
    case "atsx":
      return {
        optionContainerSelector: ".atsx-select-dropdown",
        optionSelector: 'li[role="option"]',
        searchInputSelector: ".atsx-select-search input",
      };
    case "brick":
      return {
        optionContainerSelector: "[class*=brick-select-dropdown]",
        optionSelector: "[class*=brick-select-option]",
        searchInputSelector: "[class*=brick-select-search] input",
      };
    case "fusion-next":
      return {
        optionContainerSelector: ".next-select-dropdown, .next-date-picker-panel",
        optionSelector: ".next-select-item, .next-cascader-option",
        searchInputSelector: ".next-select-input",
      };
    case "feishu-ud":
      return {
        optionContainerSelector: ".ud__select__dropdown:not(.ud__select__dropdown-hidden)",
        optionSelector: ".ud__select__list__item",
        searchInputSelector: ".ud__select-search input",
      };
    default:
      // 3. Generic fallback
      return {
        optionContainerSelector: '[class*="dropdown"], [class*="popup"], [class*="select-dropdown"], [role="listbox"]',
        optionSelector: '[role="option"], li, [class*="option"], [class*="item"]',
      };
  }
}

// ===== Layer 2: DropdownObserver — MutationObserver for Dynamic Dropdowns =====

export class DropdownObserver {
  private observer: MutationObserver | null = null;
  private excludePanels: Set<HTMLElement>;
  private newPanels: HTMLElement[] = [];
  private dropdownSelector: string;

  constructor(excludePanels: Set<HTMLElement>, dropdownSelector: string) {
    this.excludePanels = excludePanels;
    this.dropdownSelector = dropdownSelector;
  }

  startObserving(): void {
    this.newPanels = [];
    this.observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          if (this.excludePanels.has(node)) continue;
          try {
            if (node.matches(this.dropdownSelector)) {
              this.newPanels.push(node);
              continue;
            }
            const matches = node.querySelectorAll(this.dropdownSelector);
            for (const match of matches) {
              if (match instanceof HTMLElement && !this.excludePanels.has(match)) {
                this.newPanels.push(match);
              }
            }
          } catch { /* invalid selector */ }
        }
      }
    });

    this.observer.observe(document.body, { childList: true, subtree: true });
  }

  stopAndCollect(): { panels: HTMLElement[] } {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    return { panels: this.newPanels };
  }

  peekPanels(): HTMLElement[] {
    return [...this.newPanels];
  }
}

// ===== Option Collection Engine =====

export async function collectDropdownOptions(
  element: HTMLElement,
  config?: OptionSelectorConfig,
  options?: {
    shouldRetry?: boolean;
    preselectedContainer?: HTMLElement | null;
    excludePanels?: Set<HTMLElement>;
    portalSnapshotCaptured?: boolean;
    maxWaitMs?: number;
  },
): Promise<DropdownOption[]> {
  // Fast path: native HTMLSelectElement
  if (element instanceof HTMLSelectElement) {
    return extractNativeSelectOptions(element);
  }

  const resolved = resolveOptionConfig(element, config);
  if (!resolved) return [];

  const excludePanels = options?.excludePanels || new Set<HTMLElement>();
  const maxWaitMs = options?.maxWaitMs || 800;

  // Prefer an explicitly controlled or inline panel. A global visible panel may
  // belong to another field whose dropdown was not closed yet.
  let container = findDropdownContainer(
    element,
    resolved,
    excludePanels,
    options?.portalSnapshotCaptured === true,
  );

  // Step 2: Start MutationObserver if no dropdown found yet
  let observer: DropdownObserver | null = null;
  if (!container && !options?.preselectedContainer) {
    observer = new DropdownObserver(excludePanels, resolved.optionContainerSelector);
    observer.startObserving();
  }

  // Step 3: Wait for DOM to render dropdown
  if (options?.preselectedContainer) {
    container = options.preselectedContainer;
  } else {
    const pollInterval = 50;
    const deadline = Date.now() + maxWaitMs;
    while (!container && Date.now() < deadline) {
      await sleep(pollInterval);
      container = findDropdownContainer(
        element,
        resolved,
        excludePanels,
        options?.portalSnapshotCaptured === true,
      );
      if (!container && observer) {
        const panels = observer.peekPanels();
        container = pickUnambiguousContainer(panels, excludePanels);
      }
      if (container) break;
    }
  }

  // Step 4: Try MutationObserver results
  if (!container && observer) {
    const { panels } = observer.stopAndCollect();
    if (panels.length > 0) {
      container = pickUnambiguousContainer(panels, excludePanels);
    }
  }

  if (observer) {
    observer.stopAndCollect();
    observer = null;
  }

  if (!container) return [];

  // Step 5: Re-select nearest container (with distance + exclude logic)
  if (!options?.preselectedContainer) {
    container = resolveControlledDropdown(element, resolved, excludePanels)
      || container
      || findDropdownContainer(
        element,
        resolved,
        excludePanels,
        options?.portalSnapshotCaptured === true,
      );
  }

  // Step 6: Extract options from container
  return extractOptionsFromContainer(container, resolved.optionSelector);
}

// ===== Helper Functions =====

function findInlineDropdown(
  element: HTMLElement,
  config: ResolvedOptionConfig,
  excludePanels: Set<HTMLElement> = new Set(),
): HTMLElement | null {
  const controlScope = element.closest(
    "[role=combobox], [aria-controls], [aria-owns],"
    + " .ant-select, .el-select, .arco-select, .kuma-select2,"
    + " .ivu-select, .atsx-select, .next-select, .ud__select,"
    + " .phoenix-select, .phoenix-datePicker,"
    + " [class*=brick-select], [class*=sd-Dropdown], [class*=sd-Select]",
  );
  const scopes = [element, controlScope].filter(
    (scope): scope is HTMLElement => scope instanceof HTMLElement,
  );
  for (const scope of scopes) {
    const candidates = [
      ...(safeMatches(scope, config.optionContainerSelector) ? [scope] : []),
      ...safeQueryAll(scope, config.optionContainerSelector),
    ];
    const found = candidates.find(
      (candidate) => !containsOrIsAny(excludePanels, candidate) && isElementVisible(candidate),
    );
    if (found) return found;
  }
  return null;
}

function findOpenDropdown(element: HTMLElement, config: ResolvedOptionConfig): HTMLElement | null {
  return findDropdownContainer(element, config);
}

function findAnyOpenDropdown(
  element: HTMLElement,
  config: ResolvedOptionConfig,
  excludePanels: Set<HTMLElement> = new Set(),
  portalSnapshotCaptured = false,
): HTMLElement | null {
  const candidates = safeQueryAll(document, config.optionContainerSelector)
    .filter((candidate) => !containsOrIsAny(excludePanels, candidate) && isElementVisible(candidate));
  const controlled = resolveControlledDropdown(element, config, excludePanels);
  if (controlled) return controlled;
  if (!portalSnapshotCaptured) return null;
  return pickUnambiguousContainer(candidates, excludePanels);
}

function findDropdownContainer(
  element: HTMLElement,
  config: ResolvedOptionConfig,
  excludePanels: Set<HTMLElement> = new Set(),
  portalSnapshotCaptured = false,
): HTMLElement | null {
  return resolveControlledDropdown(element, config, excludePanels)
    || findInlineDropdown(element, config, excludePanels)
    || findAnyOpenDropdown(
      element,
      config,
      excludePanels,
      portalSnapshotCaptured,
    );
}

export function captureOpenDropdownPanels(
  element: HTMLElement,
  config?: OptionSelectorConfig,
): Set<HTMLElement> {
  const resolved = resolveOptionConfig(element, config);
  if (!resolved) return new Set();
  const controlled = resolveControlledDropdown(element, resolved);
  const inline = findInlineDropdown(element, resolved);
  const targetPanels = new Set(
    [controlled, inline].filter(
      (panel): panel is HTMLElement => panel instanceof HTMLElement,
    ),
  );
  return new Set(
    safeQueryAll(document, resolved.optionContainerSelector).filter(
      (panel) => !containsOrIsAny(targetPanels, panel) && isElementVisible(panel),
    ),
  );
}

export function resolveTargetDropdown(
  element: HTMLElement,
  config?: OptionSelectorConfig,
  excludePanels: Set<HTMLElement> = new Set(),
  portalSnapshotCaptured = false,
): HTMLElement | null {
  const resolved = resolveOptionConfig(element, config);
  return resolved
    ? findDropdownContainer(
      element,
      resolved,
      excludePanels,
      portalSnapshotCaptured,
    )
    : null;
}

function pickNearestContainer(
  element: HTMLElement,
  containers: HTMLElement[],
  excludePanels: Set<HTMLElement>,
  requireNewPanel = false,
): HTMLElement | null {
  const targetRect = element.getBoundingClientRect();
  let best: HTMLElement | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const container of containers) {
    if (excludePanels.has(container)) continue;
    if (requireNewPanel && containsOrIsAny(excludePanels, container)) continue;
    if (!isElementVisible(container)) continue;
    const rect = container.getBoundingClientRect();
    const dx = Math.max(0, targetRect.left - rect.right, rect.left - targetRect.right);
    const dy = Math.max(0, targetRect.top - rect.bottom, rect.top - targetRect.bottom);
    const distance = Math.sqrt(dx * dx + dy * dy);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = container;
    }
  }

  return best;
}

function pickUnambiguousContainer(
  containers: HTMLElement[],
  excludePanels: Set<HTMLElement>,
): HTMLElement | null {
  const eligible = Array.from(new Set(containers)).filter(
    (container) => !containsOrIsAny(excludePanels, container) && isElementVisible(container),
  );
  const roots = eligible.filter(
    (candidate) => !eligible.some(
      (other) => other !== candidate && other.contains(candidate),
    ),
  );
  if (roots.length !== 1) return null;
  const root = roots[0];
  return eligible.every((candidate) => root === candidate || root.contains(candidate))
    ? root
    : null;
}

function containsOrIsAny(panels: Set<HTMLElement>, candidate: HTMLElement): boolean {
  for (const panel of panels) {
    if (panel === candidate || panel.contains(candidate) || candidate.contains(panel)) {
      return true;
    }
  }
  return false;
}

function resolveControlledDropdown(
  element: HTMLElement,
  config: ResolvedOptionConfig,
  excludePanels: Set<HTMLElement> = new Set(),
): HTMLElement | null {
  const controlScope = element.closest(
    "[role=combobox], .ant-select, .el-select, .arco-select, .kuma-select2,"
    + " .ivu-select, .atsx-select, .next-select, .ud__select,"
    + " [class*=brick-select], [class*=sd-Dropdown], [class*=sd-Select]",
  );
  const owners = Array.from(new Set([
    element,
    element.closest("[role=combobox]"),
    element.closest("[aria-controls], [aria-owns]"),
    ...safeQueryAll(element, "[aria-controls], [aria-owns]"),
    ...(controlScope instanceof HTMLElement
      ? safeQueryAll(controlScope, "[aria-controls], [aria-owns]")
      : []),
  ].filter((item): item is HTMLElement => item instanceof HTMLElement)));
  for (const owner of owners) {
    const ids = `${owner.getAttribute("aria-controls") || ""} ${owner.getAttribute("aria-owns") || ""}`
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    for (const id of ids) {
      const panel = document.getElementById(id);
      if (!(panel instanceof HTMLElement)) continue;
      if (
        safeMatches(panel, config.optionContainerSelector)
        && !containsOrIsAny(excludePanels, panel)
        && isElementVisible(panel)
      ) return panel;
      const container = safeClosest(panel, config.optionContainerSelector)
        || safeQueryAll(panel, config.optionContainerSelector)[0];
      if (
        container instanceof HTMLElement
        && !containsOrIsAny(excludePanels, container)
        && isElementVisible(container)
      ) return container;
      if (
        !containsOrIsAny(excludePanels, panel)
        && isElementVisible(panel)
        && safeQueryAll(panel, config.optionSelector).length > 0
      ) return panel;
    }
  }
  return null;
}

function extractOptionsFromContainer(container: HTMLElement, optionSelector: string): DropdownOption[] {
  const results: DropdownOption[] = [];
  try {
    const elements = container.querySelectorAll(optionSelector);
    for (const el of elements) {
      const htmlEl = el as HTMLElement;
      const rect = htmlEl.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      const text = normalizeText(htmlEl.textContent || "");
      if (text && text.length > 0) {
        results.push({ text, element: htmlEl });
      }
    }
  } catch { /* invalid selector */ }
  // Deduplicate
  const seen = new Set<HTMLElement>();
  return results.filter((r) => {
    if (seen.has(r.element)) return false;
    seen.add(r.element);
    return true;
  });
}

function extractNativeSelectOptions(element: HTMLSelectElement): DropdownOption[] {
  const results: DropdownOption[] = [];
  for (const opt of element.options) {
    const text = normalizeText(opt.textContent || opt.value || "");
    if (text) results.push({ text, element: opt as unknown as HTMLElement });
  }
  return results;
}

function isElementVisible(el: HTMLElement): boolean {
  if (!el.isConnected) return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function safeQueryAll(root: ParentNode, selector: string): HTMLElement[] {
  try {
    return Array.from(root.querySelectorAll(selector)) as HTMLElement[];
  } catch {
    return [];
  }
}

function safeMatches(element: HTMLElement, selector: string): boolean {
  try {
    return element.matches(selector);
  } catch {
    return false;
  }
}

function safeClosest(element: HTMLElement, selector: string): HTMLElement | null {
  try {
    return element.closest(selector) as HTMLElement | null;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const __OptionPickerInternals = {
  resolveOptionConfig,
  findOpenDropdown,
  findAnyOpenDropdown,
  pickNearestContainer,
  pickUnambiguousContainer,
  extractOptionsFromContainer,
};
