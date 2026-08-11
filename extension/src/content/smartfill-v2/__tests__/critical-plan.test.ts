import { describe, expect, it } from "vitest";
import type {
  DetectionResult,
  MatchCandidate,
  ScannedField,
} from "../core/types.js";
import {
  buildCriticalSmartFillPlan,
  readCurrentFieldValue,
} from "../core/critical-plan.js";
import { selectCriticalSmartFillProfile } from "../../../background/smartfill-profile.js";

const detection = {
  adapterId: "unknown",
  adapterName: "通用网申",
  confidence: 0.7,
  matchedSignals: [],
  capabilities: {
    enableCssPathRecovery: false,
    enableMetadataRefind: false,
    enableEditScopeRecovery: false,
    enableSpecializedControlRetry: false,
    supportedFrameworks: ["native"],
    datePickerInteraction: false,
    cascaderInteraction: false,
    fileUploadAutomation: false,
    enableDynamicSectionExpansion: false,
    sectionExpandSelectors: {},
    forceNativeWrite: false,
    prototypeWritePreferred: false,
    verificationDelayMs: 0,
    useCustomVerifier: false,
  },
} satisfies DetectionResult;

function field(label: string, value = "", writable = true): ScannedField {
  const element = document.createElement("input");
  element.value = value;
  return {
    fieldId: `field-${label}`,
    element,
    cssPath: "",
    controlType: "input",
    frameworkHint: "native",
    label,
    semanticLabel: label,
    moduleName: "基本信息",
    level1Title: "基本信息",
    level2Title: label,
    canonicalKey: `基本信息::${label}::input`,
    placeholder: "",
    name: "",
    options: [],
    isRequired: true,
    nearbyText: "",
    groupSignature: "",
    structuralHash: "",
    qualityScore: 100,
    runtime: { writable },
  } as ScannedField;
}

function candidate(target: ScannedField, value: string, confidence = 0.95): MatchCandidate {
  return {
    fieldId: target.fieldId,
    value,
    confidence,
    intent: target.label,
    source: "rule",
    occurrenceIndex: 0,
    profilePath: `basic.${target.label}`,
  };
}

describe("critical smart-fill plan", () => {
  it("previews key identity fields without changing the page", () => {
    const name = field("应聘人姓名");
    const email = field("邮箱");
    const candidates = new Map([
      [name.fieldId, candidate(name, "张三")],
      [email.fieldId, candidate(email, "zhangsan@example.com")],
    ]);

    const plan = buildCriticalSmartFillPlan(
      [name, email],
      candidates,
      detection,
      false,
      "https://example.com/apply",
    );

    expect(plan.items.map((item) => item.label)).toEqual(["应聘人姓名", "邮箱"]);
    expect(plan.items[1].valuePreview).toBe("zh***@example.com");
    expect(readCurrentFieldValue(name)).toBe("");
  });

  it("protects existing values and sensitive fields", () => {
    const phone = field("手机号", "13900001111");
    const idNumber = field("身份证号");
    const candidates = new Map([
      [phone.fieldId, candidate(phone, "13800001111")],
      [idNumber.fieldId, candidate(idNumber, "440000000000000000")],
    ]);

    const plan = buildCriticalSmartFillPlan(
      [phone, idNumber],
      candidates,
      detection,
      false,
      "https://example.com/apply",
    );

    expect(plan.items).toHaveLength(0);
    expect(plan.skipped.find((item) => item.field === phone)?.reason).toBe("existing_value");
    expect(plan.skipped.find((item) => item.field === idNumber)?.reason).toBe("sensitive");
    expect(phone.element).toHaveProperty("value", "13900001111");
  });

  it("rejects low-confidence matches", () => {
    const school = field("毕业院校");
    const plan = buildCriticalSmartFillPlan(
      [school],
      new Map([[school.fieldId, candidate(school, "复旦大学", 0.6)]]),
      detection,
      true,
      "https://example.com/apply",
    );

    expect(plan.items).toHaveLength(0);
    expect(plan.skipped[0].reason).toBe("low_confidence");
  });

  it("projects only the minimum profile data into the content script", () => {
    const projected = selectCriticalSmartFillProfile({
      profileVersion: "test",
      basic: {
        fullName: "张三",
        phone: "13800001111",
        email: "zhangsan@example.com",
        city: "上海",
        targetRole: "产品经理",
        website: "https://example.com",
        github: "https://github.com/example",
        summary: "不应发送",
      },
      resumeArchive: {
        personalSummary: "不应发送",
        education: [{
          schoolName: "复旦大学",
          major: "计算机",
          descriptions: ["不应发送"],
        }],
        workExperiences: [{ companyName: "不应发送" }],
        internshipExperiences: [],
        projects: [{ projectName: "不应发送" }],
        skills: [],
        certificates: [],
        awards: [],
        personalExperiences: [],
      },
      applicationArchive: {
        shared: { expectedSalary: "不应发送" },
        identityContact: { idNumber: "不应发送" },
        jobPreference: {},
        campusFields: {},
        relationshipCompliance: {},
        sourceReferral: {},
        attachments: {},
      },
      syncSettings: {},
      sections: [{ content_json: "不应发送" }],
    });

    expect(projected.basic.fullName).toBe("张三");
    expect(projected.basic.targetRole).toBe("");
    expect(projected.resumeArchive.education).toEqual([{
      schoolName: "复旦大学",
      major: "计算机",
    }]);
    expect(projected.resumeArchive.workExperiences).toEqual([]);
    expect(projected.applicationArchive.identityContact).toEqual({});
    expect(projected.sections).toEqual([]);
  });
});
