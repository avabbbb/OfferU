// Small Python-semantics helpers so prompts and normalized output match the
// Python backend byte for byte (code-point slicing, str(), truthiness, round()).

/** Python truthiness for JSON-ish values. */
export function truthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as object).length > 0;
  return true;
}

function reprString(value: string): string {
  const quote = value.includes("'") && !value.includes("\"") ? "\"" : "'";
  const body = value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\t/g, "\\t").replace(/\r/g, "\\r");
  return quote + (quote === "'" ? body.replace(/'/g, "\\'") : body) + quote;
}

function repr(value: unknown): string {
  return typeof value === "string" ? reprString(value) : pyStr(value);
}

/** Python str() of a JSON value (list/dict use repr of their items). */
export function pyStr(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : value > 0 ? "inf" : value < 0 ? "-inf" : "nan";
  if (Array.isArray(value)) return `[${value.map(repr).join(", ")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).map(([key, item]) => `${reprString(key)}: ${repr(item)}`).join(", ")}}`;
  }
  return String(value);
}

/** Python iteration over a JSON value: list items, string code points, dict keys. Non-iterables yield nothing. */
export function pyIter(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return Array.from(value);
  if (value && typeof value === "object") return Object.keys(value as object);
  return [];
}

/** s[:n] in code points. */
export function cut(value: string, n: number): string {
  if (value.length <= n) return value;
  return Array.from(value).slice(0, n).join("");
}

/** Python round(): half to even. */
export function pyRound(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff === 0.5) return floor % 2 === 0 ? floor : floor + 1;
  return Math.round(value);
}

/** float(value) or null when Python would raise (TypeError/ValueError) or the value is not finite. */
export function pyFloat(value: unknown): number | null {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const text = value.trim().replace(/(?<=\d)_(?=\d)/g, "");
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/** int(round(float(value))) or null. */
export function pyIntRound(value: unknown): number | null {
  const parsed = pyFloat(value);
  return parsed === null ? null : pyRound(parsed);
}

/** urlparse(url).hostname, lower-cased; "" when there is none. */
export function hostnameOf(url: string): string {
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(url.trim());
  if (!match) return "";
  let netloc = match[1];
  const at = netloc.lastIndexOf("@");
  if (at >= 0) netloc = netloc.slice(at + 1);
  if (netloc.startsWith("[")) {
    const end = netloc.indexOf("]");
    return (end > 0 ? netloc.slice(1, end) : "").toLowerCase();
  }
  const colon = netloc.indexOf(":");
  return (colon >= 0 ? netloc.slice(0, colon) : netloc).toLowerCase();
}
