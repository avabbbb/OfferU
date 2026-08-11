// =============================================
// SiteRulePack v1 — 运行时 schema validator
// 拒绝未知字段（additionalProperties: false 语义）、非法 driver/selector/
// path-glob、缺失 fixture、疑似 secret 等。错误消息不回显字段原文。
// =============================================

import type { SiteRulePackV1 } from "./contracts.js";
import {
  SCHEMA_VERSION,
  PACK_ID_PATTERN,
  SEMVER_PATTERN,
  HOST_PATTERN,
  PATH_GLOB_PATTERN,
  HOST_MIN,
  HOST_MAX,
  PAGES_MIN,
  PAGES_MAX,
  SIGNALS_MAX,
  FIXTURES_MIN,
  CANDIDATES_MAX,
  CSS_MAX_LENGTH,
  MAX_MATCHES_MIN,
  MAX_MATCHES_MAX,
  WEIGHT_MIN,
  WEIGHT_MAX,
  DISPLAY_NAME_MAX,
  TOKEN_MAX_LENGTH,
  ALIASES_MAX,
  CONTROLS_MAX,
  LABELS_MAX,
  CAPABILITIES,
  DRIVER_IDS,
  NORMALIZER_IDS,
  SELECTOR_STABILITIES,
  SELECTOR_SCOPES,
  READ_MODES,
  ATTRIBUTE_NAMES,
  PAGE_KIND_FIELD,
  DRIVER_ROLE_REQUIREMENTS,
  FEISHU_TREE_ROLES,
  FEISHU_DATE_ROLES,
  SECRET_PATTERNS,
} from "./schema.js";
import { checkSelectorSyntax } from "./selector-syntax.js";

export interface ValidationError {
  path: string;
  code: string;
  message: string;
}

export type ValidationResult =
  | { ok: true; pack: SiteRulePackV1 }
  | { ok: false; errors: ValidationError[] };

export function validatePack(input: unknown): ValidationResult {
  const errors: ValidationError[] = [];
  validateSiteRulePack(errors, "$", input);
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, pack: input as SiteRulePackV1 };
}

// ---------- helpers ----------

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function isNonEmptyString(input: unknown): input is string {
  return typeof input === "string" && input.length > 0;
}

function isInteger(input: unknown): input is number {
  return typeof input === "number" && Number.isInteger(input);
}

function push(errors: ValidationError[], path: string, code: string, message: string): void {
  errors.push({ path, code, message });
}

function checkUnknownFields(
  errors: ValidationError[],
  path: string,
  input: Record<string, unknown>,
  allowed: readonly string[],
): void {
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) {
      push(errors, `${path}.${key}`, "unknown-field", `unknown field "${key}" is not allowed`);
    }
  }
}

function checkPlainString(
  errors: ValidationError[],
  path: string,
  input: unknown,
  maxLength: number,
  secretCheck: boolean,
): input is string {
  if (!isNonEmptyString(input)) {
    push(errors, path, "invalid-string", "expected a non-empty string");
    return false;
  }
  if (input.length > maxLength) {
    push(errors, path, "too-long", `string exceeds max length ${maxLength}`);
    return false;
  }
  if (/[\u0000-\u001f\u007f]/.test(input)) {
    push(errors, path, "control-chars", "control characters are not allowed");
    return false;
  }
  if (secretCheck && SECRET_PATTERNS.some((re) => re.test(input))) {
    push(errors, path, "suspicious-secret", "value looks like a secret or real form value");
    return false;
  }
  return true;
}

function checkEnum(
  errors: ValidationError[],
  path: string,
  input: unknown,
  allowed: Record<string, true>,
  label: string,
): input is string {
  if (!isNonEmptyString(input) || allowed[input] !== true) {
    push(errors, path, "invalid-enum", `unknown ${label}`);
    return false;
  }
  return true;
}

/** 仓库内相对脱敏路径：非绝对、无 ..、无反斜杠、无盘符、不指向 Niuke */
function checkRepoPath(
  errors: ValidationError[],
  path: string,
  input: unknown,
  suffix: string,
): input is string {
  if (!checkPlainString(errors, path, input, 200, true)) return false;
  if (input.startsWith("/") || input.startsWith("\\") || /^[A-Za-z]:/.test(input)) {
    push(errors, path, "absolute-path", "path must be repo-relative");
    return false;
  }
  const segments = input.split("/");
  if (segments.some((s) => s === ".." || s.length === 0)) {
    push(errors, path, "unsafe-path", "path must not contain empty or parent segments");
    return false;
  }
  if (segments.some((s) => s.toLowerCase() === "niuke")) {
    push(errors, path, "niuke-path", "path must not reference Niuke");
    return false;
  }
  if (!/^[A-Za-z0-9_./-]+$/.test(input)) {
    push(errors, path, "unsafe-path", "path contains unsupported characters");
    return false;
  }
  if (!input.endsWith(suffix)) {
    push(errors, path, "wrong-extension", `path must end with ${suffix}`);
    return false;
  }
  return true;
}

