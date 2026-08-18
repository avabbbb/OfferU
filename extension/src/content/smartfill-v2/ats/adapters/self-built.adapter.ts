// Self-built ATS adapter (generic)
import type { AtsAdapter, IntentAliasMap, DetectionSignalTemplate } from "./adapter.interface.js";
import type { AtsCapabilities } from "../../core/types.js";
import { atsRegistry } from "../registry.js";

const DETECTION_SIGNALS: DetectionSignalTemplate[] = [
  { type: "url-pattern", value: "tencent\\.com|self-built|自建|建发|minmetals|nowcoder\\.com", weight: 0.40 },
  { type: "dom-signature", value: "internal|portal|career|recruit", weight: 0.15 },
];

const INTENT_ALIASES: IntentAliasMap = {
  "姓名": "full_name", "手机": "phone", "邮箱": "email", "性别": "gender",
  "出生日期": "birth_date", "身份证": "id_number", "学校": "school_name",
  "专业": "major", "学历": "education_level", "毕业时间": "graduation_date",
  "公司": "experience_company", "职位": "experience_position",
  "项目": "project_name", "自我评价": "summary", "技能": "skill_text",
  "期望职位": "expected_position", "期望薪资": "expected_salary",
};

const CAPABILITIES: AtsCapabilities = {
  enableCssPathRecovery: true, enableMetadataRefind: true,
  enableEditScopeRecovery: false, enableSpecializedControlRetry: false,
  supportedFrameworks: [], datePickerInteraction: false, cascaderInteraction: false,
  fileUploadAutomation: false, enableDynamicSectionExpansion: false,
  sectionExpandSelectors: {}, forceNativeWrite: true,
  prototypeWritePreferred: true, verificationDelayMs: 30, useCustomVerifier: false,
};

const selfBuiltAdapter: AtsAdapter = {
  id: "self-built", name: "SelfBuilt", displayName: "自建招聘系统",
  getDetectionSignals() { return DETECTION_SIGNALS; },
  getIntentAliases() { return INTENT_ALIASES; },
  getCapabilities() { return CAPABILITIES; },
  getFrameworkHints() { return []; },
  getSelectorOverrides() {
    return {
      labelSelector: "label, [class*=label], [class*=Label], [data-label]",
      containerSelector: "[class*=form-item], [class*=formItem], [class*=field], .form-group, td",
      sectionSelector: "fieldset, [class*=section], [class*=module], [class*=card]",
      repeatItemSelector: "[class*=item], [class*=record], [class*=experience], [class*=card]",
      pageStructure: {
        level1Selector: "fieldset legend, [class*=section] [class*=title], [class*=module] [class*=title], h2, h3",
        level2Selector: "label, [class*=label], [class*=Label], [data-label]",
        groupSelector: "[class*=record], [class*=experience], [class*=array-item], [class*=card]",
        customControlSelectors: [
          ".ant-select",
          ".ant-picker",
          ".el-select",
          ".el-date-editor",
          "[role=combobox]",
          "[contenteditable=true]",
        ],
      },
      optionSelectorConfig: {
        dropdownSelector: ".ant-select-dropdown, .el-select-dropdown, [class*=dropdown], [class*=popup]",
        optionSelector: ".ant-select-item-option, .el-select-dropdown__item, [role=option], li",
        searchInputSelector: ".ant-select-selection-search-input, .el-select__input, input[role=combobox]",
      },
    };
  },
};

atsRegistry.register(selfBuiltAdapter);
