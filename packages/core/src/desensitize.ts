// PII masking before text leaves for a cloud LLM — port of
// backend/app/agents/desensitize.py. Placeholders carry a per-call nonce so
// they can never collide with text the model writes on its own.

const PHONE_CN = /(?<!\d)1[3-9]\d{9}(?!\d)/g;
const PHONE_INTL = /\+\d{1,3}[\s-]?\d{6,14}/g;
const EMAIL = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const ID_CARD = /(?<!\d)\d{17}[\dXx](?!\d)/g;
const BANK_CARD = /(?<!\d)\d{4}\s?\d{4}\s?\d{4}\s?\d{4}\s?\d{0,3}(?!\d)/g;
// Models often drop the brackets / underscores around a placeholder.
const LOOSE = /\[?_{0,3}PII_([A-Z]+)_(\d+)_([0-9a-f]{8})_{0,3}\]?/g;

export type PiiMapping = Record<string, string>;

function nonce(): string {
  const bytes = new Uint8Array(4);
  const cryptoApi = (globalThis as { crypto?: { getRandomValues(array: Uint8Array): Uint8Array } }).crypto;
  if (cryptoApi) cryptoApi.getRandomValues(bytes);
  else for (let i = 0; i < 4; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** FNV-1a 32-bit → 8 hex: a per-session tag that is stable across turns and resumes. */
function seededTag(seed: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * Masks text with one mapping and one tag across calls: the same value always
 * gets the same placeholder, and new values continue the numbering. The Agent
 * loop masks each history message once, in order, so already-sent bytes never
 * change between turns (provider prefix caches keep hitting). With a seed
 * (the session id) the tag, and so every placeholder, is reproducible after a
 * resume without storing the mapping.
 */
export class PiiMasker {
  readonly mapping: PiiMapping = {};
  private readonly byValue = new Map<string, string>();
  private readonly counter: Record<string, number> = { phone: 0, email: 0, id: 0, bank: 0 };
  private readonly tag: string;

  constructor(seed?: string) {
    this.tag = seed ? seededTag(`offeru-pii:${seed}`) : nonce();
  }

  mask(text: string): string {
    const replace = (prefix: string) => (original: string) => {
      const known = this.byValue.get(original);
      if (known) return known;
      this.counter[prefix] += 1;
      const placeholder = `[__PII_${prefix.toUpperCase()}_${this.counter[prefix]}_${this.tag}__]`;
      this.mapping[placeholder] = original;
      this.byValue.set(original, placeholder);
      return placeholder;
    };
    let result = text.replace(ID_CARD, replace("id"));
    result = result.replace(EMAIL, replace("email"));
    result = result.replace(PHONE_INTL, replace("phone"));
    result = result.replace(PHONE_CN, replace("phone"));
    result = result.replace(BANK_CARD, replace("bank"));
    return result;
  }
}

export function desensitize(text: string): { text: string; mapping: PiiMapping } {
  const masker = new PiiMasker();
  return { text: masker.mask(text), mapping: masker.mapping };
}

export function restore(text: string, mapping: PiiMapping): string {
  let result = text;
  for (const [placeholder, original] of Object.entries(mapping)) {
    if (result.includes(placeholder)) result = result.split(placeholder).join(original);
  }
  if (!result.includes("PII_")) return result;
  const keys = new Map<string, string>();
  for (const [placeholder, original] of Object.entries(mapping)) {
    const match = new RegExp(`^${LOOSE.source}$`).exec(placeholder);
    if (match) keys.set(match.slice(1).join("|"), original);
  }
  if (!keys.size) return result;
  return result.replace(LOOSE, (whole, kind: string, index: string, tag: string) => keys.get([kind, index, tag].join("|")) ?? whole);
}
