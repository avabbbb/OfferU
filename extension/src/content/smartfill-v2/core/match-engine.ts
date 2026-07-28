// Text-based field-entry matching engine
// score each field x entry pair using text matching + semantic gating + occurrence tracking
import type { ScannedField, NormalizedProfile, MatchCandidate, AiFieldMapping, ProfileEntry, ProfileCatalogItem } from "./types.js";
import { resolveCatalogItem } from "./catalog.js";
import { applyTransform, isCatalogCompatibleWithField, isProfileEntryCompatibleWithField, normalizeTransform } from "./value-gates.js";
import { textMatchScore, normalizeText, compactText, expandMatchVariants, isJsonStringValue } from "../shared/text-utils.js";
import { classifyFieldBucket, isBucketCompatible, SemanticBucket } from "./semantic-buckets.js";
import { findGroupByText } from "./equality-groups.js";
import { MATCH } from "../shared/constants.js";

// Prohibit cross-category matches that are clearly wrong
const INCOMPATIBLE_CATEGORY_PAIRS: Array<[RegExp, RegExp]> = [
  [/家庭|亲属|family/i, /教育|学校|school/i],
  [/家庭|亲属|family/i, /项目|project/i],
  [/教育|学校|school/i, /家庭|亲属|family/i],
  [/语言|language/i, /项目|project/i],
  [/证书|certif/i, /教育|学校/i],
];

const WEAK_FIELD_LABEL = /^(时间|日期|开始时间|结束时间|起止时间|名称|描述|职责|内容|证明人)$/;

function areCategoriesCompatible(a: string, b: string): boolean {
  if (!a || !b) return true;
  if (a === b) return true;
  for (const [pa, pb] of INCOMPATIBLE_CATEGORY_PAIRS) {
    if (pa.test(a) && pb.test(b)) return false;
  }
  return true;
}

// Score a single field against a single profile entry
function scoreFieldEntry(
  field: ScannedField,
  entry: ProfileEntry,
): number {
  const fieldLabel = normalizeText(field.semanticLabel || field.label);
  const fieldCombined = compactText([
    fieldLabel, field.placeholder, field.name, field.nearbyText,
    ...field.options.map((o) => o.text.slice(0, 20)),
  ].join(" "));
  const entryCombined = compactText([entry.label, entry.category, ...entry.aliases].join(" "));

  if (!fieldCombined || !entryCombined) return 0;

  if (isWeakFieldLabel(fieldLabel) && !hasReliableStructureContext(field, entry)) {
    return 0;
  }

  // Category incompatibility gate
  const fieldCategory = field.level1Title || field.moduleName || "";
  if (!areCategoriesCompatible(fieldCategory, entry.category)) return 0;

  // Direct text match (max across multiple comparisons)
  let directScore = 0;
  directScore = Math.max(directScore, textMatchScore(fieldCombined, entry.label));
  directScore = Math.max(directScore, textMatchScore(fieldLabel, entry.label));
  for (const alias of entry.aliases) {
    directScore = Math.max(directScore, textMatchScore(fieldCombined, alias));
    directScore = Math.max(directScore, textMatchScore(fieldLabel, alias));
  }
  if (directScore <= 0) return 0;

  let score = directScore * 10; // base: 10-120

  // === Category context matching (critical for disambiguation) ===
  // Strong bonus when field context matches entry category (e.g., 教育经历 vs 教育经历)
  const fieldContext = [
    field.level1Title,
    field.level2Title,
    field.qualifiedLabel,
    field.moduleName,
    field.nearbyText,
  ].filter(Boolean).join(" ").toLowerCase();
  const entryCategoryLower = entry.category.toLowerCase();

  // Category exact match: field is in "教育经历" section and entry is from "教育经历" category
  score += textMatchScore(fieldContext, entryCategoryLower) * 8; // up to +96

  // Category keyword in field context: field context contains "教育" or entry is education
  const isContextMatch = entryCategoryLower && entryCategoryLower.length > 2
    && fieldContext.includes(entryCategoryLower.slice(0, 2));
  if (isContextMatch) score += 6;

  // Semantic bucket match bonus
  const fieldBucket = classifyFieldBucket(fieldLabel, field.controlType, fieldContext);
  const entryBucket = classifyFieldBucket(entry.label, "input", entry.category);
  if (fieldBucket !== SemanticBucket.CUSTOM && entryBucket !== SemanticBucket.CUSTOM && fieldBucket === entryBucket) {
    score += 8;
  }

  // Options match bonus - value found in field options
  if (field.options.length > 0) {
    const hasMatch = field.options.some(
      (o) => normalizeText(o.text).includes(normalizeText(entry.value)) || normalizeText(entry.value).includes(normalizeText(o.text)),
    );
    if (hasMatch) score += 5;
  }

  // Required field bonus
  if (field.isRequired) score += 2;

  // === Occurrence match bonus (critical for multi-item disambiguation) ===
  score += getOccurrenceMatchBonus(field, entry);

  // Entry already used penalty (to spread entries across repeated fields)
  // Applied during batch matching, not individual scoring

  return score;
}

