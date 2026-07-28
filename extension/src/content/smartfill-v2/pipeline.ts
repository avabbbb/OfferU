// One-Click Smart Fill Pipeline Orchestrator
// 8-stage pipeline: detect > expand > addEntries > scan > profile > match > write > verify
import type {
  ScannedField,
  NormalizedProfile,
  SmartFillOutcome,
  PipelineOptions,
  PipelineProgress,
  PipelineResult,
  DetectionResult,
  MatchCandidate,
  WriteResult,
  AiFieldMapping,
  CriticalSmartFillPlan,
} from "./core/types.js";
import { detectSite } from "./ats/detector.js";
import { scanFields } from "./scan/scanner.js";
import { expandEditableSections, addNewEntries, addNewEntriesFromModuleCount } from "./scan/section-expander.js";
import { normalizeProfile, buildFlatFieldEntries, buildProfileSignature } from "./core/schema.js";
import { buildProfileCatalog } from "./core/catalog.js";
import { matchFieldsWithRules, mergeAiCandidates } from "./core/match-engine.js";
import { writeBatch } from "./write/writer.js";
import { logPipelineStage, flushRunLogs, logRunEntry } from "./shared/logger.js";
import { MATCH, AI as AiConst } from "./shared/constants.js";
import { atsRegistry } from "./ats/registry.js";
import { buildCriticalSmartFillPlan, candidatesFromCriticalPlan } from "./core/critical-plan.js";

// These adapters register themselves on import
import "./ats/adapters/feishu.adapter.js";
import "./ats/adapters/beisen.adapter.js";
import "./ats/adapters/moka.adapter.js";
import "./ats/adapters/dayee.adapter.js";
import "./ats/adapters/self-built.adapter.js";
import "./ats/adapters/unknown.adapter.js";
import "./ats/adapters/atsx.adapter.js";
import "./ats/adapters/hotjob.adapter.js";
import "./ats/adapters/alibaba.adapter.js";
import "./ats/adapters/chinatelecom.adapter.js";
import "./ats/adapters/netease.adapter.js";

// Profile cache with TTL — respects backend updates
const PROFILE_CACHE_TTL_MS = 60_000; // 60 seconds
const MAX_SMART_FILL_ROUNDS = 3;
const ROUND_SETTLE_DELAY_MS = 800;
const cachedProfiles = new Map<"full" | "critical", { profile: NormalizedProfile; cachedAt: number }>();

export function invalidateProfileCache(): void {
  cachedProfiles.clear();
}

export async function loadProfile(scope: "full" | "critical" = "full"): Promise<NormalizedProfile> {
  const now = Date.now();
  const cached = cachedProfiles.get(scope);
  if (cached && (now - cached.cachedAt) < PROFILE_CACHE_TTL_MS) {
    return cached.profile;
  }
  try {
    const response = await chrome.runtime.sendMessage({ type: "GET_SMART_FILL_PROFILE", scope });
    // P0-1 fix: background sends { ok, profile } not { ok, data }
    const rawProfile = response?.profile || response?.data;
    if (response?.ok && rawProfile) {
      const profile = normalizeProfile(rawProfile);
      cachedProfiles.set(scope, { profile, cachedAt: now });
      return profile;
    }
  } catch { /* background not available */ }
  const emptyProfile = normalizeProfile(null);
  cachedProfiles.set(scope, { profile: emptyProfile, cachedAt: now });
  return emptyProfile;
}

export async function getAiSettings(): Promise<{
  enabled: boolean;
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}> {
  try {
    const response = await chrome.runtime.sendMessage({ type: "GET_SMART_FILL_SETTINGS" });
    // Background returns { ok: true, settings } not { ok: true, data }
    const settings = response?.settings || response?.data;
    if (response?.ok && settings) return settings;
  } catch { /* ignore */ }
  return { enabled: false };
}

