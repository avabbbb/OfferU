const CLIENT_ERROR_MAX_LENGTH = 500;

const CLIENT_ERROR_REDACTIONS: Array<[RegExp, string]> = [
  [
    /(?:https?|wss?):\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?[^\s)]*/gi,
    "[local endpoint]",
  ],
  [
    /((?:api[_-]?(?:key|token)|auth[_-]?token|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|secret|credential|cookie|authorization|bearer|token))\s*[:=]\s*[^\s,;}\]]+/gi,
    "$1=[redacted]",
  ],
  [/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}\b/gi, "[credential]"],
  [/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/gi, "[credential]"],
  [/\bAIza[A-Za-z0-9_-]{20,}\b/gi, "[credential]"],
  [/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email]"],
  [/(?:\+?86[-\s]?)?1[3-9]\d{9}\b/g, "[phone]"],
];

/** Keep transport/provider errors useful without exposing endpoints, credentials, or PII. */
export function safeClientErrorMessage(value: unknown, fallback = "操作失败"): string {
  const raw = value instanceof Error ? value.message : typeof value === "string" ? value : "";
  let text = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  for (const [pattern, replacement] of CLIENT_ERROR_REDACTIONS) {
    text = text.replace(pattern, replacement);
  }
  return text.slice(0, CLIENT_ERROR_MAX_LENGTH) || fallback;
}
