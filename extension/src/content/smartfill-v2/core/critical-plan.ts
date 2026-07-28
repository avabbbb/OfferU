import type {
  CriticalPlanItem,
  CriticalPlanSkippedItem,
  CriticalSmartFillPlan,
  DetectionResult,
  MatchCandidate,
  ScannedField,
} from "./types.js";

const CRITICAL_CONFIDENCE = 0.82;
const CRITICAL_FIELD = /姓名|中文名|英文名|邮箱|手机|电话|所在城市|现居地|个人网站|学校|院校|专业|学历|学位|毕业时间|(?:^|[\s/_.-])(?:name|full.?name|email|e-mail|phone|mobile|current.?city|location|website|github|linkedin|school|university|major|degree|graduation)(?:$|[\s/_.-])/i;
const SENSITIVE_FIELD = /密码|口令|身份证|证件号|护照|薪资|工资|期望月薪|婚姻|性别|民族|政治面貌|健康|残疾|宗教|出生|年龄|公民|国籍|工作许可|犯罪|背景调查|家庭|亲属|紧急联系人|推荐人|内推|同意|授权|条款|隐私|\b(?:password|passport|salary|compensation|marital|gender|sex|ethnicity|disability|religion|birthday|birth.?date|age|citizen|nationality|criminal|emergency|referral|consent|agreement|privacy)\b|\bwork[\s_.-]*authorization\b|\bbackground[\s_.-]*check\b/i;

export function readCurrentFieldValue(field: ScannedField): string {
  const element = field.element;
  if (element instanceof HTMLInputElement) {
    if (element.type === "checkbox" || element.type === "radio") {
      return element.checked ? (element.value || "checked") : "";
    }
    return String(element.value || "").trim();
  }
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
    return String(element.value || "").trim();
  }
  if (element.isContentEditable) {
    return String(element.textContent || "").trim();
  }
  const nestedValue = Array.from(element.querySelectorAll("input, textarea"))
    .map((node) => String((node as HTMLInputElement | HTMLTextAreaElement).value || "").trim())
    .find(Boolean);
  if (nestedValue) return nestedValue;
  const selectedText = element.querySelector(
    '[aria-selected="true"], .ant-select-selection-item, .el-select__selected-item, .arco-select-view-value, .semi-select-selection-text',
  )?.textContent?.trim();
  if (selectedText) return selectedText;
  return String(
    element.getAttribute("data-offeru-selected-value")
    || element.getAttribute("aria-valuetext")
    || "",
  ).trim();
}

function fieldIdentity(field: ScannedField, candidate?: MatchCandidate): string {
  return [
    field.semanticLabel,
    field.label,
    field.name,
    field.placeholder,
    field.level1Title,
    field.level2Title,
    candidate?.intent,
    candidate?.profilePath,
    candidate?.catalogKey,
  ].filter(Boolean).join(" ");
}

function previewValue(value: string, identity: string): string {
  const text = String(value || "").trim();
  if (/邮箱|email/i.test(identity)) {
    const [name, domain] = text.split("@");
    if (name && domain) return `${name.slice(0, 2)}***@${domain}`;
  }
  if (/手机|电话|phone|mobile/i.test(identity) && text.length >= 7) {
    return `${text.slice(0, 3)}****${text.slice(-4)}`;
  }
  return text.length > 32 ? `${text.slice(0, 29)}...` : text;
}

function skipReason(field: ScannedField, candidate: MatchCandidate): CriticalPlanSkippedItem["reason"] | null {
  const identity = fieldIdentity(field, candidate);
  const inputType = field.element instanceof HTMLInputElement
    ? field.element.type.toLowerCase()
    : "";
  if (inputType === "password" || SENSITIVE_FIELD.test(identity)) return "sensitive";
  if (!field.runtime.writable) return "unsupported_control";
  if (field.controlType === "checkbox" || field.controlType === "radio" || field.controlType === "file-upload") {
    return "unsupported_control";
  }
  if (!CRITICAL_FIELD.test(` ${identity} `)) return "not_critical";
  if (candidate.confidence < CRITICAL_CONFIDENCE) return "low_confidence";
  if (readCurrentFieldValue(field)) return "existing_value";
  return null;
}

export function buildCriticalSmartFillPlan(
  fields: ScannedField[],
  candidates: Map<string, MatchCandidate>,
  detection: DetectionResult,
  aiUsed: boolean,
  pageUrl: string,
): CriticalSmartFillPlan {
  const items: CriticalPlanItem[] = [];
  const skipped: CriticalPlanSkippedItem[] = [];

  for (const field of fields) {
    const candidate = candidates.get(field.fieldId);
    const label = (field.semanticLabel || field.label || field.name || "未命名字段").trim();
    if (!candidate) {
      skipped.push({ field, label, reason: "not_critical" });
      continue;
    }
    const reason = skipReason(field, candidate);
    if (reason) {
      skipped.push({ field, label, reason });
      continue;
    }
    items.push({
      field,
      candidate,
      label,
      valuePreview: previewValue(candidate.value, fieldIdentity(field, candidate)),
    });
  }

  return {
    pageUrl,
    createdAt: Date.now(),
    adapterId: detection.adapterId,
    adapterName: detection.adapterName,
    adapterConfidence: detection.confidence,
    aiUsed,
    scannedFields: fields,
    items,
    skipped,
  };
}

export function candidatesFromCriticalPlan(plan: CriticalSmartFillPlan): Map<string, MatchCandidate> {
  return new Map(
    plan.items
      .map((item) => [item.field.fieldId, item.candidate]),
  );
}

export const __CriticalPlanInternals = {
  fieldIdentity,
  previewValue,
  skipReason,
};
