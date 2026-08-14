import { describe, expect, it } from "vitest";
import {
  captureOpenDropdownPanels,
  collectDropdownOptions,
  resolveTargetDropdown,
} from "../write/option-picker.js";

const config = {
  dropdownSelector: ".ant-select-dropdown",
  optionSelector: ".ant-select-item-option",
};

function makeVisible(element: HTMLElement, top: number): void {
  element.getBoundingClientRect = () => ({
    width: 160,
    height: 32,
    top,
    left: 10,
    right: 170,
    bottom: top + 32,
    x: 10,
    y: top,
    toJSON: () => ({}),
  } as DOMRect);
}

describe("dropdown target isolation", () => {
  it("prefers the panel linked by aria-controls when multiple portals are open", async () => {
    document.body.innerHTML = `
      <div id="school" role="combobox" aria-controls="school-menu"></div>
      <div id="old-menu" class="ant-select-dropdown"><div class="ant-select-item-option">旧字段</div></div>
      <div id="school-menu" class="ant-select-dropdown"><div class="ant-select-item-option">目标字段</div></div>
    `;
    const host = document.getElementById("school") as HTMLElement;
    const oldPanel = document.getElementById("old-menu") as HTMLElement;
    const targetPanel = document.getElementById("school-menu") as HTMLElement;
    const oldOption = oldPanel.firstElementChild as HTMLElement;
    const targetOption = targetPanel.firstElementChild as HTMLElement;
    [host, oldPanel, targetPanel, oldOption, targetOption].forEach((element, index) => makeVisible(element, 10 + index * 40));

    expect(resolveTargetDropdown(host, config)).toBe(targetPanel);
    const options = await collectDropdownOptions(host, config, { maxWaitMs: 1 });
    expect(options.map((item) => item.text)).toEqual(["目标字段"]);
  });

  it("resolves aria-controls declared on the combobox input inside the host", () => {
    document.body.innerHTML = `
      <div id="school" class="ant-select">
        <input role="combobox" aria-controls="school-menu" />
      </div>
      <div id="other-menu" class="ant-select-dropdown"><div class="ant-select-item-option">其他字段</div></div>
      <div id="school-menu" class="ant-select-dropdown"><div class="ant-select-item-option">目标字段</div></div>
    `;
    const host = document.getElementById("school") as HTMLElement;
    const otherPanel = document.getElementById("other-menu") as HTMLElement;
    const targetPanel = document.getElementById("school-menu") as HTMLElement;
    [host, otherPanel, targetPanel].forEach((element, index) => makeVisible(element, 10 + index * 40));

    expect(resolveTargetDropdown(host, config)).toBe(targetPanel);
  });

  it("excludes a panel that was already open before this field was clicked", async () => {
    document.body.innerHTML = `
      <div id="school" role="combobox"></div>
      <div id="old-menu" class="ant-select-dropdown"><div class="ant-select-item-option">旧字段</div></div>
    `;
    const host = document.getElementById("school") as HTMLElement;
    const oldPanel = document.getElementById("old-menu") as HTMLElement;
    [host, oldPanel].forEach((element, index) => makeVisible(element, 10 + index * 40));
    const beforeClick = captureOpenDropdownPanels(host, config);

    document.body.insertAdjacentHTML(
      "beforeend",
      `<div id="new-menu" class="ant-select-dropdown"><div class="ant-select-item-option">目标字段</div></div>`,
    );
    const newPanel = document.getElementById("new-menu") as HTMLElement;
    const newOption = newPanel.firstElementChild as HTMLElement;
    [newPanel, newOption].forEach((element, index) => makeVisible(element, 90 + index * 40));

    expect(beforeClick).toEqual(new Set([oldPanel]));
    expect(resolveTargetDropdown(host, config, beforeClick, true)).toBe(newPanel);
    const options = await collectDropdownOptions(host, config, {
      excludePanels: beforeClick,
      portalSnapshotCaptured: true,
      maxWaitMs: 1,
    });
    expect(options.map((item) => item.text)).toEqual(["目标字段"]);
  });

  it("fails closed when multiple unrelated portals are already open", () => {
    document.body.innerHTML = `
      <div id="school" role="combobox"></div>
      <div id="first-menu" class="ant-select-dropdown"><div class="ant-select-item-option">字段一</div></div>
      <div id="second-menu" class="ant-select-dropdown"><div class="ant-select-item-option">字段二</div></div>
    `;
    const host = document.getElementById("school") as HTMLElement;
    const first = document.getElementById("first-menu") as HTMLElement;
    const second = document.getElementById("second-menu") as HTMLElement;
    [host, first, second].forEach((element, index) => makeVisible(element, 10 + index * 40));

    expect(resolveTargetDropdown(host, config)).toBeNull();
  });

  it("fails closed when multiple unrelated portals appear after the click", () => {
    document.body.innerHTML = `
      <div id="school" role="combobox"></div>
      <div id="first-menu" class="ant-select-dropdown"><div class="ant-select-item-option">字段一</div></div>
      <div id="second-menu" class="ant-select-dropdown"><div class="ant-select-item-option">字段二</div></div>
    `;
    const host = document.getElementById("school") as HTMLElement;
    const first = document.getElementById("first-menu") as HTMLElement;
    const second = document.getElementById("second-menu") as HTMLElement;
    [host, first, second].forEach((element, index) => makeVisible(element, 10 + index * 40));

    expect(resolveTargetDropdown(host, config, new Set(), true)).toBeNull();
  });

  it("accepts multiple selector matches when they belong to one portal tree", () => {
    document.body.innerHTML = `
      <div id="school" role="combobox"></div>
      <div id="portal" class="ant-select-dropdown">
        <div id="nested" class="ant-select-dropdown">
          <div class="ant-select-item-option">目标字段</div>
        </div>
      </div>
    `;
    const host = document.getElementById("school") as HTMLElement;
    const portal = document.getElementById("portal") as HTMLElement;
    const nested = document.getElementById("nested") as HTMLElement;
    [host, portal, nested].forEach((element, index) => makeVisible(element, 10 + index * 40));

    expect(resolveTargetDropdown(host, config, new Set(), true)).toBe(portal);
  });

  it("fails closed for one unlinked global portal without a pre-click snapshot", () => {
    document.body.innerHTML = `
      <div id="school" role="combobox"></div>
      <div id="old-menu" class="ant-select-dropdown"><div class="ant-select-item-option">旧字段</div></div>
    `;
    const host = document.getElementById("school") as HTMLElement;
    const oldPanel = document.getElementById("old-menu") as HTMLElement;
    [host, oldPanel].forEach((element, index) => makeVisible(element, 10 + index * 40));

    expect(resolveTargetDropdown(host, config)).toBeNull();
  });
});