// ---------- 顶层 ----------

function validateSiteRulePack(errors: ValidationError[], path: string, input: unknown): void {
  if (!isRecord(input)) {
    push(errors, path, "not-object", "pack must be an object");
    return;
  }
  checkUnknownFields(errors, path, input, [
    "schemaVersion",
    "id",
    "version",
    "status",
    "displayName",
    "hosts",
    "pages",
    "fixtures",
    "provenance",
  ]);

  if (input.schemaVersion !== SCHEMA_VERSION) {
    push(errors, `${path}.schemaVersion`, "unsupported-schema", `schemaVersion must be "${SCHEMA_VERSION}"`);
  }
  if (!isNonEmptyString(input.id) || !PACK_ID_PATTERN.test(input.id)) {
    push(errors, `${path}.id`, "invalid-pack-id", "id must match ^(portal|ats|employer|fixture)\\.[a-z0-9-]+(\\.[a-z0-9-]+)*$");
  }
  if (!isNonEmptyString(input.version) || !SEMVER_PATTERN.test(input.version)) {
    push(errors, `${path}.version`, "invalid-semver", "version must be strict semver");
  }
  if (!checkEnum(errors, `${path}.status`, input.status, { experimental: true, verified: true, disabled: true }, "status")) {
    return;
  }
  const status = input.status as string;

  if (input.displayName === undefined) {
    push(errors, `${path}.displayName`, "invalid-display-name", "displayName is required");
  } else {
    checkPlainString(errors, `${path}.displayName`, input.displayName, DISPLAY_NAME_MAX, true);
  }

  if (!Array.isArray(input.hosts) || input.hosts.length < HOST_MIN || input.hosts.length > HOST_MAX) {
    push(errors, `${path}.hosts`, "host-count", `hosts must contain ${HOST_MIN}-${HOST_MAX} entries`);
  } else {
    input.hosts.forEach((host, i) => validateHostRule(errors, `${path}.hosts[${i}]`, host));
  }

  if (!Array.isArray(input.pages) || input.pages.length < PAGES_MIN || input.pages.length > PAGES_MAX) {
    push(errors, `${path}.pages`, "page-count", `pages must contain ${PAGES_MIN}-${PAGES_MAX} entries`);
  } else {
    const pageIds = new Set<string>();
    input.pages.forEach((page, i) => {
      const pagePath = `${path}.pages[${i}]`;
      if (isRecord(page) && isNonEmptyString(page.id)) {
        if (pageIds.has(page.id)) push(errors, `${pagePath}.id`, "duplicate-id", "duplicate page rule id");
        pageIds.add(page.id);
      }
      validatePageRule(errors, pagePath, page, status);
    });
  }

  validateFixtures(errors, `${path}.fixtures`, input.fixtures, input.pages, status);
  validateProvenance(errors, `${path}.provenance`, input.provenance, status);
}

function validateHostRule(errors: ValidationError[], path: string, input: unknown): void {
  if (!isRecord(input)) {
    push(errors, path, "not-object", "host rule must be an object");
    return;
  }
  checkUnknownFields(errors, path, input, ["kind", "value"]);
  if (!checkEnum(errors, `${path}.kind`, input.kind, { exact: true, suffix: true }, "host rule kind")) return;
  if (!isNonEmptyString(input.value) || !HOST_PATTERN.test(input.value)) {
    push(errors, `${path}.value`, "invalid-host", "host must be lowercase ascii hostname without scheme/port/path/wildcard");
  }
}

// ---------- PageRule ----------