export async function requestAiMapping(
  fields: ScannedField[],
  profile: NormalizedProfile,
  adapterHint: string,
): Promise<AiFieldMapping[]> {
  try {
    const fieldCandidates = fields.map((f) => ({
      fieldId: f.fieldId,
      label: f.label || f.semanticLabel,
      // Module-qualified label helps AI disambiguate (e.g., "教育经历 / 开始时间" vs "实习经历 / 开始时间")
      qualifiedLabel: f.qualifiedLabel || (f.moduleName ? `${f.moduleName} / ${f.label || f.semanticLabel}` : (f.label || f.semanticLabel)),
      controlType: f.controlType,
      moduleName: f.moduleName,
      level1Title: f.level1Title,
      level2Title: f.level2Title,
      repeatGroupIndex: f.repeatGroupIndex,
      structureToken: f.structureToken,
      nearbyText: f.nearbyText?.slice(0, 100) || "",
      options: f.options.slice(0, 8).map((o) => o.text),
      isRequired: f.isRequired,
    }));

    const catalog = buildProfileCatalog(profile).map((item) => ({
      key: item.key,
      path: item.path,
      label: item.label,
      categoryKey: item.categoryKey,
      categoryLabel: item.categoryLabel,
      sectionType: item.sectionType,
      itemIndex: item.itemIndex,
      valueType: item.valueType,
      aliases: item.aliases,
      sourceRef: item.sourceRef,
      signature: item.signature,
    }));

    const response = await chrome.runtime.sendMessage({
      type: "SMART_FILL_AI_MAP",
      fields: fieldCandidates,
      catalog,
      adapterHint,
      pageUrl: window.location.href,
    });

    if (response?.ok && response.mappings) {
      return response.mappings as AiFieldMapping[];
    }
  } catch { /* AI unavailable */ }
  return [];
}

export async function requestFieldMap(
  fields: ScannedField[],
): Promise<Map<string, MatchCandidate>> {
  const candidates = new Map<string, MatchCandidate>();
  if (fields.length === 0) return candidates;

  try {
    const fragments = fields.map((f) => ({
      module_name: f.level1Title || f.moduleName || "",
      field_label: f.semanticLabel || f.label || "",
      item_index: f.repeatGroupIndex || f.occurrenceIndex || 0,
    })).filter((fr) => fr.module_name && fr.field_label);

    if (fragments.length === 0) return candidates;

    const response = await chrome.runtime.sendMessage({
      type: "SMART_FILL_FIELD_MAP",
      fragments,
    });

    if (response?.ok && Array.isArray(response.mappings)) {
      for (const mapping of response.mappings) {
        if (mapping.match_type === "NONE" || !mapping.value) continue;
        const matchedField = fields.find((f) => {
          const modMatch = (f.level1Title || f.moduleName || "") === mapping.module_name;
          const lblMatch = (f.semanticLabel || f.label || "") === mapping.field_label;
          const idxMatch = (f.repeatGroupIndex || f.occurrenceIndex || 0) === (mapping.item_index || 0);
          return modMatch && lblMatch && idxMatch;
        });
        if (matchedField) {
          candidates.set(matchedField.fieldId, {
            fieldId: matchedField.fieldId,
            value: mapping.value,
            confidence: 1.0,
            intent: mapping.field_label,
            source: "field-map",
            occurrenceIndex: mapping.item_index || 0,
          });
        }
      }
    }
  } catch { /* field-map unavailable */ }
  return candidates;
}

async function resolveCandidates(
  fields: ScannedField[],
  profile: NormalizedProfile,
  detection: DetectionResult,
  aliases: Record<string, string>,
  allowFullProfileFieldMap = true,
): Promise<{ candidates: Map<string, MatchCandidate>; aiUsed: boolean }> {
  const catalog = buildProfileCatalog(profile);
  let candidates = new Map<string, MatchCandidate>();
  let aiUsed = false;

  if (allowFullProfileFieldMap) {
    try {
      candidates = await requestFieldMap(fields);
    } catch { /* field-map unavailable */ }
  }

  const ruleCandidates = matchFieldsWithRules(fields, profile, aliases);
  for (const [fieldId, candidate] of ruleCandidates) {
    if (!candidates.has(fieldId)) candidates.set(fieldId, candidate);
  }

  try {
    const aiSettings = await getAiSettings();
    if (aiSettings.enabled && (profile.availableCount || 0) > 0) {
      const unmatched = fields.filter((field) => !candidates.has(field.fieldId));
      if (unmatched.length > 0) {
        const aiMappings = await requestAiMapping(unmatched, profile, detection.adapterId);
        if (aiMappings.length > 0) {
          candidates = mergeAiCandidates(
            candidates,
            aiMappings,
            MATCH.aiConfidenceThreshold,
            catalog,
            fields,
          );
          aiUsed = true;
        }
      }
    }
  } catch { /* AI unavailable; deterministic candidates remain usable */ }

  return { candidates, aiUsed };
}

