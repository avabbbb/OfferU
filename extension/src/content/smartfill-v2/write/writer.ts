// Value writing orchestrator — writer chain + site-specific dispatch
import type { ScannedField, MatchCandidate, WriteResult, RecoveryStep } from "../core/types.js";
import type { OptionSelectorConfig } from "../ats/adapters/adapter.interface.js";
import { writeNativeInput, writeNativeSelect } from "./native-writer.js";
import { writeCheckbox, writeRadioGroup, writeRadioHost } from "./checkbox-radio.js";
import { writeComboboxValue } from "./combobox-writer.js";
import { writeCascaderValue } from "./cascader-writer.js";
import { writeDatePickerValue, writeDateRangeValue } from "./date-picker-writer.js";
import { writeRichTextValue } from "./rich-text-writer.js";
import { highlightFileUpload } from "./file-upload-writer.js";
import { writeWithRecovery } from "./recovery.js";
import { verifyWrite } from "./verifier.js";
import { logPipelineStage } from "../shared/logger.js";
import { isJsonStringValue, containsJsonStringFragment } from "../shared/text-utils.js";
import { UI as UIConstants } from "../shared/constants.js";
import { readCurrentFieldValue } from "../core/critical-plan.js";
import { writeFeishuUDField } from "./site-writers/feishu-ud-writer.js";
import { writeBeisenPhoenixField } from "./site-writers/beisen-phoenix-writer.js";
import { writeMokaField } from "./site-writers/moka-writer.js";

export async function writeSingleField(
  field: ScannedField,
  value: string,
  adapterId?: string,
  signal?: AbortSignal,
  candidate?: MatchCandidate,
  optionSelectorConfig?: OptionSelectorConfig,
): Promise<WriteResult> {
  if (signal?.aborted) {
    return { fieldId: field.fieldId, written: false, verified: false, failureReason: "aborted", recovered: false, recoveryPath: [] };
  }

  if (!field.element.isConnected) {
    return { fieldId: field.fieldId, written: false, verified: false, failureReason: "not_found", recovered: false, recoveryPath: [] };
  }

  if (!field.runtime.writable) {
    return { fieldId: field.fieldId, written: false, verified: false, failureReason: "write_blocked", recovered: false, recoveryPath: [] };
  }

  const writeFn = async (f: ScannedField): Promise<boolean> => {
    return dispatchWrite(f, value, adapterId || "", optionSelectorConfig);
  };

  const { success, recoveryPath, effectiveField } = await writeWithRecovery(field, value, writeFn, {
    enableCssPathRecovery: true,
    enableMetadataRefind: true,
    enableEditScopeRecovery: true,
    enableSpecializedControlRetry: true,
  });

  const verified = success ? verifyWrite(effectiveField, value, candidate) : false;
  if (success && verified) {
    markFieldAsFilled(effectiveField);
  }

  return {
    fieldId: field.fieldId,
    written: success && verified,
    verified,
    failureReason: success ? (verified ? undefined : "verify_failed") : "write_failed",
    recovered: recoveryPath.length > 1,
    recoveryPath,
  };
}

function markFieldAsFilled(field: ScannedField): void {
  const element = field.element;
  element.setAttribute("data-offeru-filled", "1");
  element.setAttribute("data-offeru-field-id", field.fieldId);
  element.setAttribute("data-offeru-label", field.level2Title || field.semanticLabel || field.label);
  element.setAttribute("data-offeru-module", field.level1Title || field.moduleName || "");
  if (field.repeatGroupIndex) {
    element.setAttribute("data-offeru-group", String(field.repeatGroupIndex));
  }
  if (field.structureToken) {
    element.setAttribute("data-offeru-structure", field.structureToken);
  }
}

