// PII masking before a cloud model sees free text (port of agents/desensitize.py).
// Placeholders carry a per-call nonce; restore() also accepts the loose forms
// models tend to rewrite them into.

const ID_CARD = /(?<!\d)\d{17}[\dXx](?!\d)/g;
const EMAIL = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const PHONE_INTL = /\+\d{1,3}[\s-]?\d{6,14}/g;
const PHONE_CN = /(?<!\d)1[3-9]\d{9}(?!\d)/g;
const BANK_CARD = /(?<!\d)\d{4}\s?\d{4}\s?\d{4}\s?\d{4}\s?\d{0,3}(?!\d)/g;
const LOOSE = /\[?_{0,3}PII_([A-Z]+)_(\d+)_([0-9a-f]{8})_{0,3}\]?/g;

function nonce(): string {
  const bytes = new Uint8Array(4);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function desensitize(text: string): [string, Record<string, string>] {
  const mapping: Record<string, string> = {};
  const counter: Record<string, number> = { phone: 0, email: 0, id: 0, bank: 0 };
  const tag = nonce();
  const replace = (prefix: string) => (original: string): string => {
    for (const [placeholder, value] of Object.entries(mapping)) if (value === original) return placeholder;
    counter[prefix] += 1;
    const placeholder = `[__PII_${prefix.toUpperCase()}_${counter[prefix]}_${tag}__]`;
    mapping[placeholder] = original;
    return placeholder;
  };
  let result = text.replace(ID_CARD, replace("id"));
  result = result.replace(EMAIL, replace("email"));
  result = result.replace(PHONE_INTL, replace("phone"));
  result = result.replace(PHONE_CN, replace("phone"));
  result = result.replace(BANK_CARD, replace("bank"));
  return [result, mapping];
}

export function restore(text: string, mapping: Record<string, string>): string {
  let result = text;
  for (const [placeholder, original] of Object.entries(mapping)) result = result.split(placeholder).join(original);
  if (!result.includes("PII_")) return result;
  const keys = new Map<string, string>();
  for (const [placeholder, original] of Object.entries(mapping)) {
    const match = new RegExp(`^${LOOSE.source}$`).exec(placeholder);
    if (match) keys.set(`${match[1]}|${match[2]}|${match[3]}`, original);
  }
  if (!keys.size) return result;
  return result.replace(LOOSE, (whole, kind: string, index: string, tag: string) => keys.get(`${kind}|${index}|${tag}`) ?? whole);
}