export async function prepareCriticalSmartFillPlan(
  options?: PipelineOptions,
): Promise<CriticalSmartFillPlan> {
  const { signal, onProgress } = options || {};
  const report = (stage: PipelineProgress) => onProgress?.(stage);

  report({ stage: "detect", detail: "正在识别当前网申页面", percent: 10 });
  const detection = detectSite(document, window.location.href);
  const adapter = atsRegistry.get(detection.adapterId);
  const selectorOverrides = adapter?.getSelectorOverrides?.();

  report({ stage: "scan", detail: "正在扫描可填写字段", percent: 35 });
  const fields = await scanFields(document, {
    adapter: {
      supportedFrameworks: detection.capabilities.supportedFrameworks as string[],
      sectionExpandSelectors: detection.capabilities.sectionExpandSelectors,
      pageStructure: selectorOverrides?.pageStructure,
    },
    labelSelector: selectorOverrides?.labelSelector,
    containerSelector: selectorOverrides?.containerSelector,
    sectionSelector: selectorOverrides?.sectionSelector,
    expandSections: false,
    signal,
  });
  if (signal?.aborted) throw new Error("Aborted");

  report({ stage: "profile", detail: "正在读取已确认档案", percent: 55 });
  const profile = await loadProfile("critical");
  if ((profile.availableCount || 0) <= 0) {
    throw new Error("档案中暂无可填写信息");
  }

  report({ stage: "match", detail: "正在生成关键字段填写计划", percent: 75 });
  const { candidates, aiUsed } = await resolveCandidates(
    fields,
    profile,
    detection,
    adapter?.getIntentAliases?.() || {},
    false,
  );
  const plan = buildCriticalSmartFillPlan(
    fields,
    candidates,
    detection,
    aiUsed,
    window.location.href,
  );
  logPipelineStage("match", `关键字段计划: ${plan.items.length} 项`, {
    scannedCount: fields.length,
    skippedCount: plan.skipped.length,
    aiUsed,
  });
  report({ stage: "verify", detail: "计划已生成，等待确认", percent: 100 });
  return plan;
}

export async function applyCriticalSmartFillPlan(
  plan: CriticalSmartFillPlan,
  options?: PipelineOptions,
): Promise<PipelineResult> {
  const { signal, onProgress } = options || {};
  const report = (stage: PipelineProgress) => onProgress?.(stage);
  if (plan.pageUrl !== window.location.href) {
    throw new Error("页面已变化，请重新扫描");
  }
  if (Date.now() - plan.createdAt > 2 * 60_000) {
    throw new Error("填写计划已过期，请重新扫描");
  }
  if (signal?.aborted) throw new Error("Aborted");

  const candidates = candidatesFromCriticalPlan(plan);
  const fields = plan.items.map((item) => item.field);
  report({ stage: "write", detail: `正在填写 ${fields.length} 个关键字段`, percent: 55 });
  const results = await writeBatch(fields, candidates, {
    signal,
    adapterId: plan.adapterId,
    preserveExistingValues: true,
    onFieldDone: (result) => {
      logRunEntry({
        scope: "smart-fill.field",
        severity: result.written ? "info" : "warn",
        payload: { mode: "critical-confirmed", ...result },
      });
    },
  });

  report({ stage: "verify", detail: "正在回读校验填写结果", percent: 90 });
  const outcome = evaluateOutcome(
    plan.items.map((item) => item.field),
    results,
    plan.aiUsed,
  );
  const relevantSkipped = plan.skipped.filter((item) => item.reason !== "not_critical");
  outcome.skippedCount += relevantSkipped.length;
  outcome.protectedCount += relevantSkipped.filter((item) => (
    item.reason === "existing_value" || item.reason === "sensitive"
  )).length;
  outcome.submitReadiness = false;
  logPipelineStage("verify", `关键字段填写完成: ${outcome.filledCount}/${plan.items.length}`, {
    filledCount: outcome.filledCount,
    pendingCount: outcome.pendingCount,
    preservedExistingCount: outcome.protectedCount,
    skippedCount: outcome.skippedCount,
  });
  report({ stage: "verify", detail: "关键字段填写完成", percent: 100 });

  return {
    fields: plan.items.map((item) => item.field),
    outcome,
    adapterId: plan.adapterId,
    adapterName: plan.adapterName,
    adapterConfidence: plan.adapterConfidence,
    aiUsed: plan.aiUsed,
  };
}

