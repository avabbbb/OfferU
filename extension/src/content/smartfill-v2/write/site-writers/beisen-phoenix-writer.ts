// Beisen Phoenix specialized writer
import type { ScannedField } from "../../core/types.js";
import { simulateClick, simulateFocus, simulateInput, setNativeValue } from "../event-simulator.js";
import { captureOpenDropdownPanels, collectDropdownOptions } from "../option-picker.js";
import { pickBestSearchOption, tryBackendOptionMatch } from "../combobox-writer.js";
import { normalizeText } from "../../shared/text-utils.js";

const PHOENIX_OPTION_CONTAINER = ".phoenix-selectList__list, .list-data-container, .area-data-container";
const PHOENIX_OPTION_ITEM = ".phoenix-selectList__listItem, .list-item-container, .area-item-name";
const PHOENIX_CONFIRM_BTN = ".phoenix-selectList__footer button, .common-unmodeled-layer button, [class*=confirm]";

export async function writeBeisenPhoenixField(field: ScannedField, value: string): Promise<{ handled: boolean; success: boolean }> {
  const el = field.element;

  // 1. Phoenix Select (area cascader or standard select)
  const phoenixAncestor = el.closest(".phoenix-select, .phoenix-datePicker");
  if (phoenixAncestor) {
    const success = await writePhoenixSelect(el, value, field);
    return { handled: true, success };
  }

  // 2. UD select inside Phoenix form
  const udAncestor = el.closest(".ud__select");
  if (udAncestor && isBeisenPage()) {
    const success = await writePhoenixSelect(el, value, field);
    return { handled: true, success };
  }

  return { handled: false, success: false };
}

async function writePhoenixSelect(host: HTMLElement, value: string, field?: ScannedField): Promise<boolean> {
  try {
    try { host.scrollIntoView({ block: "center", behavior: "smooth" }); } catch { /* ignore */ }

    const optionConfig = {
      dropdownSelector: PHOENIX_OPTION_CONTAINER,
      optionSelector: PHOENIX_OPTION_ITEM,
    };
    const previouslyOpenPanels = captureOpenDropdownPanels(host, optionConfig);
    // Open dropdown
    simulateClick(host);
    await sleep(180);

    // Phoenix area cascader: multi-level selection
    const segments = parsePhoenixSegments(value);
    if (segments.length > 1) {
      return await writePhoenixCascaded(
        host,
        segments,
        { level1Title: field?.level1Title, level2Title: field?.level2Title },
        previouslyOpenPanels,
      );
    }

    // Single value selection
    const options = await collectDropdownOptions(host, optionConfig, {
      excludePanels: previouslyOpenPanels,
      portalSnapshotCaptured: true,
    });
    if (options.length > 0) {
      const backendMatch = await tryBackendOptionMatch(options, value, { level1Title: field?.level1Title, level2Title: field?.level2Title });
      if (backendMatch) { simulateClick(backendMatch); await sleep(80); await clickPhoenixConfirm(); return true; }
      const match = pickBestSearchOption(options, value);
      if (match) { simulateClick(match); await sleep(80); await clickPhoenixConfirm(); return true; }
    }
    return false;
  } catch { return false; }
}

async function writePhoenixCascaded(
  host: HTMLElement,
  segments: string[],
  context: { level1Title?: string; level2Title?: string } | undefined,
  previouslyOpenPanels: Set<HTMLElement>,
): Promise<boolean> {
  for (let i = 0; i < segments.length; i++) {
    await sleep(100);
    const options = await collectDropdownOptions(host, {
      dropdownSelector: PHOENIX_OPTION_CONTAINER,
      optionSelector: PHOENIX_OPTION_ITEM,
    }, {
      excludePanels: previouslyOpenPanels,
      portalSnapshotCaptured: true,
    });
    const backendMatch = await tryBackendOptionMatch(options, segments[i], context);
    const match = backendMatch || pickBestSearchOption(options, segments[i]);
    if (!match) return false;
    simulateClick(match);
    if (i === segments.length - 1) {
      await clickPhoenixConfirm();
    }
  }
  return true;
}

async function clickPhoenixConfirm(): Promise<void> {
  try {
    const buttons = document.querySelectorAll(PHOENIX_CONFIRM_BTN);
    for (const btn of buttons) {
      const el = btn as HTMLElement;
      const text = normalizeText(el.textContent || "");
      if (/确定|确认|ok|save|done/i.test(text)) {
        simulateClick(el);
        await sleep(60);
        return;
      }
    }
    // Beisen specific: close unmodeled layer
    try { document.body.click(); } catch { /* ignore */ }
  } catch { /* ignore */ }
}

function parsePhoenixSegments(value: string): string[] {
  const text = normalizeText(value);
  const parts = text.split(/[/\\|｜，,\s-]+/).map((s) => s.trim()).filter((s) => s.length > 0);
  if (parts.length > 1) return parts;
  // Chinese administrative division pattern
  const segments: string[] = [];
  const pattern = /[一-龥]+(?:省|市|区|县|旗|镇|乡|街道|自治区|特别行政区|地区|自治州)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) {
    segments.push(match[0]);
  }
  return segments.length > 1 ? segments : parts;
}

function isBeisenPage(): boolean {
  try {
    return /beisen|北森|phoenix/i.test(document.body.innerHTML.slice(0, 5000));
  } catch { return false; }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const __BeisenPhoenixWriterInternals = {
  PHOENIX_OPTION_CONTAINER,
  PHOENIX_OPTION_ITEM,
  parsePhoenixSegments,
  clickPhoenixConfirm,
};