function getEntryOccurrenceIndex(entry: ProfileEntry): number {
  if (entry.itemIndex) return entry.itemIndex;
  if (entry.subsection) {
    const subMatch = entry.subsection.match(/第(\d+)条/);
    if (subMatch) return Number(subMatch[1]);
  }
  const text = [entry.subsection, entry.category].filter(Boolean).join(" ");
  const match = text.match(/(?:经历|信息|证书|奖惩|家庭|教育|工作\/实习|实习|项目|社团|学生工作)?\s*(\d+)/);
  return match ? (Number(match[1]) || 0) : 0;
}

function getOccurrenceMatchBonus(field: ScannedField, entry: ProfileEntry): number {
  const fieldIndex = field.repeatGroupIndex || field.occurrenceIndex || 0;
  const fieldTotal = field.occurrenceTotal || 0;
  const entryIndex = getEntryOccurrenceIndex(entry);

  if (!fieldIndex || (!field.repeatGroupIndex && fieldTotal <= 1) || !entryIndex) return 0;

  return fieldIndex === entryIndex ? 18 : -14;
}

function isWeakFieldLabel(label: string): boolean {
  return WEAK_FIELD_LABEL.test(normalizeText(label).replace(/_.+$/, ""));
}

function hasReliableStructureContext(field: ScannedField, entry: ProfileEntry): boolean {
  const fieldCategory = field.level1Title || field.moduleName || "";
  const hasCategory = Boolean(fieldCategory && entry.category && categoryTextMatches(fieldCategory, entry.category));
  const entryIndex = getEntryOccurrenceIndex(entry);
  const hasGroup = !entryIndex || !field.repeatGroupIndex || field.repeatGroupIndex === entryIndex;
  return hasCategory && hasGroup;
}

function categoryTextMatches(fieldCategory: string, entryCategory: string): boolean {
  const a = normalizeText(fieldCategory);
  const b = normalizeText(entryCategory);
  if (!a || !b) return false;
  if (a.includes(b) || b.includes(a)) return true;
  const aCore = a.replace(/经历|经验|背景|信息|档案|情况/g, "");
  const bCore = b.replace(/经历|经验|背景|信息|档案|情况/g, "");
  return Boolean(aCore && bCore && (aCore.includes(bCore) || bCore.includes(aCore)));
}