export async function runSmartFillPipeline(
  options?: PipelineOptions,
): Promise<PipelineResult> {
  const { signal, onProgress } = options || {};
  const report = (stage: PipelineProgress) => onProgress?.(stage);

  // Stage 1: DETECT - identify ATS system
  report({ stage: "detect", detail: "正在识别网站", percent: 5 });
  const detection = detectSite(document, window.location.href);
  logPipelineStage("detect", detection.adapterName, { confidence: detection.confidence });

  // Stage 2: EXPAND - expand dynamic sections
  report({ stage: "expand", detail: "展开可编辑区域", percent: 10 });
  const adapter = atsRegistry.get(detection.adapterId);
  const selectorOverrides = adapter?.getSelectorOverrides?.();
  await expandEditableSections({
    editLabels: adapter?.getSectionExpandInstructions?.()
      ?.flatMap((s) => [s.expandButtonText]) || undefined,
    sectionExpandSelectors: detection.capabilities.sectionExpandSelectors,
    signal,
  });

  // Stage 2.5: ADD ENTRIES - click "add" buttons to create new entry rows
  report({ stage: "addEntries", detail: "添加新条目", percent: 15 });
  const profile = await loadProfile();
  const catalog = buildProfileCatalog(profile);

  let moduleCountMap = new Map<string, number>();
  try {
    const mcResponse = await chrome.runtime.sendMessage({ type: "SMART_FILL_MODULE_COUNT" });
    if (mcResponse?.ok && Array.isArray(mcResponse.modules)) {
      for (const mod of mcResponse.modules) {
        moduleCountMap.set(mod.module_name, mod.count);
      }
    }
  } catch { /* module-count unavailable */ }

  if (moduleCountMap.size > 0) {
    await addNewEntriesFromModuleCount(moduleCountMap, {
      signal,
      adapterAddInstructions: adapter?.getAddButtonInstructions?.(),
    });
  } else {
    await addNewEntries(profile, { signal });
  }

  const scanOptions = {
    adapter: {
      supportedFrameworks: detection.capabilities.supportedFrameworks as string[],
      sectionExpandSelectors: detection.capabilities.sectionExpandSelectors,
      pageStructure: selectorOverrides?.pageStructure,
    },
    labelSelector: selectorOverrides?.labelSelector,
    containerSelector: selectorOverrides?.containerSelector,
    sectionSelector: selectorOverrides?.sectionSelector,
    signal,
  };

  // Stage 4: PROFILE - profile already loaded in addEntries stage
  report({ stage: "profile", detail: "读取档案数据", percent: 30 });

  const aliases = adapter?.getIntentAliases?.() || {};
  let aiUsed = false;
  const allFields: ScannedField[] = [];
  const allResults: WriteResult[] = [];
  let lastRoundFields: ScannedField[] = [];

  for (let roundIndex = 1; roundIndex <= MAX_SMART_FILL_ROUNDS; roundIndex++) {
    // Stage 3: SCAN - scan DOM for form fields
    report({ stage: "scan", detail: `正在扫描表单字段 (${roundIndex}/${MAX_SMART_FILL_ROUNDS})`, percent: roundIndex === 1 ? 20 : 80 });
    const fields = (await scanFields(document, scanOptions))
      .filter((field) => field.element.getAttribute("data-offeru-filled") !== "1");
    if (signal?.aborted) throw new Error("Aborted");
    lastRoundFields = fields;
    mergeScannedFields(allFields, fields);
    logPipelineStage("scan", `第 ${roundIndex} 轮发现 ${fields.length} 个待填字段`);

    if (fields.length === 0) break;
    if (roundIndex === 1 && fields.length === 0) {
      return {
        fields: [],
        outcome: emptyOutcome(),
        adapterId: detection.adapterId,
        adapterName: detection.adapterName,
        adapterConfidence: detection.confidence,
        aiUsed: false,
      };
    }

    // Stage 6: MATCH - deterministic field-map + rule-based + AI field matching
    report({ stage: "match", detail: `正在匹配字段 (${roundIndex}/${MAX_SMART_FILL_ROUNDS})`, percent: 50 });

    let candidates = new Map<string, MatchCandidate>();

    try {
      const fieldMapCandidates = await requestFieldMap(fields);
      if (fieldMapCandidates.size > 0) {
        candidates = fieldMapCandidates;
      }
    } catch { /* field-map failed, fall through to rules */ }

    const ruleCandidates = matchFieldsWithRules(fields, profile, aliases as Record<string, string>);
    for (const [fieldId, candidate] of ruleCandidates) {
      if (!candidates.has(fieldId)) {
        candidates.set(fieldId, candidate);
      }
    }

    // AI mapping for unmatched fields
    report({ stage: "match", detail: `AI 正在匹配字段 (${roundIndex}/${MAX_SMART_FILL_ROUNDS})`, percent: 70 });
    try {
      const aiSettings = await getAiSettings();
      if (aiSettings.enabled && (profile.availableCount || 0) > 0) {
        const unmatched = fields.filter((f) => !candidates.has(f.fieldId));
        if (unmatched.length > 0) {
          const aiMappings = await requestAiMapping(unmatched, profile, detection.adapterId);
          if (aiMappings.length > 0) {
            candidates = mergeAiCandidates(
              candidates,
              aiMappings,
              MATCH.aiConfidenceThreshold,
              catalog,
              fields,
            );
            aiUsed = true;
          }
        }
      }
    } catch { /* AI failed, continue with rule candidates */ }

    // Stage 7: WRITE - write values to fields
    report({ stage: "write", detail: `正在填写表单 (${roundIndex}/${MAX_SMART_FILL_ROUNDS})`, percent: 80 });
    const results = await writeBatch(fields, candidates, {
      signal,
      adapterId: detection.adapterId,
      optionSelectorConfig: selectorOverrides?.optionSelectorConfig,
      onFieldDone: (result) => {
        logRunEntry({
          scope: "smart-fill.field",
          severity: result.written ? "info" : "warn",
          payload: { roundIndex, ...result },
        });
      },
    });
    allResults.push(...results);

    const wroteCount = results.filter((result) => result.written || result.recovered).length;
    if (wroteCount === 0) break;
    await sleep(ROUND_SETTLE_DELAY_MS);
  }

  const fields = allFields.length > 0 ? allFields : lastRoundFields;
  if (fields.length === 0) {
    return {
      fields: [],
      outcome: emptyOutcome(),
      adapterId: detection.adapterId,
      adapterName: detection.adapterName,
      adapterConfidence: detection.confidence,
      aiUsed: false,
    };
  }

  // Stage 8: VERIFY - evaluate results
  report({ stage: "verify", detail: "检查填写结果", percent: 95 });
  const outcome = evaluateOutcome(fields, allResults, aiUsed);

  logPipelineStage("verify", `填写完成: ${outcome.filledCount}/${outcome.matchedCount}`, {
    filledCount: outcome.filledCount,
    pendingCount: outcome.pendingCount,
    aiUsed,
  });

  return {
    fields,
    outcome,
    adapterId: detection.adapterId,
    adapterName: detection.adapterName,
    adapterConfidence: detection.confidence,
    aiUsed,
  };
}

