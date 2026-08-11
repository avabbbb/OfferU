import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { scanFieldsSync } from "../scan/scanner.js";
import type { ControlType, ScannedField } from "../core/types.js";

const FIXTURE_DIR = resolve(process.cwd(), "../references/zhaoping html");

const FIXTURES = {
  alibaba: "阿里巴巴简历页_完整保存版（北森talent）.html",
  mixue: "蜜雪冰城招聘页面_完整离线版（北森）.html",
  dayee: "特变电工招聘简历页面_完整离线版（用友大易招聘云）.html",
  tencent: "腾讯简历页_完整保存版（自建）.html",
  mokaCampus: "携程校招招聘页面_完整离线版（MOKA）.html",
  mokaSocial: "携程招聘页面（社招）_完整离线版（MOKA）.html",
  telecom: "中国电信招聘页面_完整离线版.html",
  feishu: "字节跳动简历页_完整保存版（飞书）.html",
} as const;

type FixtureName = keyof typeof FIXTURES;
const REAL_FIXTURES_AVAILABLE = Object.values(FIXTURES).every((file) =>
  existsSync(resolve(FIXTURE_DIR, file)),
);

function rect(width = 180, height = 32, top = 10, left = 20): DOMRect {
  return {
    width,
    height,
    top,
    left,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

function readFixture(name: FixtureName): string {
  return readFileSync(resolve(FIXTURE_DIR, FIXTURES[name]), "utf8");
}

function loadHtml(html: string): void {
  document.body.innerHTML = html;
  makeVisible();
}

function loadFixtureSample(name: FixtureName, markers: string[], radius = 1200): void {
  const html = stripExecutableAndStyle(readFixture(name));
  const samples: string[] = [];
  for (const marker of markers) {
    const index = html.indexOf(marker);
    if (index < 0) continue;
    samples.push(html.slice(Math.max(0, index - radius), Math.min(html.length, index + marker.length + radius)));
  }
  expect(samples.length).toBeGreaterThan(0);
  loadHtml(`<section class="fixture-sample">${samples.join("\n")}</section>`);
}

function stripExecutableAndStyle(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "");
}

function makeVisible(root: ParentNode = document): void {
  for (const element of Array.from(root.querySelectorAll("*")) as HTMLElement[]) {
    element.getBoundingClientRect = () => rect();
  }
}

function scan(): ScannedField[] {
  return scanFieldsSync(document, {
    pageStructure: {
      level1Selector: ".uxcore-card-title-text, .module-title, .section-title, .resume-section-title, .title, h2, h3",
      level2Selector: "label, .label-content, .form-item__text, .ant-form-item-label label, .ud-formily-item-label-content, .text, [class*=field-label]",
      groupSelector: ".field-group-row, .record-item, .ant-collapse-panel, .resume-section, .resume-module, [class*=resume-item]",
    },
  });
}

function hasType(fields: ScannedField[], type: ControlType): boolean {
  return fields.some((field) => field.controlType === type);
}

function labeled(fields: ScannedField[], text: string): ScannedField | undefined {
  return fields.find((field) =>
    [field.level2Title, field.semanticLabel, field.label, field.qualifiedLabel]
      .some((value) => value?.includes(text)),
  );
}

function usefulLabelRatio(fields: ScannedField[]): number {
  const useful = fields.filter((field) => !/^(请输入|请选择|必填|select|choose|enter)$/i.test(
    field.level2Title || field.semanticLabel || field.label || "",
  ));
  return useful.length / Math.max(fields.length, 1);
}

describe.skipIf(!REAL_FIXTURES_AVAILABLE)("SmartFill real ATS saved HTML fixtures", () => {
  it("recognizes Beisen Talent/Kuma controls from Alibaba as structured fields", () => {
    loadFixtureSample("alibaba", ["学校全称", "kuma-calendar-picker-input"], 1800);
    const fields = scan();

    expect(fields.filter((field) => field.frameworkHint === "kuma").length).toBeGreaterThan(2);
    expect(hasType(fields, "combobox")).toBe(true);
    expect(hasType(fields, "date-picker")).toBe(true);
    expect(labeled(fields, "学校") || labeled(fields, "院校")).toBeTruthy();
    expect(usefulLabelRatio(fields)).toBeGreaterThan(0.8);
  });

  it("recognizes Beisen Phoenix selects, radios, and date-like controls from Mixue", () => {
    loadFixtureSample("mixue", ["出生日期", "phoenix-radio-group"], 2200);
    const fields = scan();

    expect(fields.some((field) => field.runtime.surfaceRole === "complex-host" && field.element.matches(".phoenix-select"))).toBe(true);
    expect(hasType(fields, "radio")).toBe(true);
    expect(labeled(fields, "出生日期")?.controlType).toBe("date-picker");
    expect(labeled(fields, "性别")?.controlType).toBe("radio");
    expect(usefulLabelRatio(fields)).toBeGreaterThan(0.8);
  });

  it("recognizes Feishu/UD select and date range controls from ByteDance", () => {
    loadFixtureSample("feishu", ['class="ud__select', 'class="throne-biz-date-range-picker-input'], 2200);
    const fields = scan();

    expect(fields.filter((field) => field.frameworkHint === "feishu-ud").length).toBeGreaterThan(1);
    expect(hasType(fields, "combobox")).toBe(true);
    expect(hasType(fields, "date-range-picker")).toBe(true);
    expect(usefulLabelRatio(fields)).toBeGreaterThan(0.7);
  });

  it("recognizes Moka/Ant Design controls from both Ctrip fixtures", () => {
    for (const name of ["mokaCampus", "mokaSocial"] as const) {
      loadFixtureSample(name, ['class="ant-select', 'class="ant-picker'], 2200);
      const fields = scan();

      expect(fields.filter((field) => field.frameworkHint === "antd").length).toBeGreaterThan(2);
      expect(hasType(fields, "combobox")).toBe(true);
      expect(hasType(fields, "date-picker")).toBe(true);
      expect(usefulLabelRatio(fields)).toBeGreaterThan(0.7);
    }
  });

  it("recognizes Tencent custom city controls and Element cascaders", () => {
    loadFixtureSample("tencent", ["country-input", "el-cascader"], 2200);
    const fields = scan();

    expect(hasType(fields, "cascader")).toBe(true);
    expect(labeled(fields, "城市") || labeled(fields, "地区") || labeled(fields, "国家")).toBeTruthy();
    expect(usefulLabelRatio(fields)).toBeGreaterThan(0.65);
  });

  it("recognizes Bootstrap select controls from China Telecom", () => {
    loadFixtureSample("telecom", ['class="selectpicker'], 4200);
    const fields = scan();

    const bootstrapFields = fields.filter((field) => field.frameworkHint === "bootstrap");
    expect(bootstrapFields.length).toBeGreaterThanOrEqual(1);
    expect(bootstrapFields.some((field) => field.controlType === "combobox" || field.controlType === "select")).toBe(true);
    expect(usefulLabelRatio(fields)).toBeGreaterThan(0.65);
  });

  it("keeps Ant-heavy Dayee pages scannable without collapsing labels to placeholders", () => {
    loadFixtureSample("dayee", ['class="ant-select', 'class="ant-calendar-picker'], 2200);
    const fields = scan();

    expect(fields.filter((field) => field.frameworkHint === "antd").length).toBeGreaterThan(2);
    expect(hasType(fields, "combobox")).toBe(true);
    expect(usefulLabelRatio(fields)).toBeGreaterThan(0.7);
  });
});
