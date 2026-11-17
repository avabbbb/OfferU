// Evidence-based answer scoring and derived camera-behaviour summaries
// (port of services/interview_scoring.py, content-only boundary unchanged).

import { CoreError } from "../types";

export const SCORING_SKILL_SCHEMA = "offeru.interview_scoring_skill.v1";

export type ScoringDimension = {
  key: string;
  label: string;
  weight: number;
  description: string;
  evidence_required: true;
  allow_not_applicable: boolean;
};

export type ScoringSkillDefinition = {
  schema: string;
  skill_id: string;
  version: number;
  name: string;
  scope: "content_only";
  aggregation: "weighted_mean";
  dimensions: ScoringDimension[];
  score_bands: Array<{ min: number; label: string }>;
  prompt_instructions: string[];
  prohibited_outputs: string[];
  behavior_display?: { panels: string[] };
};

/** agents/skills/interview-scoring/references/default-rubric.json, validated (prohibited_outputs sorted). */
export const DEFAULT_SCORING_SKILL: ScoringSkillDefinition = {
  schema: SCORING_SKILL_SCHEMA,
  skill_id: "evidence-interview-score",
  version: 1,
  name: "Evidence-Based Interview Answer Feedback",
  scope: "content_only",
  aggregation: "weighted_mean",
  dimensions: [
    { key: "relevance", label: "回答相关性", weight: 0.35, description: "回答是否针对问题和岗位要求，且没有偏离主题。", evidence_required: true, allow_not_applicable: false },
    { key: "evidence_specificity", label: "事实与证据具体性", weight: 0.3, description: "回答是否提供可核对的事实、行动、范围或结果，而非仅作概括。", evidence_required: true, allow_not_applicable: false },
    { key: "reasoning_structure", label: "思路结构", weight: 0.2, description: "回答是否清楚说明判断依据、行动顺序及行动与结果之间的关系。", evidence_required: true, allow_not_applicable: false },
    { key: "reflection_tradeoffs", label: "复盘与权衡", weight: 0.15, description: "回答是否说明关键取舍、限制、学到的经验或后续改进。", evidence_required: true, allow_not_applicable: true },
  ],
  score_bands: [
    { min: 85, label: "证据充分且回答有力" },
    { min: 70, label: "基本有效" },
    { min: 50, label: "需要加强" },
    { min: 0, label: "证据不足" },
  ],
  prompt_instructions: [
    "只根据问题、岗位证据和候选人的回答评价内容，不推断回答之外的经历。",
    "每个评分维度都必须引用回答中的原句作为 evidence；引用不足时标记缺少证据。",
    "不要补造数字、责任、因果、成果或候选人未陈述的事实。",
    "指出可执行的改进方式，并将内容评价与任何表达行为观察分开。",
  ],
  prohibited_outputs: [
    "combined_score", "cultural_fit", "delivery_score", "emotion", "health",
    "hiring_probability", "honesty", "job_fitness", "personality", "protected_trait",
  ],
};

export const BEHAVIOR_EVENT_TYPES: Record<string, string> = {
  person_missing: "未检测到人物",
  head_drop: "头部下垂",
  forward_lean: "身体前倾",
  shoulder_tilt: "肩线倾斜",
  head_tilt: "头部侧倾",
  lateral_lean: "身体侧向偏移",
  gesture_victory: "比耶手势",
  gesture_thumb_up: "点赞手势",
  gesture_thumb_down: "拇指向下手势",
  gesture_open_palm: "张开手掌",
  gesture_pointing_up: "食指向上",
  gesture_love: "I Love You 手势",
  gesture_closed_fist: "握拳",
  mouth_smile: "嘴角上扬",
  mouth_smile_jaw_open: "嘴角上扬并张嘴",
  jaw_open_brow_raise: "张嘴并抬眉",
  mouth_pucker: "噘嘴动作",
  brow_down_mouth_frown: "眉部下压或嘴角下沉",
};