function mergeScannedFields(target: ScannedField[], incoming: ScannedField[]): void {
  const seen = new Set(target.map((field) => field.structureToken || field.cssPath || field.fieldId));
  for (const field of incoming) {
    const key = field.structureToken || field.cssPath || field.fieldId;
    if (seen.has(key)) continue;
    seen.add(key);
    target.push(field);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function evaluateOutcome(
  fields: ScannedField[],
  results: WriteResult[],
  aiUsed: boolean,
): SmartFillOutcome {
  const resultMap = new Map(results.map((r) => [r.fieldId, r]));
  const filled: WriteResult[] = [];
  const pending: ScannedField[] = [];
  const protectedFields: ScannedField[] = [];
  const matchedIds = new Set(results.map((r) => r.fieldId));

  for (const field of fields) {
    const result = resultMap.get(field.fieldId);
    if (result?.written) {
      filled.push(result);
    } else if (result?.failureReason === "existing_value") {
      field.runtime.failureReason = "existing_value";
      protectedFields.push(field);
    } else {
      // Tag field with reason: no_match vs write_failed vs write_blocked
      if (!matchedIds.has(field.fieldId)) {
        field.runtime.failureReason = "no_match";
      } else if (result && !result.written) {
        field.runtime.failureReason = result.failureReason || "write_failed";
      }
      pending.push(field);
    }
  }

  const requiredTotal = fields.filter((f) => f.isRequired).length;
  const requiredFilled = fields.filter(
    (f) => f.isRequired && resultMap.get(f.fieldId)?.verified,
  ).length;

  return {
    scannedFields: fields,
    results,
    filledCount: filled.length,
    matchedCount: results.filter((r) => r.written || r.recovered).length,
    pendingFields: pending,
    pendingCount: pending.length,
    skippedCount: protectedFields.length,
    protectedCount: protectedFields.length,
    requiredTotal,
    requiredFilled,
    submitReadiness: pending.filter((f) => f.isRequired).length === 0,
    aiUsed,
    aiChannel: aiUsed ? "plugin-direct" : "none",
  };
}

function emptyOutcome(): SmartFillOutcome {
  return {
    scannedFields: [],
    results: [],
    filledCount: 0,
    matchedCount: 0,
    pendingFields: [],
    pendingCount: 0,
    skippedCount: 0,
    protectedCount: 0,
    requiredTotal: 0,
    requiredFilled: 0,
    submitReadiness: false,
    aiUsed: false,
    aiChannel: "none",
  };
}

export const __PipelineInternals = {
  evaluateOutcome,
  emptyOutcome,
};