export function matchFieldsWithRules(
  fields: ScannedField[],
  profile: NormalizedProfile,
  adapterAliases: Record<string, string>,
): Map<string, MatchCandidate> {
  const candidates = new Map<string, MatchCandidate>();
  const usedEntries = new Set<number>();

  // Build reverse alias index: canonical intent → list of ATS-specific labels
  const reverseAliases = new Map<string, string[]>();
  for (const [atsLabel, intent] of Object.entries(adapterAliases)) {
    const list = reverseAliases.get(intent) || [];
    list.push(normalizeText(atsLabel).toLowerCase());
    reverseAliases.set(intent, list);
  }

  // Sort fields: required first, then by quality score
  const sorted = [...fields].sort((a, b) => {
    if (a.isRequired !== b.isRequired) return a.isRequired ? -1 : 1;
    return b.qualityScore - a.qualityScore;
  });

  for (const field of sorted) {
    let bestEntry: ProfileEntry | null = null;
    let bestScore = 0;

    // Pre-compute adapter alias match: does the field label match any ATS alias?
    // Collect all matching intents, prefer longest alias match for disambiguation
    const fieldLabelNorm = normalizeText(field.label || field.semanticLabel).toLowerCase();
    const matchedIntents = new Map<string, number>(); // intent → alias length
    for (const [atsLabel, intent] of Object.entries(adapterAliases)) {
      const aliasNorm = normalizeText(atsLabel).toLowerCase();
      if (!aliasNorm) continue;
      // Short aliases (< 3 chars normalized): exact match only to avoid false positives
      // (e.g., "名" matching "姓名" would be wrong; "家属姓名" containing "姓名" is fine)
      if (aliasNorm.length < 3) {
        if (fieldLabelNorm === aliasNorm) {
          matchedIntents.set(intent, Math.max(matchedIntents.get(intent) || 0, aliasNorm.length));
        }
      } else {
        if (fieldLabelNorm === aliasNorm || fieldLabelNorm.includes(aliasNorm)) {
          matchedIntents.set(intent, Math.max(matchedIntents.get(intent) || 0, aliasNorm.length));
        }
      }
    }
    // Pick the intent with the longest matching alias (most specific match)
    let aliasMatchedIntent = "";
    let aliasMaxLen = 0;
    for (const [intent, len] of matchedIntents) {
      if (len > aliasMaxLen) { aliasMaxLen = len; aliasMatchedIntent = intent; }
    }

    for (const entry of profile.entries) {
      if (!entry.value) continue;
      if (isJsonStringValue(entry.value)) continue;
      if (!isProfileEntryCompatibleWithField(field, entry)) continue;

      let score = scoreFieldEntry(field, entry);

      // Adapter alias bonus: if field label matches ATS alias and entry label matches the alias target intent
      if (aliasMatchedIntent) {
        const entryLabelNorm = normalizeText(entry.label).toLowerCase();
        const aliasTargets = reverseAliases.get(aliasMatchedIntent) || [];
        if (aliasTargets.some((t) => entryLabelNorm.includes(t) || t.includes(entryLabelNorm))
          || entry.aliases.some((a) => aliasTargets.includes(normalizeText(a).toLowerCase()))) {
          score += 12; // strong bonus for ATS-aligned match
        }
      }

      // Smarter used-entry penalty: don't penalize if occurrence indices match
      // This allows "第2条" entries to match the 2nd occurrence of a field
      // even when "第1条" entries were already used for the 1st occurrence
      let adjustedScore = score;
      if (usedEntries.has(entry.index)) {
        const fieldOccIdx = field.repeatGroupIndex || field.occurrenceIndex || 0;
        const entryOccIdx = getEntryOccurrenceIndex(entry);
        if (fieldOccIdx > 1 && entryOccIdx === fieldOccIdx) {
          adjustedScore = score;
        } else {
          adjustedScore = score * 0.5;
        }
      }

      if (adjustedScore > bestScore) {
        bestScore = adjustedScore;
        bestEntry = entry;
      }
    }

    if (bestEntry && bestScore >= MATCH.minAcceptableConfidence * 10) {
      candidates.set(field.fieldId, {
        fieldId: field.fieldId,
        value: bestEntry.value,
        confidence: Math.min(bestScore / 120, 1.0), // normalize to 0-1
        intent: bestEntry.label,
        source: "rule",
        occurrenceIndex: bestEntry.index,
        profilePath: bestEntry.path || bestEntry.key,
        catalogKey: bestEntry.key,
        valueType: bestEntry.valueType,
      });
      usedEntries.add(bestEntry.index);
    }
  }

  return candidates;
}

export function mergeAiCandidates(
  ruleCandidates: Map<string, MatchCandidate>,
  aiMappings: AiFieldMapping[],
  minConfidence: number,
  catalog: ProfileCatalogItem[] = [],
  fields: ScannedField[] = [],
): Map<string, MatchCandidate> {
  const merged = new Map(ruleCandidates);
  const fieldById = new Map(fields.map((field) => [field.fieldId, field]));

  for (const ai of aiMappings) {
    if (ai.confidence < minConfidence) continue;
    const profilePath = ai.profilePath || ai.catalogKey || ai.sourcePath || ai.resumePath || "";
    const catalogItem = resolveCatalogItem(catalog, profilePath);
    const field = fieldById.get(ai.fieldId);

    let value = "";
    let intent = ai.intent || catalogItem?.label || "";
    let occurrenceIndex = ai.itemIndex || catalogItem?.itemIndex || 0;
    if (catalogItem) {
      const transform = normalizeTransform(ai.transform);
      if (field && !isCatalogCompatibleWithField(field, catalogItem, transform)) continue;
      value = applyTransform(catalogItem.value, transform);
    } else {
      continue;
    }

    if (!value || isJsonStringValue(value)) continue;

    const existing = merged.get(ai.fieldId);
    if (existing && existing.source === "rule" && existing.confidence >= MATCH.ruleBypassAiThreshold && !isWeakFieldLabel(existing.intent)) {
      continue;
    }
    if (!existing || ai.confidence > existing.confidence) {
      merged.set(ai.fieldId, {
        fieldId: ai.fieldId,
        value,
        confidence: ai.confidence,
        intent,
        source: "ai",
        occurrenceIndex,
        profilePath: catalogItem?.path || ai.profilePath || ai.sourcePath || ai.resumePath,
        catalogKey: catalogItem?.key || ai.catalogKey,
        valueType: catalogItem?.valueType,
        transform: ai.transform ? normalizeTransform(ai.transform) : undefined,
        reason: ai.reason,
      });
    }
  }

  return merged;
}

export const __MatchEngineInternals = {
  scoreFieldEntry,
  areCategoriesCompatible,
  getOccurrenceMatchBonus,
  getEntryOccurrenceIndex,
  isWeakFieldLabel,
  hasReliableStructureContext,
  categoryTextMatches,
};
