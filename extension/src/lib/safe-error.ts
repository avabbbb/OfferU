const MAX_ERROR_LENGTH = 240;

const REDACTION_RULES: Array<[RegExp, string]> = [
  [
    /(?:https?|wss?):\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?[^\s)]*/gi,
    "[local endpoint]",
  ],
  [
    /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|bearer|password|secret|cookie))\s*[:=]\s*[^\s,;]+/gi,
    "$1=[redacted]",
  ],
  [/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}\b/gi, "[credential]"],
  [/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/gi, "[credential]"],
  [/\bAIza[A-Za-z0-9_-]{20,}\b/gi, "[credential]"],
  [/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email]"],
  [/(?:\+?86[-\s]?)?1[3-9]\d{9}\b/g, "[phone]"],
];

const SAFE_DEBUG_KEYS = new Set([
  "adapterId",
  "adapterName",
  "aiUsed",
  "channel",
  "confidence",
  "detail",
  "errorCode",
  "extracted",
  "fallbackUsed",
  "filledCount",
  "final",
  "key",
  "mappings",
  "mode",
  "pendingCount",
  "preservedExistingCount",
  "runId",
  "scannedCount",
  "severity",
  "skippedCount",
  "scope",
  "stage",
  "timestamp",
  "total",
]);

/** Keep extension-facing errors useful without exposing provider or PII data. */
export function safeExtensionError(value: unknown, fallback = "操作失败"): string {
  const raw = value instanceof Error ? value.message : typeof value === "string" ? value : "";
  let text = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return fallback;
  for (const [pattern, replacement] of REDACTION_RULES) {
    text = text.replace(pattern, replacement);
  }
  return text.slice(0, MAX_ERROR_LENGTH) || fallback;
}

/** Keep opt-in debug logs useful without printing arbitrary form/profile data. */
export function safeExtensionDebugPayload(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return { type: typeof value };
  }
  if (Array.isArray(value)) {
    return { type: "array", length: value.length };
  }

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!SAFE_DEBUG_KEYS.has(key)) {
      result[key] = "[redacted]";
    } else if (typeof item === "string") {
      result[key] = safeExtensionError(item, "[redacted]");
    } else if (typeof item === "number" || typeof item === "boolean" || item === null) {
      result[key] = item;
    } else {
      result[key] = Array.isArray(item) ? { type: "array", length: item.length } : "[redacted]";
    }
  }
  return result;
}