/** Python interview_scoring._clean_text: collapses whitespace. */
export function cleanText(value: unknown, field: string, limit: number, required = false): string {
  let text: string;
  if (value === null || value === undefined) text = "";
  else if (typeof value === "string") text = value.split(/\s+/).filter(Boolean).join(" ");
  else throw new CoreError(`${field} 必须是字符串`);
  if (required && !text) throw new CoreError(`${field} 不能为空`);
  if ([...text].length > limit) throw new CoreError(`${field} 超过最大长度 ${limit}`);
  return text;
}

const sameKeys = (value: Record<string, unknown>, keys: string[]): boolean => {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => key in value);
};
const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
/** Python round(x, n): nearest decimal of the exact binary value, exact ties to even. */
function pyRound(value: number, digits: number): number {
  const scaled = value * 10 ** digits;
  if (Number.isInteger(scaled * 2) && !Number.isInteger(scaled)) {
    // exact .5 tie only when the scaling itself was exact
    const floor = Math.floor(scaled);
    if (floor / 10 ** digits + 0.5 / 10 ** digits === value) return (floor % 2 === 0 ? floor : floor + 1) / 10 ** digits;
  }
  return Number(value.toFixed(digits));
}
export const round1 = (value: number): number => pyRound(value, 1);
const round4 = (value: number): number => pyRound(value, 4);

export type DimensionEvaluation = {
  score: number;
  evidence: string[];
  missing_evidence: boolean;
  not_applicable: boolean;
  strength: string;
  improvement: string;
};

export type ContentEvaluation = {
  content_score: number;
  score_band: string;
  dimensions: Record<string, DimensionEvaluation>;
  strengths: string[];
  improvements: string[];
  suggestion: string;
  aggregation: "weighted_mean";
  skill_id: string;
  skill_version: number;
  adaptive_follow_up?: unknown;
};

/** Strict check of the model's JSON against the rubric; the server, not the model, aggregates. */
export function validateContentEvaluation(payload: unknown, answer: string, definition: ScoringSkillDefinition): ContentEvaluation {
  if (!isObject(payload) || !sameKeys(payload, ["dimensions", "strengths", "improvements", "suggestion"])) {
    throw new CoreError("模型评价字段与评分 Skill 输出契约不一致");
  }
  const raw = payload.dimensions;
  const expected = definition.dimensions.map((item) => item.key);
  if (!isObject(raw) || !sameKeys(raw, expected)) throw new CoreError("模型评价维度与评分 Skill 不一致");
  const normalizedAnswer = answer.split(/\s+/).filter(Boolean).join(" ");
  const dimensions: Record<string, DimensionEvaluation> = {};
  let applicableWeight = 0;
  let weighted = 0;
  for (const def of definition.dimensions) {
    const key = def.key;
    const item = raw[key];
    if (!isObject(item) || !sameKeys(item, ["score", "evidence", "missing_evidence", "not_applicable", "strength", "improvement"])) {
      throw new CoreError(`维度 ${key} 字段与输出契约不一致`);
    }
    const score = typeof item.score === "number" ? item.score : typeof item.score === "string" && item.score.trim() !== "" ? Number(item.score) : Number.NaN;
    if (!Number.isFinite(score)) throw new CoreError(`维度 ${key}.score 必须是数字`);
    if (score < 0 || score > 100) throw new CoreError(`维度 ${key}.score 超出 0-100`);
    const missing = item.missing_evidence;
    const notApplicable = item.not_applicable;
    if (typeof missing !== "boolean" || typeof notApplicable !== "boolean") throw new CoreError("missing_evidence 与 not_applicable 必须是布尔值");
    if (notApplicable && !def.allow_not_applicable) throw new CoreError(`维度 ${key} 不允许标记为不适用`);
    if (!Array.isArray(item.evidence) || item.evidence.length > 5) throw new CoreError(`维度 ${key}.evidence 必须是最多 5 条的数组`);
    const evidence: string[] = [];
    for (const quote of item.evidence) {
      const clean = cleanText(quote, `${key}.evidence`, 240, true);
      if (!normalizedAnswer.includes(clean)) throw new CoreError(`维度 ${key} 引用了回答中不存在的摘录`);
      if (!evidence.includes(clean)) evidence.push(clean);
    }
    if (notApplicable) {
      if (score !== 0 || evidence.length || missing) throw new CoreError(`维度 ${key} 标记为不适用时 score 必须为 0，且不得附证据或缺证据标记`);
    } else {
      if (missing && evidence.length) throw new CoreError(`维度 ${key} 同时标记缺证据并提供摘录`);
      if (!missing && !evidence.length) throw new CoreError(`维度 ${key} 缺少回答摘录`);
      if (missing && score > 49) throw new CoreError(`维度 ${key} 缺证据时分数不能高于 49`);
      applicableWeight += def.weight;
      weighted += def.weight * score;
    }
    dimensions[key] = {
      score: round1(score),
      evidence,
      missing_evidence: missing,
      not_applicable: notApplicable,
      strength: cleanText(item.strength, `${key}.strength`, 500),
      improvement: cleanText(item.improvement, `${key}.improvement`, 500),
    };
  }
  if (applicableWeight <= 0) throw new CoreError("所有评分维度都被标记为不适用");
  const contentScore = round1(weighted / applicableWeight);
  const band = definition.score_bands.find((item) => contentScore >= item.min)!.label;
  const list = (field: "strengths" | "improvements"): string[] => {
    const values = payload[field];
    if (!Array.isArray(values) || values.length > 8) throw new CoreError(`${field} 必须是最多 8 条的数组`);
    return values.map((value) => cleanText(value, field, 500, true));
  };
  return {
    content_score: contentScore,
    score_band: band,
    dimensions,
    strengths: list("strengths"),
    improvements: list("improvements"),
    suggestion: cleanText(payload.suggestion, "suggestion", 1200),
    aggregation: "weighted_mean",
    skill_id: definition.skill_id,
    skill_version: definition.version,
  };
}