async function dispatchWrite(
  field: ScannedField,
  value: string,
  adapterId: string,
  optionSelectorConfig?: OptionSelectorConfig,
): Promise<boolean> {
  // Defense-in-depth: reject JSON-serialized values
  if (isJsonStringValue(value) || containsJsonStringFragment(value)) return false;

  const el = field.element;
  const tag = el.tagName.toLowerCase();
  const type = (el as HTMLInputElement).type?.toLowerCase() || "";

  const siteResult = await applySiteWriter(field, value, adapterId);
  if (siteResult.handled) return siteResult.success;

  if (field.controlType === "cascader") {
    const ok = await writeCascaderValue(el, value, field.frameworkHint);
    if (ok) return true;
  }

  if (field.controlType === "date-picker") {
    const ok = await writeDatePickerValue(el, value, field.frameworkHint);
    if (ok) return true;
  }
  if (field.controlType === "date-range-picker") {
    const ok = await writeDateRangeValue(el, splitDateRange(value), field.frameworkHint);
    if (ok) return true;
  }

  if (field.controlType === "select" || field.controlType === "combobox") {
    const hiddenBootstrapSelect = findBootstrapSelect(field);
    if (hiddenBootstrapSelect) {
      const ok = await writeNativeSelect(hiddenBootstrapSelect, value, extractSelectOptions(hiddenBootstrapSelect));
      if (ok) {
        syncBootstrapDisplay(field, hiddenBootstrapSelect);
        return true;
      }
    }
    if (tag === "select") {
      const ok = await writeNativeSelect(el as HTMLSelectElement, value, field.options);
      if (ok) return true;
    }
    const ok = await writeComboboxValue(el, value, field.frameworkHint, optionSelectorConfig, { level1Title: field.level1Title, level2Title: field.level2Title });
    if (ok) return true;
  }

  if (field.controlType === "custom") {
    if (/select/i.test((el as HTMLElement).className || "") || el.getAttribute("role") === "combobox") {
      const ok = await writeComboboxValue(el, value, field.frameworkHint, optionSelectorConfig, { level1Title: field.level1Title, level2Title: field.level2Title });
      if (ok) return true;
    }
  }

  if (field.controlType === "rich-text" || field.controlType === "contenteditable") {
    const ok = await writeRichTextValue(el, value);
    if (ok) return true;
  }

  if (field.controlType === "input" || field.controlType === "textarea") {
    if (tag === "select") {
      const ok = await writeNativeSelect(el as HTMLSelectElement, value, field.options);
      if (ok) return true;
    }
    const ok = await writeNativeInput(el as HTMLInputElement | HTMLTextAreaElement, value, field);
    if (ok) return true;
  }

  if (field.controlType === "checkbox") {
    if (tag === "input" && type === "checkbox") {
      const ok = await writeCheckbox(el as HTMLInputElement, value, field.label);
      if (ok) return true;
    }
  }
  if (field.controlType === "radio") {
    if (tag === "input" && type === "radio") {
      const ok = await writeRadioGroup(el as HTMLInputElement, value, field.label);
      if (ok) return true;
    }
    const ok = await writeRadioHost(el, value);
    if (ok) return true;
  }

  if (field.controlType === "file-upload") {
    await highlightFileUpload(el, field);
    return true;
  }

  if (field.controlType === "custom") {
    if (/picker|calendar/i.test((el as HTMLElement).className || "")) {
      const ok = await writeDatePickerValue(el, value, field.frameworkHint);
      if (ok) return true;
    }
    if (tag === "input" || tag === "textarea") {
      return writeNativeInput(el as HTMLInputElement | HTMLTextAreaElement, value, field);
    }
  }

  return false;
}

function findBootstrapSelect(field: ScannedField): HTMLSelectElement | null {
  const roots = [field.element, field.runtime.hostElement].filter(Boolean) as HTMLElement[];
  for (const root of roots) {
    if (root instanceof HTMLSelectElement) return root;
    try {
      const select = root.querySelector("select.selectpicker, select.form-control, select");
      if (select instanceof HTMLSelectElement) return select;
    } catch { /* ignore */ }
  }
  return null;
}

function extractSelectOptions(select: HTMLSelectElement): Array<{ text: string; value: string; selected: boolean }> {
  return Array.from(select.options).map((option) => ({
    text: option.text.trim(),
    value: option.value,
    selected: option.selected,
  }));
}

