// End-to-end encryption for everything written to the bucket.
//
// passphrase --PBKDF2-SHA256(salt, iterations)--> 256-bit master
// master --HKDF-SHA256("offeru-sync/v1/enc")--> AES-256-GCM key (objects, indexes, refs, lock)
// master --HKDF-SHA256("offeru-sync/v1/mac")--> HMAC-SHA256 key (content ids)
//
// Sealed blob: "OUS1" | iv(12) | AES-GCM(ciphertext+tag) over (flag(1) | payload),
// flag 0 = raw, 1 = deflate-raw. The AAD is the object's logical name, so a
// blob moved to another key fails to decrypt instead of being silently accepted.

import { type Bytes, concat, copy, fromBase64, fromUtf8, randomBytes, toBase64, toHex, utf8 } from "./bytes";
import { SyncError } from "./errors";

export const MAGIC = utf8("OUS1");
export const DEFAULT_KDF_ITERATIONS = 600_000;
const KEY_CHECK_TEXT = "offeru-sync key check v1";
const COMPRESS_MIN = 512;

export type KdfParams = { alg: "PBKDF2-SHA256"; iterations: number; salt: string };

// Spelled this way so the file typechecks with either DOM or Node globals.
type Key = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

export interface SyncKeys {
  enc: Key;
  mac: Key;
}

export function newKdfParams(iterations = DEFAULT_KDF_ITERATIONS): KdfParams {
  return { alg: "PBKDF2-SHA256", iterations, salt: toBase64(randomBytes(16)) };
}

export async function deriveKeys(passphrase: string, kdf: KdfParams): Promise<SyncKeys> {
  if (kdf.alg !== "PBKDF2-SHA256") throw new SyncError("format", `不支持的密钥派生算法：${kdf.alg}`);
  if (!passphrase) throw new SyncError("config", "同步口令不能为空");
  const subtle = crypto.subtle;
  const base = await subtle.importKey("raw", utf8(passphrase.normalize("NFC")), "PBKDF2", false, ["deriveBits"]);
  const master = await subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: fromBase64(kdf.salt), iterations: kdf.iterations },
    base,
    256,
  );
  const hkdf = await subtle.importKey("raw", master, "HKDF", false, ["deriveKey"]);
  const info = (label: string) => ({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: utf8(label) });
  const enc = await subtle.deriveKey(info("offeru-sync/v1/enc"), hkdf, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const mac = await subtle.deriveKey(info("offeru-sync/v1/mac"), hkdf, { name: "HMAC", hash: "SHA-256", length: 256 }, false, ["sign"]);
  return { enc, mac };
}

/** Keyed content id: HMAC(plaintext). Equal content dedupes; the id reveals nothing without the key. */
export async function contentId(keys: SyncKeys, plaintext: Uint8Array): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.sign("HMAC", keys.mac, copy(plaintext))));
}

async function pipe(data: Bytes, stream: CompressionStream | DecompressionStream): Promise<Bytes> {
  const out = new Response(new Blob([data]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

export async function seal(keys: SyncKeys, plaintext: Uint8Array, aad: string): Promise<Bytes> {
  let flag = 0;
  let payload = copy(plaintext);
  if (payload.length >= COMPRESS_MIN) {
    const packed = await pipe(payload, new CompressionStream("deflate-raw"));
    if (packed.length < payload.length) {
      flag = 1;
      payload = packed;
    }
  }
  const iv = randomBytes(12);
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: utf8(aad) },
    keys.enc,
    concat(Uint8Array.of(flag), payload),
  );
  return concat(MAGIC, iv, new Uint8Array(cipher));
}

export async function open(keys: SyncKeys, blob: Uint8Array, aad: string): Promise<Bytes> {
  if (blob.length < MAGIC.length + 12 + 16 || MAGIC.some((byte, i) => blob[i] !== byte)) {
    throw new SyncError("format", `远端对象「${aad}」不是 OfferU 加密格式`);
  }
  let plain: Bytes;
  try {
    plain = new Uint8Array(await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: copy(blob.subarray(4, 16)), additionalData: utf8(aad) },
      keys.enc,
      copy(blob.subarray(16)),
    ));
  } catch {
    throw new SyncError("decrypt", `远端对象「${aad}」解密失败：口令不对，或对象被改动过`);
  }
  const payload = plain.subarray(1) as Bytes;
  return plain[0] === 1 ? pipe(copy(payload), new DecompressionStream("deflate-raw")) : copy(payload);
}

export async function sealJson(keys: SyncKeys, value: unknown, aad: string): Promise<Bytes> {
  return seal(keys, utf8(JSON.stringify(value)), aad);
}

export async function openJson<T>(keys: SyncKeys, blob: Uint8Array, aad: string): Promise<T> {
  return JSON.parse(fromUtf8(await open(keys, blob, aad))) as T;
}

/** Stored in the plaintext config: lets a wrong passphrase fail before anything is downloaded or written. */
export async function makeKeyCheck(keys: SyncKeys): Promise<string> {
  return toBase64(await seal(keys, utf8(KEY_CHECK_TEXT), "keycheck"));
}

export async function verifyKeyCheck(keys: SyncKeys, check: string): Promise<void> {
  try {
    const text = fromUtf8(await open(keys, fromBase64(check), "keycheck"));
    if (text === KEY_CHECK_TEXT) return;
  } catch {
    // fall through
  }
  throw new SyncError("passphrase", "同步口令不对：和这个存储桶第一次设置的口令不一致");
}
