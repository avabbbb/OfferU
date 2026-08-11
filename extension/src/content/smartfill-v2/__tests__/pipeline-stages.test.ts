import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScannedField } from "../core/types.js";

const scanFieldsMock = vi.hoisted(() => vi.fn());
const expandEditableSectionsMock = vi.hoisted(() => vi.fn());
const addNewEntriesMock = vi.hoisted(() => vi.fn());
const detectSiteMock = vi.hoisted(() => vi.fn());
const matchFieldsWithRulesMock = vi.hoisted(() => vi.fn());
const mergeAiCandidatesMock = vi.hoisted(() => vi.fn());
const writeBatchMock = vi.hoisted(() => vi.fn());
const atsRegistryGetMock = vi.hoisted(() => vi.fn());

vi.mock("../scan/scanner.js", () => ({ scanFields: scanFieldsMock }));
vi.mock("../scan/section-expander.js", () => ({
  expandEditableSections: expandEditableSectionsMock,
  addNewEntries: addNewEntriesMock,
}));
vi.mock("../ats/detector.js", () => ({ detectSite: detectSiteMock }));
vi.mock("../core/match-engine.js", () => ({
  matchFieldsWithRules: matchFieldsWithRulesMock,
  mergeAiCandidates: mergeAiCandidatesMock,
}));
vi.mock("../write/writer.js", () => ({ writeBatch: writeBatchMock }));
vi.mock("../ats/registry.js", () => ({
  atsRegistry: { get: atsRegistryGetMock, register: vi.fn() },
}));
vi.mock("../ats/adapters/feishu.adapter.js", () => ({}));
vi.mock("../ats/adapters/beisen.adapter.js", () => ({}));
vi.mock("../ats/adapters/moka.adapter.js", () => ({}));
vi.mock("../ats/adapters/dayee.adapter.js", () => ({}));
vi.mock("../ats/adapters/self-built.adapter.js", () => ({}));
vi.mock("../ats/adapters/unknown.adapter.js", () => ({}));

describe("smart fill pipeline stages", () => {
  beforeEach(() => {
    document.body.innerHTML = "<input id=\"smartfill-field\" />";
    const element = document.getElementById("smartfill-field") as HTMLInputElement;

    scanFieldsMock.mockReset();
    expandEditableSectionsMock.mockReset();
    addNewEntriesMock.mockReset();
    detectSiteMock.mockReset();
    matchFieldsWithRulesMock.mockReset();
    mergeAiCandidatesMock.mockReset();
    writeBatchMock.mockReset();
    atsRegistryGetMock.mockReset();

    scanFieldsMock
      .mockResolvedValueOnce([makeField(element)])
      .mockResolvedValueOnce([]);
    expandEditableSectionsMock.mockResolvedValue(undefined);
    addNewEntriesMock.mockResolvedValue(undefined);
    detectSiteMock.mockReturnValue({
      adapterId: "generic",
      adapterName: "Generic ATS",
      confidence: 0.99,
      matchedSignals: [],
      capabilities: {
        enableCssPathRecovery: true,
        enableMetadataRefind: true,
        enableEditScopeRecovery: true,
        enableSpecializedControlRetry: true,
        supportedFrameworks: ["native"],
        datePickerInteraction: true,
        cascaderInteraction: true,
        fileUploadAutomation: true,
        enableDynamicSectionExpansion: true,
        sectionExpandSelectors: {},
        forceNativeWrite: false,
        prototypeWritePreferred: false,
        verificationDelayMs: 0,
        useCustomVerifier: false,
      },
    });
    matchFieldsWithRulesMock.mockReturnValue(
      new Map([
        [
          "smartfill-field",
          {
            fieldId: "smartfill-field",
            value: "张三",
            confidence: 0.9,
            intent: "姓名",
            source: "rule",
            occurrenceIndex: 1,
          },
        ],
      ]),
    );
    mergeAiCandidatesMock.mockImplementation((candidates) => candidates);
    writeBatchMock.mockResolvedValue([
      {
        fieldId: "smartfill-field",
        written: true,
        verified: true,
        recovered: false,
        recoveryPath: [],
      },
    ]);

    const chromeMock = {
      runtime: {
        sendMessage: vi.fn(async (message: { type?: string }) => {
          if (message.type === "GET_SMART_FILL_PROFILE") {
            return {
              ok: true,
              profile: {
                basic: { fullName: "张三" },
                resumeArchive: {},
                applicationArchive: {},
                sections: [],
              },
            };
          }
          if (message.type === "GET_SMART_FILL_SETTINGS") {
            return {
              ok: true,
              settings: {
                enabled: false,
              },
            };
          }
          return { ok: false };
        }),
      },
    };
    Object.defineProperty(globalThis, "chrome", {
      value: chromeMock,
      configurable: true,
      writable: true,
    });
    atsRegistryGetMock.mockReturnValue({
      getSelectorOverrides: () => ({}),
      getSectionExpandInstructions: () => [],
      getIntentAliases: () => ({}),
    });
  });

  it("does not emit a fake structure stage", async () => {
    const { runSmartFillPipeline } = await import("../pipeline.js");

    const progressStages: string[] = [];
    await runSmartFillPipeline({
      onProgress: (progress) => {
        progressStages.push(progress.stage);
      },
    });

    expect(progressStages).toContain("profile");
    expect(progressStages).toContain("match");
    expect(progressStages).toContain("write");
    expect(progressStages).toContain("verify");
    expect(progressStages).not.toContain("structure");
  });

  it("builds a critical-field preview without expanding or writing the page", async () => {
    const { prepareCriticalSmartFillPlan } = await import("../pipeline.js");
    const input = document.getElementById("smartfill-field") as HTMLInputElement;

    const plan = await prepareCriticalSmartFillPlan();

    expect(plan.items).toHaveLength(1);
    expect(expandEditableSectionsMock).not.toHaveBeenCalled();
    expect(writeBatchMock).not.toHaveBeenCalled();
    expect(input.value).toBe("");
  });

  it("writes a critical-field plan only after explicit apply", async () => {
    const {
      applyCriticalSmartFillPlan,
      prepareCriticalSmartFillPlan,
    } = await import("../pipeline.js");
    const plan = await prepareCriticalSmartFillPlan();

    await applyCriticalSmartFillPlan(plan);

    expect(writeBatchMock).toHaveBeenCalledTimes(1);
    expect(writeBatchMock.mock.calls[0][2]).toMatchObject({
      preserveExistingValues: true,
    });
  });
});

function makeField(element: HTMLInputElement): ScannedField {
  return {
    fieldId: "smartfill-field",
    element,
    cssPath: "",
    controlType: "input",
    frameworkHint: "native",
    label: "姓名",
    semanticLabel: "姓名",
    moduleName: "基本信息",
    level1Title: "基本信息",
    level2Title: "姓名",
    canonicalKey: "基本信息::姓名::input",
    placeholder: "",
    name: "",
    options: [],
    isRequired: true,
    nearbyText: "",
    groupSignature: "",
    structuralHash: "",
    qualityScore: 100,
    runtime: {
      writable: true,
    },
  };
}
