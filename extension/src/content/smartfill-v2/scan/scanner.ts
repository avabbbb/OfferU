// Field discovery orchestrator
// Query ONLY native controls + ARIA roles, never framework CSS classes
import type { ScannedField } from "../core/types.js";
import type { PageStructureConfig } from "../ats/adapters/adapter.interface.js";
import { expandEditableSections } from "./section-expander.js";
import { extractField, findRepeatItemRoot, resetFieldExtractorCaches } from "./field-extractor.js";
import { deduplicateFields, resetFieldIdCounter } from "./deduplicator.js";
import { resetStructureQueryCache } from "./page-structure-extractor.js";
import { logPipelineStage } from "../shared/logger.js";
import { normalizeText } from "../shared/text-utils.js";

// Native control elements — excludes hidden/submit/button/reset/image/file
const NATIVE_CONTROL_SELECTOR = [
  'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]):not([type="file"])',
  "textarea",
  "select",
  '[contenteditable="true"]',
  '[role="textbox"]',
  '[role="combobox"]',
  '[role="radio"]',
  '[role="checkbox"]',
].join(",");

// Complex component hosts — framework-specific selector/date-picker/cascader containers.
// These are the visible interaction surfaces that users click on; their internal native
// elements (hidden inputs, display inputs) are not directly writable.
const COMPLEX_CONTROL_HOSTS = [
  // Ant Design
  ".ant-select", ".ant-picker", ".ant-cascader-picker", ".ant-radio-wrapper", ".ant-checkbox-wrapper",
  // Element UI
  ".el-select", ".el-date-editor", ".el-cascader", ".el-radio-group", ".el-checkbox-group",
  // Arco Design
  ".arco-select", ".arco-picker", ".arco-cascader",
  // Kuma
  ".kuma-select2", ".kuma-calendar-picker", ".kuma-calendar-picker-input", ".kuma-date-picker",
  // iView
  ".ivu-select", ".ivu-date-picker", ".ivu-cascader",
  // ATSX
  ".atsx-select", ".atsx-picker", ".atsx-cascader",
  // Brick
  ".brick-select", ".brick-date-picker", ".brick-cascader",
  // Fusion Next
  ".next-select", ".next-date-picker", ".next-cascader",
  // Feishu UD / Throne Biz
  ".ud__select", ".ud__picker-dateInput", ".throne-biz-date-range-picker-input", ".ud__cascader",
  // Beisen Phoenix / Bootstrap / custom ATS widgets
  ".phoenix-select", ".phoenix-datePicker", ".phoenix-radio-group",
  ".bootstrap-select", ".selectpicker",
  ".country-input", ".intlTelInput", ".selected-box",
  // Semi Design
  ".semi-select", ".semi-datepicker",
  // TDesign
  ".t-select", ".t-date-picker", ".t-cascader",
  // Generic roles
  '[role="listbox"]',
].join(",");

export interface ScannerOptions {
  adapter?: {
    containerSelector?: string;
    labelSelector?: string;
    sectionSelector?: string;
    sectionExpandSelectors?: Record<string, string>;
    editLabels?: string[];
    supportedFrameworks?: string[];
    pageStructure?: PageStructureConfig;
  };
  labelSelector?: string;
  containerSelector?: string;
  sectionSelector?: string;
  pageStructure?: PageStructureConfig;
  expandSections?: boolean;
  signal?: AbortSignal;
}

export async function scanFields(
  root: Document | HTMLElement = document,
  options?: ScannerOptions,
): Promise<ScannedField[]> {
  resetFieldIdCounter();
  resetStructureQueryCache();
  resetFieldExtractorCaches();
  const { adapter, signal } = options || {};

  // Phase 1: Expand dynamic sections
  if (options?.expandSections !== false) {
    logPipelineStage("expand", "展开可编辑区域");
    await expandEditableSections({
      editLabels: adapter?.editLabels,
      sectionExpandSelectors: adapter?.sectionExpandSelectors,
      signal,
    });
  }

  if (signal?.aborted) return [];

  // Phase 2: Query ONLY native controls (no framework CSS classes)
  logPipelineStage("scan", "扫描表单字段");
  let elements: HTMLElement[] = [];
  try {
    const nodeList = root.querySelectorAll(buildControlSelector(options?.pageStructure || adapter?.pageStructure));
    elements = Array.from(nodeList) as HTMLElement[];
  } catch {
    elements = [];
  }

  // Phase 3: Deduplicate by element reference and collapse nested display inputs
  elements = elements.filter((el, i, arr) => arr.indexOf(el) === i);
  elements = preferComplexHosts(elements);

  // Phase 4: Filter visible elements
  elements = elements.filter((el) => isElementVisible(el));

  if (signal?.aborted) return [];

  // Phase 5: Extract fields with container context
  const extractionOptions = {
    labelSelector: options?.labelSelector || adapter?.labelSelector,
    containerSelector: options?.containerSelector || adapter?.containerSelector,
    sectionSelector: options?.sectionSelector || adapter?.sectionSelector,
    pageStructure: options?.pageStructure || adapter?.pageStructure,
  };

  const extracted = [];
  for (const el of elements) {
    if (signal?.aborted) break;
    try {
      const field = extractField(el, extractionOptions);
      if (field) attachRuntimeSurface(field, elements);
      if (field) extracted.push(field);
    } catch {
      // Skip individual extraction errors
    }
  }

  // Phase 6: Deduplicate and rank
  const scanned = deduplicateFields(extracted);

  // Phase 7: Compute occurrence information for multi-item fields
  // IMPORTANT: Use DOM order (extraction order) not quality-sorted order
  // to correctly assign occurrenceIndex (1st school, 2nd school, etc.)
  const domOrdered = [...scanned].sort((a, b) => {
    const pos = a.element.compareDocumentPosition(b.element);
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  });
  computeOccurrenceInfo(domOrdered);

  logPipelineStage("scan", `扫描完成：${scanned.length} 个字段`, {
    total: elements.length,
    extracted: extracted.length,
    final: scanned.length,
  });

  return scanned;
}

