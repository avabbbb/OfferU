// Small helpers that reproduce Python string semantics the resume code relies on,
// so TS output matches backend/app/core byte for byte. Pure, no runtime deps.

/** str.splitlines(): every Python line boundary; no trailing empty line. */
export function splitlines(text: string): string[] {
  if (!text) return [];
  const parts = text.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/);
  if (parts.length && parts[parts.length - 1] === "" && /(?:\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029])$/.test(text)) parts.pop();
  return parts;
}

/** " ".join(text.split()) */
export const oneLine = (text: string): string => text.split(/\s+/u).filter(Boolean).join(" ");

/** html.escape(text, quote) */
export function escapeHtml(text: string, quote = true): string {
  const out = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return quote ? out.replace(/"/g, "&quot;").replace(/'/g, "&#x27;") : out;
}

/** s[:n] by code point, like Python slicing. */
export const head = (text: string, n: number): string => {
  const chars = Array.from(text);
  return chars.length <= n ? text : chars.slice(0, n).join("");
};

/** Python truthiness for JSON values. */
export function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object") return Object.keys(value).length > 0;
  return Boolean(value);
}

/** str(value) for JSON scalars (Python spells booleans/None differently). */
export function pyStr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  return String(value);
}

/** Python `x or ""` then str(): falsy → "". */
export const textOr = (value: unknown): string => (truthy(value) ? pyStr(value) : "");

/** A Unicode decimal digit's value (Python int() accepts any Nd digit). */
export function digitsToAscii(text: string): string {
  let out = "";
  for (const ch of text) {
    if (ch >= "0" && ch <= "9") { out += ch; continue; }
    if (!/\p{Nd}/u.test(ch)) { out += ch; continue; }
    let start = ch.codePointAt(0)!;
    while (/\p{Nd}/u.test(String.fromCodePoint(start - 1))) start -= 1;
    out += String((ch.codePointAt(0)! - start) % 10);
  }
  return out;
}

/** str(int(part)) for a run of decimal digits, without float precision loss. */
export const intStr = (digits: string): string => BigInt(digitsToAscii(digits)).toString();