export type BehaviorEvent = {
  event_id: string;
  event_type: string;
  started_ms: number;
  ended_ms: number;
  occurrence_count: number;
  duration_ms: number;
  confidence: number;
  detector_id: string;
  detector_version: string;
  metadata: { question_index?: number };
};

const toInt = (value: unknown): number => {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  if (!Number.isFinite(number)) throw new CoreError("事件时间、次数或置信度类型无效");
  return Math.trunc(number);
};

export function validateBehaviorEvents(events: unknown): BehaviorEvent[] {
  if (!Array.isArray(events) || events.length < 1 || events.length > 200) throw new CoreError("events 必须包含 1-200 条派生事件");
  const seen = new Set<string>();
  const keys = ["event_id", "event_type", "started_ms", "ended_ms", "occurrence_count", "confidence", "detector_id", "detector_version", "metadata"];
  return events.map((item) => {
    if (!isObject(item) || !sameKeys(item, keys)) throw new CoreError("表达行为事件字段与 schema 不一致");
    const eventId = cleanText(item.event_id, "event_id", 64, true);
    if (seen.has(eventId)) throw new CoreError(`批次中 event_id 重复: ${eventId}`);
    seen.add(eventId);
    const eventType = cleanText(item.event_type, "event_type", 60, true);
    if (!(eventType in BEHAVIOR_EVENT_TYPES)) throw new CoreError(`不支持的表达行为事件: ${eventType}`);
    const started = toInt(item.started_ms);
    const ended = toInt(item.ended_ms);
    const count = toInt(item.occurrence_count);
    const confidence = typeof item.confidence === "number" ? item.confidence : Number(item.confidence);
    if (!Number.isFinite(confidence)) throw new CoreError("事件时间、次数或置信度类型无效");
    if (started < 0 || ended < started || ended > 86_400_000) throw new CoreError("事件时间范围无效");
    if (count < 1 || count > 100 || confidence < 0 || confidence > 1) throw new CoreError("事件次数或置信度超出范围");
    const metadata = item.metadata;
    if (!isObject(metadata) || Object.keys(metadata).some((key) => key !== "question_index")) throw new CoreError("事件 metadata 只能包含 question_index");
    const questionIndex = metadata.question_index;
    if (questionIndex !== undefined && questionIndex !== null && (typeof questionIndex !== "number" || !Number.isInteger(questionIndex) || questionIndex < 0)) {
      throw new CoreError("metadata.question_index 必须是非负整数");
    }
    return {
      event_id: eventId,
      event_type: eventType,
      started_ms: started,
      ended_ms: ended,
      occurrence_count: count,
      duration_ms: ended - started,
      confidence: round4(confidence),
      detector_id: cleanText(item.detector_id, "detector_id", 80, true),
      detector_version: cleanText(item.detector_version, "detector_version", 80, true),
      metadata: typeof questionIndex === "number" ? { question_index: questionIndex } : {},
    };
  });
}

