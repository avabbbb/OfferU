import type { CascaderConfig } from "../ats/adapters/adapter.interface.js";
import { normalizeText } from "../shared/text-utils.js";
import { safeExtensionError } from "../../../lib/safe-error.js";

const DEFAULT_NEXT_LEVEL_DELAY_MS = 300;
const MAX_CASCADE_DEPTH = 4;

export interface CascadeWriteResult {
  success: boolean;
  depth: number;
  error?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForElement(
  parent: Element | Document,
  selector: string,
  timeoutMs: number = 2000,
): Promise<HTMLElement | null> {
  return new Promise((resolve) => {
    const existing = parent.querySelector<HTMLElement>(selector);
    if (existing) { resolve(existing); return; }

    const observer = new MutationObserver(() => {
      const el = parent.querySelector<HTMLElement>(selector);
      if (el) {
        observer.disconnect();
        resolve(el);
      }
    });

    observer.observe(parent instanceof Document ? document.body : parent, {
      childList: true,
      subtree: true,
    });

    setTimeout(() => {
      observer.disconnect();
      resolve(parent.querySelector<HTMLElement>(selector));
    }, timeoutMs);
  });
}

export async function writeCascader(
  hostElement: HTMLElement,
  valueSegments: string[],
  config: CascaderConfig,
): Promise<CascadeWriteResult> {
  if (!valueSegments || valueSegments.length === 0) {
    return { success: false, depth: 0, error: "no value segments" };
  }

  const depth = Math.min(valueSegments.length, MAX_CASCADE_DEPTH);
  const delayMs = config.nextLevelDelayMs || DEFAULT_NEXT_LEVEL_DELAY_MS;

  try {
    hostElement.click();
    await sleep(delayMs);

    for (let level = 0; level < depth; level++) {
      const targetText = normalizeText(valueSegments[level]);
      if (!targetText) continue;

      const menu = await waitForElement(document, config.menuSelector, 2000);
      if (!menu) {
        return { success: false, depth: level, error: `menu not found at level ${level}` };
      }

      const items = menu.querySelectorAll<HTMLElement>(config.menuItemSelector);
      let matched = false;

      for (const item of items) {
        const itemText = normalizeText(item.textContent || "");
        if (itemText === targetText || itemText.includes(targetText) || targetText.includes(itemText)) {
          item.click();
          matched = true;
          break;
        }
      }

      if (!matched) {
        return { success: false, depth: level, error: `no match for "${valueSegments[level]}" at level ${level}` };
      }

      if (level < depth - 1) {
        await sleep(delayMs);
      }
    }

    return { success: true, depth };
  } catch (error) {
    return { success: false, depth: 0, error: safeExtensionError(error, "级联选择失败") };
  }
}

export function isCascaderField(
  element: HTMLElement,
  config?: CascaderConfig,
): boolean {
  if (!config) return false;
  try {
    return element.matches(config.cascaderHostSelector);
  } catch {
    return false;
  }
}

export function splitCascadeValue(value: string): string[] {
  if (!value) return [];
  return value.split(/[\/\\|＞>｜，,、\-\s]+/).map((s) => s.trim()).filter(Boolean);
}