function validatePageRule(errors: ValidationError[], path: string, input: unknown, packStatus: string): void {
  if (!isRecord(input)) {
    push(errors, path, "not-object", "page rule must be an object");
    return;
  }
  checkUnknownFields(errors, path, input, ["id", "kind", "match", "capabilities", "jobList", "jobDetail", "form", "receipt"]);
  if (!checkPlainString(errors, `${path}.id`, input.id, 80, false)) return;
  if (!checkEnum(errors, `${path}.kind`, input.kind, {
    "job-list": true,
    "job-detail": true,
    "application-form": true,
    "submission-receipt": true,
  }, "page kind")) return;
  const kind = input.kind as string;

  validateMatchRule(errors, `${path}.match`, input.match);

  if (!Array.isArray(input.capabilities)) {
    push(errors, `${path}.capabilities`, "invalid-capabilities", "capabilities must be an array");
  } else {
    const seen = new Set<string>();
    input.capabilities.forEach((cap, i) => {
      if (isNonEmptyString(cap)) {
        if (CAPABILITIES[cap] !== true) {
          push(errors, `${path}.capabilities[${i}]`, "unknown-capability", "unknown or forbidden capability");
        } else if (seen.has(cap)) {
          push(errors, `${path}.capabilities[${i}]`, "duplicate-capability", "duplicate capability");
        }
        seen.add(cap);
      } else {
        push(errors, `${path}.capabilities[${i}]`, "invalid-string", "capability must be a string");
      }
    });
  }

  const kindField = PAGE_KIND_FIELD[kind];
  const config = input[kindField.must];
  const mustPath = `${path}.${kindField.must}`;
  if (config === undefined) {
    push(errors, mustPath, "missing-kind-config", `page kind ${kind} requires ${kindField.must}`);
  } else if (kind === "job-list") {
    validateJobListRule(errors, mustPath, config);
  } else if (kind === "job-detail") {
    validateJobDetailRule(errors, mustPath, config);
  } else if (kind === "application-form") {
    validateFormRule(errors, mustPath, config);
  } else {
    validateReceiptRule(errors, mustPath, config);
  }
  for (const forbid of kindField.forbid) {
    if (input[forbid] !== undefined) {
      push(errors, `${path}.${forbid}`, "kind-config-conflict", `page kind ${kind} must not contain ${forbid}`);
    }
  }

  // verified 规则不能仅靠 title token 或一个低权重信号命中
  if (packStatus === "verified" && isRecord(input.match) && Array.isArray(input.match.signals)) {
    const structural = input.match.signals.some((s) => {
      if (!isRecord(s)) return false;
      if (s.polarity !== "positive") return false;
      const type = s.type;
      const weight = s.weight;
      return (
        (type === "path-glob" || type === "script-host" || type === "css-exists") &&
        isInteger(weight) &&
        weight >= 30
      );
    });
    if (!structural) {
      push(errors, `${path}.match.signals`, "verified-weak-detection", "verified rule needs a structural positive signal (path-glob/script-host/css-exists, weight>=30)");
    }
  }
}

function validateMatchRule(errors: ValidationError[], path: string, input: unknown): void {
  if (!isRecord(input)) {
    push(errors, path, "not-object", "match rule must be an object");
    return;
  }
  checkUnknownFields(errors, path, input, ["minScore", "minPositiveSignals", "ambiguityMargin", "signals"]);
  if (!isInteger(input.minScore) || input.minScore < 0 || input.minScore > 10000) {
    push(errors, `${path}.minScore`, "invalid-number", "minScore must be an integer 0-10000");
  }
  if (!isInteger(input.minPositiveSignals) || input.minPositiveSignals < 1 || input.minPositiveSignals > 20) {
    push(errors, `${path}.minPositiveSignals`, "invalid-number", "minPositiveSignals must be an integer 1-20");
  }
  if (!isInteger(input.ambiguityMargin) || input.ambiguityMargin < 0 || input.ambiguityMargin > 1000) {
    push(errors, `${path}.ambiguityMargin`, "invalid-number", "ambiguityMargin must be an integer 0-1000");
  }
  if (!Array.isArray(input.signals) || input.signals.length < 1 || input.signals.length > SIGNALS_MAX) {
    push(errors, `${path}.signals`, "signal-count", `signals must contain 1-${SIGNALS_MAX} entries`);
    return;
  }
  const signalIds = new Set<string>();
  input.signals.forEach((signal, i) => {
    const signalPath = `${path}.signals[${i}]`;
    if (isRecord(signal) && isNonEmptyString(signal.id)) {
      if (signalIds.has(signal.id)) push(errors, `${signalPath}.id`, "duplicate-id", "duplicate signal id");
      signalIds.add(signal.id);
    }
    validateDetectionSignal(errors, signalPath, signal);
  });
}