function syncBootstrapDisplay(field: ScannedField, select: HTMLSelectElement): void {
  const selectedText = select.options[select.selectedIndex]?.text || select.value || "";
  const root = field.runtime.hostElement || field.element.closest(".bootstrap-select") || field.element.parentElement;
  const display = root?.querySelector(".filter-option, .filter-option-inner-inner, [class*=filter-option]") as HTMLElement | null;
  if (display && selectedText) display.textContent = selectedText;
  field.element.setAttribute("data-offeru-selected-value", selectedText);
}

// Pure adapter ID driven, no runtime DOM sniffing

async function applySiteWriter(
  field: ScannedField,
  value: string,
  adapterId: string,
): Promise<{ handled: boolean; success: boolean }> {
  switch (adapterId) {
    case "feishu":
      return writeFeishuUDField(field, value);
    case "beisen":
      return writeBeisenPhoenixField(field, value);
    case "moka":
      return writeMokaField(field, value);
    default:
      return { handled: false, success: false };
  }
}

// ===== Batch Write =====

export async function writeBatch(
  fields: ScannedField[],
  candidates: Map<string, MatchCandidate>,
  options?: {
    signal?: AbortSignal;
    onFieldDone?: (result: WriteResult) => void;
    adapterId?: string;
    optionSelectorConfig?: OptionSelectorConfig;
    preserveExistingValues?: boolean;
  },
): Promise<WriteResult[]> {
  const results: WriteResult[] = [];
  let scrollCounter = 0;

  const sorted = [...fields].sort((a, b) => {
    if (a.isRequired !== b.isRequired) return a.isRequired ? -1 : 1;
    const aIsIdentity = /姓名|手机|邮箱|证件|name|phone|email|id/i.test(a.label);
    const bIsIdentity = /姓名|手机|邮箱|证件|name|phone|email|id/i.test(b.label);
    if (aIsIdentity !== bIsIdentity) return aIsIdentity ? -1 : 1;
    return b.qualityScore - a.qualityScore;
  });

  for (const field of sorted) {
    if (options?.signal?.aborted) break;

    const candidate = candidates.get(field.fieldId);
    if (!candidate) continue;
    if (options?.preserveExistingValues && readCurrentFieldValue(field)) {
      const result: WriteResult = {
        fieldId: field.fieldId,
        written: false,
        verified: false,
        failureReason: "existing_value",
        recovered: false,
        recoveryPath: [],
      };
      results.push(result);
      options?.onFieldDone?.(result);
      continue;
    }

    const result = await writeSingleField(
      field,
      candidate.value,
      options?.adapterId,
      options?.signal,
      candidate,
      options?.optionSelectorConfig,
    );

    scrollCounter++;
    if (scrollCounter % UIConstants.scrollIntoViewInterval === 0) {
      try { field.element.scrollIntoView({ block: "center", behavior: "smooth" }); } catch { /* ignore */ }
    }

    results.push(result);
    options?.onFieldDone?.(result);

    await sleep(60);
  }

  return results;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function splitDateRange(value: string): [string, string] {
  const cleaned = value.trim();
  const longSep = cleaned.split(/\s*[~—–]\s*/);
  if (longSep.length >= 2) return [longSep[0].trim(), longSep[1].trim()];
  const commaSep = cleaned.split(/\s*[,，]\s*/);
  if (commaSep.length >= 2) return [commaSep[0].trim(), commaSep[1].trim()];
  const dashMatch = cleaned.match(/^(\d{4}[-/]\d{1,2}[-/]\d{1,2})\s*-\s*(\d{4}[-/]\d{1,2}[-/]\d{1,2})$/);
  if (dashMatch) return [dashMatch[1].trim(), dashMatch[2].trim()];
  const ymMatch = cleaned.match(/^(\d{4}[-/]\d{1,2})\s*-\s*(\d{4}[-/]\d{1,2})$/);
  if (ymMatch) return [ymMatch[1].trim(), ymMatch[2].trim()];
  return [cleaned, cleaned];
}

export const __WriterInternals = {
  dispatchWrite,
  markFieldAsFilled,
  applySiteWriter,
};
