// Byte helpers shared by the sync module. Runtime-agnostic (WebCrypto only).

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

export function fromUtf8(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

/** Copy into a plain ArrayBuffer (WebCrypto typings want ArrayBuffer, not ArrayBufferLike). */
export function ab(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

export function hex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = "";
  for (const byte of view) out += byte.toString(16).padStart(2, "0");
  return out;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** WebCrypto types without depending on the DOM lib (Node's @types and lib.dom name them differently). */
export type Subtle = typeof globalThis.crypto.subtle;
export type WebCryptoKey = Awaited<ReturnType<Subtle["importKey"]>>;

export function subtle(): Subtle {
  const value = (globalThis as { crypto?: { subtle?: Subtle } }).crypto?.subtle;
  if (!value) throw new Error("WebCrypto (crypto.subtle) is not available in this runtime");
  return value;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return hex(await subtle().digest("SHA-256", ab(bytes)));
}

export async function hmacRaw(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const imported = await subtle().importKey("raw", ab(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await subtle().sign("HMAC", imported, ab(data)));
}

/** JSON with sorted object keys, so equal content always has equal bytes. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined) out[key] = sortKeys(item);
    }
    return out;
  }
  return value;
}

export function randomId(bytes = 16): string {
  const out = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(out);
  return hex(out);
}
