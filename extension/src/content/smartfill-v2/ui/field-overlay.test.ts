import { beforeEach, describe, expect, it } from "vitest";
import type { CriticalPlanItem, CriticalSmartFillPlan, ScannedField } from "../core/types.js";
import { captureFieldState, FieldOverlay, restoreFieldState } from "./field-overlay.js";

function scanned(element: HTMLElement, fieldId: string): ScannedField {
  return {
    fieldId,
    element,
    cssPath: `#${fieldId}`,
    controlType: element instanceof HTMLTextAreaElement ? "textarea" : "input",
    frameworkHint: "native",
    label: fieldId,
    semanticLabel: fieldId,
    moduleName: "",
    canonicalKey: fieldId,
    placeholder: "",
    name: "",
    options: [],
    isRequired: false,
    nearbyText: "",
    groupSignature: "",
    structuralHash: "",
    qualityScore: 1,
    runtime: { writable: true },
  };
}

function item(field: ScannedField, value: string): CriticalPlanItem {
  return {
    field,
    label: field.label,
    valuePreview: value,
    candidate: {
      fieldId: field.fieldId,
      value,
      confidence: 0.9,
      intent: "name",
      source: "rule",
      occurrenceIndex: 0,
    },
  };
}

function plan(items: CriticalPlanItem[]): CriticalSmartFillPlan {
  return {
    pageUrl: window.location.href,
    createdAt: Date.now(),
    adapterId: "test",
    adapterName: "test",
    adapterConfidence: 1,
    aiUsed: false,
    scannedFields: items.map((entry) => entry.field),
    items,
    skipped: [],
  };
}

function shadow(): ShadowRoot {
  const host = document.getElementById("offeru-ext-field-overlay");
  if (!host?.shadowRoot) throw new Error("overlay not mounted");
  return host.shadowRoot;
}

describe("field overlay", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("captures and restores native inputs", () => {
    const input = document.createElement("input");
    input.value = "原值";
    document.body.appendChild(input);
    const field = scanned(input, "name");
    const before = captureFieldState(field);
    input.value = "新值";
    expect(restoreFieldState(field, before)).toBe(true);
    expect(input.value).toBe("原值");

    const textarea = document.createElement("textarea");
    textarea.value = "旧";
    document.body.appendChild(textarea);
    const textField = scanned(textarea, "intro");
    const textBefore = captureFieldState(textField);
    textarea.value = "新";
    expect(restoreFieldState(textField, textBefore)).toBe(true);
    expect(textarea.value).toBe("旧");

    const select = document.createElement("select");
    select.append(new Option("本科", "bachelor"), new Option("硕士", "master"));
    select.value = "bachelor";
    document.body.appendChild(select);
    const selectField = scanned(select, "degree");
    const selectBefore = captureFieldState(selectField);
    select.value = "master";
    expect(restoreFieldState(selectField, selectBefore)).toBe(true);
    expect(select.value).toBe("bachelor");
  });

  it("shows a chip per field, fills, and undoes", async () => {
    const input = document.createElement("input");
    input.value = "";
    document.body.appendChild(input);
    const field = scanned(input, "name");
    let filled = 0;
    const overlay = new FieldOverlay();

    overlay.show(plan([item(field, "张三")]), {
      onFillField: async () => {
        filled += 1;
        input.value = "张三";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        return { ok: true };
      },
      onClose: () => overlay.hide(),
    });

    const root = shadow();
    expect(root.querySelectorAll(".offeru-chip")).toHaveLength(1);
    const fill = root.querySelector<HTMLButtonElement>(".offeru-chip-fill");
    fill?.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(filled).toBe(1);
    expect(input.value).toBe("张三");
    expect(root.querySelector(".offeru-chip")?.classList.contains("is-filled")).toBe(true);

    root.querySelector<HTMLButtonElement>(".offeru-chip-undo")?.click();
    expect(input.value).toBe("");
    expect(root.querySelector(".offeru-chip")?.classList.contains("is-filled")).toBe(false);
    overlay.hide();
  });
});