function validateDetectionSignal(errors: ValidationError[], path: string, input: unknown): void {
  if (!isRecord(input)) {
    push(errors, path, "not-object", "detection signal must be an object");
    return;
  }
  checkUnknownFields(errors, path, input, ["id", "type", "polarity", "value", "weight", "veto"]);
  if (!checkPlainString(errors, `${path}.id`, input.id, 80, false)) return;
  if (!checkEnum(errors, `${path}.type`, input.type, {
    "path-glob": true,
    "title-token": true,
    "meta-token": true,
    "script-host": true,
    "css-exists": true,
  }, "signal type")) return;
  const type = input.type as string;
  if (!checkEnum(errors, `${path}.polarity`, input.polarity, { positive: true, negative: true }, "polarity")) return;
  const polarity = input.polarity as string;
  if (input.veto === true && polarity !== "negative") {
    push(errors, `${path}.veto`, "veto-not-negative", "veto is only allowed on negative signals");
  }
  if (input.veto !== undefined && input.veto !== true && input.veto !== false) {
    push(errors, `${path}.veto`, "invalid-boolean", "veto must be boolean");
  }
  if (!isInteger(input.weight) || input.weight < WEIGHT_MIN || input.weight > WEIGHT_MAX) {
    push(errors, `${path}.weight`, "invalid-weight", `weight must be an integer ${WEIGHT_MIN}-${WEIGHT_MAX}`);
  }

  if (type === "path-glob") {
    if (
      !isNonEmptyString(input.value) ||
      !PATH_GLOB_PATTERN.test(input.value) ||
      !input.value.startsWith("/") ||
      input.value === "/**" ||
      /\*{3,}/.test(input.value)
    ) {
      push(errors, `${path}.value`, "invalid-path-glob", "path-glob must be /-anchored, chars [A-Za-z0-9/_*.-], single * or ** only");
    }
  } else if (type === "title-token" || type === "meta-token") {
    if (!checkPlainString(errors, `${path}.value`, input.value, TOKEN_MAX_LENGTH, true)) return;
    const token = input.value as string;
    if (!/^[A-Za-z0-9\s\-_.:：，。、'"()（）%#&+]+$/.test(token)) {
      push(errors, `${path}.value`, "invalid-token", "token contains unsupported characters");
    }
  } else if (type === "script-host") {
    if (!isNonEmptyString(input.value) || !HOST_PATTERN.test(input.value)) {
      push(errors, `${path}.value`, "invalid-host", "script-host must be a plain hostname");
    }
  } else {
    // css-exists：value 是单个 CSS selector 字符串
    if (!checkPlainString(errors, `${path}.value`, input.value, CSS_MAX_LENGTH, true)) return;
    const syntaxError = checkSelectorSyntax(input.value);
    if (syntaxError) push(errors, `${path}.value`, "invalid-selector", syntaxError);
  }
}

// ---------- Selector / Read ----------

function validateSelectorSet(errors: ValidationError[], path: string, input: unknown): void {
  if (!isRecord(input)) {
    push(errors, path, "not-object", "selector set must be an object");
    return;
  }
  checkUnknownFields(errors, path, input, ["scope", "candidates", "required", "maxMatches"]);
  if (!checkEnum(errors, `${path}.scope`, input.scope, SELECTOR_SCOPES, "selector scope")) return;
  if (!Array.isArray(input.candidates) || input.candidates.length < 1 || input.candidates.length > CANDIDATES_MAX) {
    push(errors, `${path}.candidates`, "candidate-count", `candidates must contain 1-${CANDIDATES_MAX} entries`);
    return;
  }
  input.candidates.forEach((candidate, i) => {
    const candidatePath = `${path}.candidates[${i}]`;
    if (!isRecord(candidate)) {
      push(errors, candidatePath, "not-object", "selector candidate must be an object");
      return;
    }
    checkUnknownFields(errors, candidatePath, candidate, ["css", "stability"]);
    if (checkPlainString(errors, `${candidatePath}.css`, candidate.css, CSS_MAX_LENGTH, true)) {
      const syntaxError = checkSelectorSyntax(candidate.css);
      if (syntaxError) push(errors, `${candidatePath}.css`, "invalid-selector", syntaxError);
    }
    checkEnum(errors, `${candidatePath}.stability`, candidate.stability, SELECTOR_STABILITIES, "selector stability");
  });
  if (typeof input.required !== "boolean") {
    push(errors, `${path}.required`, "invalid-boolean", "required must be boolean");
  }
  if (!isInteger(input.maxMatches) || input.maxMatches < MAX_MATCHES_MIN || input.maxMatches > MAX_MATCHES_MAX) {
    push(errors, `${path}.maxMatches`, "invalid-max-matches", `maxMatches must be an integer ${MAX_MATCHES_MIN}-${MAX_MATCHES_MAX}`);
  }
}

function validateReadRule(errors: ValidationError[], path: string, input: unknown): void {
  if (!isRecord(input)) {
    push(errors, path, "not-object", "read rule must be an object");
    return;
  }
  checkUnknownFields(errors, path, input, ["selectors", "mode", "attribute", "normalize"]);
  validateSelectorSet(errors, `${path}.selectors`, input.selectors);
  if (!checkEnum(errors, `${path}.mode`, input.mode, READ_MODES, "read mode")) return;
  const mode = input.mode as string;
  if (input.attribute !== undefined) {
    if (mode !== "attribute") {
      push(errors, `${path}.attribute`, "attribute-mode-only", "attribute is only allowed with mode=attribute");
    } else if (!checkEnum(errors, `${path}.attribute`, input.attribute, ATTRIBUTE_NAMES, "attribute name")) {
      return;
    }
  }
  if (!Array.isArray(input.normalize)) {
    push(errors, `${path}.normalize`, "invalid-normalize", "normalize must be an array");
    return;
  }
  if (input.normalize.length > 8) {
    push(errors, `${path}.normalize`, "too-many", "normalize allows at most 8 entries");
  }
  input.normalize.forEach((n, i) => {
    if (!isNonEmptyString(n) || NORMALIZER_IDS[n] !== true) {
      push(errors, `${path}.normalize[${i}]`, "unknown-normalizer", "unknown normalizer id");
    }
  });
}

// ---------- Job 规则 ----------

function validateJobFieldRules(errors: ValidationError[], path: string, input: unknown): void {
  if (!isRecord(input)) {
    push(errors, path, "not-object", "job fields must be an object");
    return;
  }
  checkUnknownFields(errors, path, input, [
    "title",
    "company",
    "description",
    "location",
    "salary",
    "applyUrl",
    "postedAt",
    "tags",
    "companyTags",
    "sourceId",
  ]);
  for (const required of ["title", "company", "description"]) {
    if (input[required] === undefined) {
      push(errors, `${path}.${required}`, "missing-field", `${required} is required`);
    } else {
      validateReadRule(errors, `${path}.${required}`, input[required]);
    }
  }
  for (const optional of ["location", "salary", "applyUrl", "postedAt", "tags", "companyTags", "sourceId"]) {
    if (input[optional] !== undefined) validateReadRule(errors, `${path}.${optional}`, input[optional]);
  }
}

function validateJobListRule(errors: ValidationError[], path: string, input: unknown): void {
  if (!isRecord(input)) {
    push(errors, path, "not-object", "job list rule must be an object");
    return;
  }
  checkUnknownFields(errors, path, input, ["root", "item", "itemId", "fields"]);
  if (input.root !== undefined) validateSelectorSet(errors, `${path}.root`, input.root);
  validateSelectorSet(errors, `${path}.item`, input.item);
  if (input.itemId !== undefined) validateReadRule(errors, `${path}.itemId`, input.itemId);
  validateJobFieldRules(errors, `${path}.fields`, input.fields);
}

function validateJobDetailRule(errors: ValidationError[], path: string, input: unknown): void {
  if (!isRecord(input)) {
    push(errors, path, "not-object", "job detail rule must be an object");
    return;
  }
  checkUnknownFields(errors, path, input, ["root", "fields"]);
  if (input.root !== undefined) validateSelectorSet(errors, `${path}.root`, input.root);
  validateJobFieldRules(errors, `${path}.fields`, input.fields);
}

// ---------- Form ----------

function validateFormRule(errors: ValidationError[], path: string, input: unknown): void {
  if (!isRecord(input)) {
    push(errors, path, "not-object", "form rule must be an object");
    return;
  }
  checkUnknownFields(errors, path, input, [
    "root",
    "fieldCandidates",
    "fieldContainer",
    "labels",
    "sections",
    "repeats",
    "ignore",
    "aliases",
    "controls",
  ]);
  validateSelectorSet(errors, `${path}.root`, input.root);
  validateSelectorSet(errors, `${path}.fieldCandidates`, input.fieldCandidates);
  if (input.fieldContainer !== undefined) validateSelectorSet(errors, `${path}.fieldContainer`, input.fieldContainer);
  if (input.ignore !== undefined) validateSelectorSet(errors, `${path}.ignore`, input.ignore);

  if (!Array.isArray(input.labels) || input.labels.length > LABELS_MAX) {
    push(errors, `${path}.labels`, "labels-count", `labels must be an array of at most ${LABELS_MAX} entries`);
  } else {
    input.labels.forEach((label, i) => validateSelectorSet(errors, `${path}.labels[${i}]`, label));
  }

  if (input.sections !== undefined) {
    const s = input.sections;
    if (!isRecord(s)) {
      push(errors, `${path}.sections`, "not-object", "sections must be an object");
    } else {
      checkUnknownFields(errors, `${path}.sections`, s, ["section", "heading"]);
      validateSelectorSet(errors, `${path}.sections.section`, s.section);
      validateSelectorSet(errors, `${path}.sections.heading`, s.heading);
    }
  }

  if (input.repeats !== undefined) {
    const r = input.repeats;
    if (!isRecord(r)) {
      push(errors, `${path}.repeats`, "not-object", "repeats must be an object");
    } else {
      checkUnknownFields(errors, `${path}.repeats`, r, ["item", "heading", "countMarker", "order"]);
      validateSelectorSet(errors, `${path}.repeats.item`, r.item);
      if (r.heading !== undefined) validateSelectorSet(errors, `${path}.repeats.heading`, r.heading);
      if (r.countMarker !== undefined) validateSelectorSet(errors, `${path}.repeats.countMarker`, r.countMarker);
      checkEnum(errors, `${path}.repeats.order`, r.order, { dom: true, "reverse-dom": true }, "repeat order");
    }
  }

  if (!Array.isArray(input.aliases) || input.aliases.length > ALIASES_MAX) {
    push(errors, `${path}.aliases`, "aliases-count", `aliases must be an array of at most ${ALIASES_MAX} entries`);
  } else {
    input.aliases.forEach((alias, i) => {
      const aliasPath = `${path}.aliases[${i}]`;
      if (!isRecord(alias)) {
        push(errors, aliasPath, "not-object", "intent alias must be an object");
        return;
      }
      checkUnknownFields(errors, aliasPath, alias, ["canonicalIntent", "aliases", "sectionHint"]);
      checkPlainString(errors, `${aliasPath}.canonicalIntent`, alias.canonicalIntent, 100, true);
      if (alias.sectionHint !== undefined) {
        checkPlainString(errors, `${aliasPath}.sectionHint`, alias.sectionHint, 100, true);
      }
      if (!Array.isArray(alias.aliases) || alias.aliases.length < 1 || alias.aliases.length > 20) {
        push(errors, `${aliasPath}.aliases`, "alias-count", "aliases must contain 1-20 entries");
      } else {
        const aliasSeen = new Set<string>();
        alias.aliases.forEach((a, j) => {
          const aPath = `${aliasPath}.aliases[${j}]`;
          if (!checkPlainString(errors, aPath, a, 100, true)) return;
          if (aliasSeen.has(a)) push(errors, aPath, "duplicate-id", "duplicate alias");
          aliasSeen.add(a);
        });
      }
    });
  }

  if (!Array.isArray(input.controls) || input.controls.length > CONTROLS_MAX) {
    push(errors, `${path}.controls`, "controls-count", `controls must be an array of at most ${CONTROLS_MAX} entries`);
  } else {
    const controlIds = new Set<string>();
    input.controls.forEach((control, i) => {
      const controlPath = `${path}.controls[${i}]`;
      if (isRecord(control) && isNonEmptyString(control.id)) {
        if (controlIds.has(control.id)) push(errors, `${controlPath}.id`, "duplicate-id", "duplicate control binding id");
        controlIds.add(control.id);
      }
      validateControlBinding(errors, controlPath, control);
    });
  }
}

function validateControlBinding(errors: ValidationError[], path: string, input: unknown): void {
  if (!isRecord(input)) {
    push(errors, path, "not-object", "control binding must be an object");
    return;
  }
  checkUnknownFields(errors, path, input, ["id", "when", "driverId", "selectors"]);
  checkPlainString(errors, `${path}.id`, input.id, 80, false);
  validateSelectorSet(errors, `${path}.when`, input.when);
  if (!isNonEmptyString(input.driverId) || DRIVER_IDS[input.driverId] !== true) {
    push(errors, `${path}.driverId`, "unknown-driver", "unknown or forbidden control driver");
    return;
  }
  const driverId = input.driverId as string;
  const requirements = DRIVER_ROLE_REQUIREMENTS[driverId];
  const selectors = input.selectors;

  if (driverId === "native") {
    if (selectors !== undefined) {
      push(errors, `${path}.selectors`, "native-no-selectors", "native driver must not declare selector roles");
    }
    return;
  }
  if (!isRecord(selectors)) {
    push(errors, `${path}.selectors`, "not-object", "selectors must be an object");
    return;
  }
  const allowedRoles = [...requirements.required, ...requirements.optional];
  checkUnknownFields(errors, `${path}.selectors`, selectors, allowedRoles);
  for (const role of requirements.required) {
    if (selectors[role] === undefined) {
      push(errors, `${path}.selectors.${role}`, "missing-role", `driver ${driverId} requires selector role ${role}`);
    } else {
      validateSelectorSet(errors, `${path}.selectors.${role}`, selectors[role]);
    }
  }
  for (const role of requirements.optional) {
    if (selectors[role] !== undefined) validateSelectorSet(errors, `${path}.selectors.${role}`, selectors[role]);
  }
  if (driverId === "feishu") {
    const treePresent = FEISHU_TREE_ROLES.filter((role) => selectors[role] !== undefined);
    const datePresent = FEISHU_DATE_ROLES.filter((role) => selectors[role] !== undefined);
    if (treePresent.length > 0 && treePresent.length < FEISHU_TREE_ROLES.length) {
      push(errors, `${path}.selectors`, "incomplete-tree-roles", "feishu tree roles must be declared as a complete set");
    }
    if (datePresent.length === 1) {
      push(errors, `${path}.selectors`, "incomplete-date-roles", "feishu calendar-panel and date-cell must be declared together");
    }
  }
}

// ---------- Receipt ----------

function validateReceiptRule(errors: ValidationError[], path: string, input: unknown): void {
  if (!isRecord(input)) {
    push(errors, path, "not-object", "receipt rule must be an object");
    return;
  }
  checkUnknownFields(errors, path, input, [
    "requiresActiveFillSession",
    "minScore",
    "minPositiveGroups",
    "positiveGroups",
    "negativeSignals",
    "evidence",
  ]);
  if (input.requiresActiveFillSession !== true) {
    push(errors, `${path}.requiresActiveFillSession`, "session-required", "receipt rules must require an active fill session");
  }
  if (!isInteger(input.minScore) || input.minScore < 0 || input.minScore > 10000) {
    push(errors, `${path}.minScore`, "invalid-number", "minScore must be an integer 0-10000");
  }
  if (!isInteger(input.minPositiveGroups) || input.minPositiveGroups < 2 || input.minPositiveGroups > 10) {
    push(errors, `${path}.minPositiveGroups`, "invalid-number", "minPositiveGroups must be an integer 2-10");
  }
  if (!Array.isArray(input.positiveGroups) || input.positiveGroups.length < 2) {
    push(errors, `${path}.positiveGroups`, "group-count", "at least two independent positive groups are required");
  } else {
    const groupIds = new Set<string>();
    input.positiveGroups.forEach((group, i) => {
      const groupPath = `${path}.positiveGroups[${i}]`;
      if (!isRecord(group)) {
        push(errors, groupPath, "not-object", "receipt signal group must be an object");
        return;
      }
      checkUnknownFields(errors, groupPath, group, ["id", "anyOf"]);
      if (isNonEmptyString(group.id)) {
        if (groupIds.has(group.id)) push(errors, `${groupPath}.id`, "duplicate-id", "duplicate signal group id");
        groupIds.add(group.id);
      }
      if (!Array.isArray(group.anyOf) || group.anyOf.length < 1) {
        push(errors, `${groupPath}.anyOf`, "signal-count", "anyOf must contain at least one signal");
      } else {
        group.anyOf.forEach((signal, j) => validateReceiptSignal(errors, `${groupPath}.anyOf[${j}]`, signal));
      }
    });
  }
  if (!Array.isArray(input.negativeSignals)) {
    push(errors, `${path}.negativeSignals`, "invalid-array", "negativeSignals must be an array");
  } else {
    input.negativeSignals.forEach((signal, i) => validateReceiptSignal(errors, `${path}.negativeSignals[${i}]`, signal));
  }
  if (input.evidence !== undefined) {
    const evidence = input.evidence;
    if (!isRecord(evidence)) {
      push(errors, `${path}.evidence`, "not-object", "evidence must be an object");
    } else {
      checkUnknownFields(errors, `${path}.evidence`, evidence, ["applicationId", "company", "role"]);
      for (const key of ["applicationId", "company", "role"]) {
        if (evidence[key] !== undefined) validateReadRule(errors, `${path}.evidence.${key}`, evidence[key]);
      }
    }
  }
}

function validateReceiptSignal(errors: ValidationError[], path: string, input: unknown): void {
  if (!isRecord(input)) {
    push(errors, path, "not-object", "receipt signal must be an object");
    return;
  }
  checkUnknownFields(errors, path, input, ["type", "value", "weight", "veto"]);
  if (!checkEnum(errors, `${path}.type`, input.type, {
    "path-glob": true,
    "title-token": true,
    "css-exists": true,
    "visible-token": true,
  }, "receipt signal type")) return;
  const type = input.type as string;
  if (!isInteger(input.weight) || input.weight < WEIGHT_MIN || input.weight > WEIGHT_MAX) {
    push(errors, `${path}.weight`, "invalid-weight", `weight must be an integer ${WEIGHT_MIN}-${WEIGHT_MAX}`);
  }
  if (input.veto !== undefined && input.veto !== true && input.veto !== false) {
    push(errors, `${path}.veto`, "invalid-boolean", "veto must be boolean");
  }
  if (type === "path-glob") {
    if (
      !isNonEmptyString(input.value) ||
      !PATH_GLOB_PATTERN.test(input.value) ||
      !input.value.startsWith("/") ||
      input.value === "/**" ||
      /\*{3,}/.test(input.value)
    ) {
      push(errors, `${path}.value`, "invalid-path-glob", "path-glob must be /-anchored, chars [A-Za-z0-9/_*.-], single * or ** only");
    }
  } else if (type === "title-token" || type === "visible-token") {
    if (!checkPlainString(errors, `${path}.value`, input.value, TOKEN_MAX_LENGTH, true)) return;
    const token = input.value as string;
    if (!/^[A-Za-z0-9\s\-_.:：，。、'"()（）%#&+]+$/.test(token)) {
      push(errors, `${path}.value`, "invalid-token", "token contains unsupported characters");
    }
  } else {
    // css-exists：value 是完整 SelectorSet
    validateSelectorSet(errors, `${path}.value`, input.value);
  }
}

// ---------- Fixture 与 provenance ----------

function validateFixtures(
  errors: ValidationError[],
  path: string,
  input: unknown,
  pages: unknown,
  packStatus: string,
): void {
  if (!Array.isArray(input) || input.length < FIXTURES_MIN) {
    push(errors, path, "fixture-count", `fixtures must contain at least ${FIXTURES_MIN} entry`);
    return;
  }
  const pageKinds = new Set<string>();
  if (Array.isArray(pages)) {
    for (const page of pages) {
      if (isRecord(page) && isNonEmptyString(page.kind)) pageKinds.add(page.kind);
    }
  }
  const fixtureIds = new Set<string>();
  const rolesByKind = new Map<string, Set<string>>();
  const ruleIds = new Set<string>();
  if (Array.isArray(pages)) {
    for (const page of pages) {
      if (isRecord(page) && isNonEmptyString(page.id)) ruleIds.add(page.id);
    }
  }
  input.forEach((fixture, i) => {
    const fixturePath = `${path}[${i}]`;
    if (!isRecord(fixture)) {
      push(errors, fixturePath, "not-object", "fixture ref must be an object");
      return;
    }
    checkUnknownFields(errors, fixturePath, fixture, ["id", "pageKind", "role", "path", "sanitized", "expectedRuleId"]);
    if (isNonEmptyString(fixture.id)) {
      if (fixtureIds.has(fixture.id)) push(errors, `${fixturePath}.id`, "duplicate-id", "duplicate fixture id");
      fixtureIds.add(fixture.id);
    } else {
      push(errors, `${fixturePath}.id`, "invalid-string", "fixture id is required");
    }
    if (!checkEnum(errors, `${fixturePath}.pageKind`, fixture.pageKind, {
      "job-list": true,
      "job-detail": true,
      "application-form": true,
      "submission-receipt": true,
    }, "page kind")) return;
    if (!checkEnum(errors, `${fixturePath}.role`, fixture.role, {
      positive: true,
      "near-negative": true,
      conflict: true,
    }, "fixture role")) return;
    checkRepoPath(errors, `${fixturePath}.path`, fixture.path, ".html");
    if (fixture.sanitized !== true) {
      push(errors, `${fixturePath}.sanitized`, "not-sanitized", "fixtures must be marked sanitized=true");
    }
    if (fixture.expectedRuleId !== undefined) {
      if (!isNonEmptyString(fixture.expectedRuleId) || !ruleIds.has(fixture.expectedRuleId)) {
        push(errors, `${fixturePath}.expectedRuleId`, "unknown-rule", "expectedRuleId must reference an existing page rule id");
      }
    }
    const kind = fixture.pageKind as string;
    const roles = rolesByKind.get(kind) ?? new Set<string>();
    roles.add(fixture.role as string);
    rolesByKind.set(kind, roles);
  });

  // verified pack：每个 page kind 必须有正例、近似反例和冲突证据
  if (packStatus === "verified") {
    for (const kind of pageKinds) {
      const roles = rolesByKind.get(kind);
      for (const role of ["positive", "near-negative", "conflict"]) {
        if (!roles || !roles.has(role)) {
          push(errors, path, "missing-fixture", `verified page kind ${kind} requires a ${role} fixture`);
        }
      }
    }
  }
}

function validateProvenance(errors: ValidationError[], path: string, input: unknown, packStatus: string): void {
  if (!isRecord(input)) {
    push(errors, path, "not-object", "provenance must be an object");
    return;
  }
  checkUnknownFields(errors, path, input, ["owner", "method", "capturedFrom", "notesPath", "lastVerifiedAt"]);
  if (input.owner !== "offeru") {
    push(errors, `${path}.owner`, "invalid-owner", "provenance owner must be offeru");
  }
  checkEnum(errors, `${path}.method`, input.method, { "first-party": true, "clean-room": true }, "provenance method");
  checkEnum(errors, `${path}.capturedFrom`, input.capturedFrom, {
    "public-page": true,
    "user-authorized-page": true,
    synthetic: true,
  }, "capturedFrom");
  checkRepoPath(errors, `${path}.notesPath`, input.notesPath, ".md");
  if (input.lastVerifiedAt !== undefined) {
    if (!isNonEmptyString(input.lastVerifiedAt) || !/^\d{4}-\d{2}-\d{2}$/.test(input.lastVerifiedAt)) {
      push(errors, `${path}.lastVerifiedAt`, "invalid-date", "lastVerifiedAt must be YYYY-MM-DD");
    }
  } else if (packStatus === "verified") {
    push(errors, `${path}.lastVerifiedAt`, "missing-verified-date", "verified packs must record lastVerifiedAt");
  }
}