export function scanFieldsSync(
  root: Document | HTMLElement = document,
  options?: ScannerOptions,
): ScannedField[] {
  resetFieldIdCounter();
  resetStructureQueryCache();
  resetFieldExtractorCaches();
  let elements: HTMLElement[] = [];
  try {
    elements = Array.from(root.querySelectorAll(buildControlSelector(options?.pageStructure || options?.adapter?.pageStructure))) as HTMLElement[];
  } catch {
    elements = [];
  }
  elements = elements.filter((el, i, arr) => arr.indexOf(el) === i);
  elements = preferComplexHosts(elements);
  elements = elements.filter((el) => isElementVisible(el));

  const extractionOptions = {
    labelSelector: options?.labelSelector || options?.adapter?.labelSelector,
    containerSelector: options?.containerSelector || options?.adapter?.containerSelector,
    sectionSelector: options?.sectionSelector || options?.adapter?.sectionSelector,
    pageStructure: options?.pageStructure || options?.adapter?.pageStructure,
  };

  const extracted = [];
  for (const el of elements) {
    try {
      const field = extractField(el, extractionOptions);
      if (field) attachRuntimeSurface(field, elements);
      if (field) extracted.push(field);
    } catch { /* skip */ }
  }

  const scanned = deduplicateFields(extracted);
  const domOrdered = [...scanned].sort((a, b) => {
    const pos = a.element.compareDocumentPosition(b.element);
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  });
  computeOccurrenceInfo(domOrdered);
  return scanned;
}

function computeOccurrenceInfo(fields: ScannedField[]): void {
  for (const field of fields) {
    field.repeatItemRoot = findRepeatItemRoot(field.element) || undefined;
    const label = normalizeText(field.semanticLabel || field.label);
    field.occurrenceKey = `${field.level1Title || field.moduleName}|${label}`;
  }

  const totals = new Map<string, number>();
  for (const field of fields) {
    const key = field.occurrenceKey || "";
    if (field.repeatGroupIndex) {
      totals.set(key, Math.max(totals.get(key) || 0, field.repeatGroupIndex));
    } else {
      totals.set(key, (totals.get(key) || 0) + 1);
    }
  }

  const counters = new Map<string, number>();
  for (const field of fields) {
    const key = field.occurrenceKey || "";
    const idx = field.repeatGroupIndex || ((counters.get(key) || 0) + 1);
    if (!field.repeatGroupIndex) counters.set(key, idx);
    field.occurrenceIndex = idx;
    field.occurrenceTotal = totals.get(key) || 1;
  }
}

function buildControlSelector(pageStructure?: PageStructureConfig): string {
  const custom = (pageStructure?.customControlSelectors || [])
    .map((s) => s.trim())
    .filter(Boolean);
  return [NATIVE_CONTROL_SELECTOR, COMPLEX_CONTROL_HOSTS, ...custom]
    .filter((s) => s.length > 0)
    .join(",");
}

function preferComplexHosts(elements: HTMLElement[]): HTMLElement[] {
  const elementSet = new Set(elements);
  return elements.filter((element) => {
    const host = findComplexHost(element);
    if (!host || host === element) return true;
    return !elementSet.has(host);
  });
}

function attachRuntimeSurface(field: ScannedField, elements: HTMLElement[]): void {
  const elementSet = new Set(elements);
  const host = findComplexHost(field.element);
  if (host && host === field.element) {
    field.runtime.surfaceRole = "complex-host";
    field.runtime.hostElement = host;
    field.runtime.displayInput = findDisplayInput(host) || undefined;
    field.runtime.hiddenStateInput = findHiddenStateInput(host) || undefined;
    field.runtime.writable = host.getAttribute("aria-disabled") !== "true"
      && !host.classList.contains("disabled")
      && !/\bdisabled\b/i.test(String(host.className || ""));
    return;
  }

  if (host && elementSet.has(host)) {
    field.runtime.surfaceRole = "display-input";
    field.runtime.hostElement = host;
    field.runtime.displayInput = field.element instanceof HTMLInputElement || field.element instanceof HTMLTextAreaElement
      ? field.element
      : undefined;
    return;
  }

  field.runtime.surfaceRole = "native";
}

function findComplexHost(element: HTMLElement): HTMLElement | null {
  try {
    return element.closest(COMPLEX_CONTROL_HOSTS) as HTMLElement | null;
  } catch {
    return null;
  }
}

function findDisplayInput(host: HTMLElement): HTMLInputElement | HTMLTextAreaElement | null {
  const selectors = [
    'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"])',
    "textarea",
    '[role="textbox"]',
  ].join(",");
  try {
    const input = host.querySelector(selectors);
    if (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) {
      return input;
    }
  } catch { /* ignore */ }
  return null;
}

function findHiddenStateInput(host: HTMLElement): HTMLInputElement | null {
  try {
    const input = host.querySelector('input[type="hidden"]');
    return input instanceof HTMLInputElement ? input : null;
  } catch {
    return null;
  }
}

function isElementVisible(element: HTMLElement): boolean {
  if (!element || !element.isConnected) return false;
  const style = window.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
    return false;
  }
  const rect = element.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return false;
  return true;
}

export const __ScannerInternals = {
  NATIVE_CONTROL_SELECTOR,
  COMPLEX_CONTROL_HOSTS,
  buildControlSelector,
  isElementVisible,
  preferComplexHosts,
  attachRuntimeSurface,
};