export type BehaviorSummary = Record<string, unknown>;

export function buildBehaviorSummary(events: BehaviorEvent[]): BehaviorSummary {
  const counts: Record<string, number> = {};
  const durations: Record<string, number> = {};
  const confidenceTotals: Record<string, number> = {};
  const confidenceWeights: Record<string, number> = {};
  const detectors = new Set<string>();
  const starts: number[] = [];
  const ends: number[] = [];
  const perQuestion: Record<string, { event_counts: Record<string, number>; duration_ms_by_type: Record<string, number> }> = {};
  for (const item of events) {
    const type = item.event_type;
    counts[type] = (counts[type] ?? 0) + item.occurrence_count;
    durations[type] = (durations[type] ?? 0) + item.duration_ms;
    confidenceTotals[type] = (confidenceTotals[type] ?? 0) + item.confidence * item.occurrence_count;
    confidenceWeights[type] = (confidenceWeights[type] ?? 0) + item.occurrence_count;
    detectors.add(`${item.detector_id}@${item.detector_version}`);
    starts.push(item.started_ms);
    ends.push(item.ended_ms);
    const index = item.metadata?.question_index;
    if (typeof index === "number" && index >= 0) {
      const bucket = perQuestion[String(index)] ??= { event_counts: {}, duration_ms_by_type: {} };
      bucket.event_counts[type] = (bucket.event_counts[type] ?? 0) + item.occurrence_count;
      bucket.duration_ms_by_type[type] = (bucket.duration_ms_by_type[type] ?? 0) + item.duration_ms;
    }
  }
  return {
    event_counts: counts,
    duration_ms_by_type: durations,
    average_confidence_by_type: Object.fromEntries(Object.keys(counts).map((type) => [type, round4(confidenceTotals[type] / confidenceWeights[type])])),
    event_labels: Object.fromEntries(Object.keys(counts).map((type) => [type, BEHAVIOR_EVENT_TYPES[type]])),
    detectors: [...detectors].sort(),
    observed_window_ms: starts.length && ends.length ? Math.max(...ends) - Math.min(...starts) : 0,
    per_question: perQuestion,
    privacy: { raw_video_stored: false, frames_stored: false, landmarks_stored: false, face_embeddings_stored: false },
    interpretation_boundary: "仅为可观察表达行为统计，不代表人格、情绪、诚信、岗位胜任力或录用概率",
  };
}

/** Report display: keep only the skill's whitelisted panels (never scored). */
export function filterBehaviorPanels(summary: BehaviorSummary, definition: ScoringSkillDefinition): BehaviorSummary {
  const panels = new Set(definition.behavior_display?.panels ?? []);
  if (!panels.size || !Object.keys(summary).length) return summary;
  const always = new Set(["event_labels", "privacy", "interpretation_boundary"]);
  return Object.fromEntries(Object.entries(summary).filter(([key]) => panels.has(key) || always.has(key)));
}

/** Python json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=False) for the hash. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  if (typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value)) return String(value);
  return JSON.stringify(value);
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
