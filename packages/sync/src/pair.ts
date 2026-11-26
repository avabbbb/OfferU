// Pairing link: hands this device's bucket settings to another device (the web version)
// without the link alone being enough to use them.
//
//   code = base64url( "OUP1" | iterations (u32 BE) | salt (16) | seal(keys, json, aad) )
//   keys = deriveKeys(sync passphrase, { PBKDF2-SHA256, iterations, salt })   -- the same KDF as the repo
//   json = { v:1, endpoint, bucket, region, prefix, pathStyle, accessKeyId, secretAccessKey, expires_at }
//
// The salt is fresh per link, so a link needs only itself + the passphrase (no bucket read).
// The header (iterations, salt) is the AAD, so it cannot be swapped. The expiry is inside the
// ciphertext: nobody can extend it without the passphrase. The CLI (`offeru sync pair`) seals,
// the web page #/sync/pair opens, both through these two functions.

import { concat, fromUtf8, randomBytes, toBase64, utf8 } from "./bytes";
import { DEFAULT_KDF_ITERATIONS, deriveKeys, open, seal } from "./crypto";
import { SyncError, isSyncError } from "./errors";

export const PAIR_TTL_MS = 30 * 60 * 1000;
const PAIR_MAGIC = utf8("OUP1");
const HEADER = PAIR_MAGIC.length + 4 + 16;
// Enough to refuse a forged cheap link, low enough that tests can run fast.
const MIN_ITERATIONS = 1000;
const MAX_ITERATIONS = 5_000_000;

export type PairBucket = {
  endpoint?: string;
  bucket: string;
  region: string;
  prefix?: string;
  pathStyle?: boolean;
  accessKeyId: string;
  secretAccessKey: string;
};

export type PairPayload = Required<Pick<PairBucket, "bucket" | "region" | "accessKeyId" | "secretAccessKey">> & {
  v: 1;
  endpoint: string;
  prefix: string;
  pathStyle: boolean;
  expires_at: string;
};

export function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new SyncError("format", "链接不完整：配对码里有不认识的字符");
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function headerAad(header: Uint8Array): string {
  return `offeru-pair/v1/${toBase64(header)}`;
}

/** Seals the bucket settings with the sync passphrase. Returns the url-safe code and its expiry. */
export async function sealPairing(
  bucket: PairBucket,
  passphrase: string,
  options: { now?: Date; ttlMs?: number; iterations?: number } = {},
): Promise<{ code: string; expires_at: string }> {
  const iterations = options.iterations ?? DEFAULT_KDF_ITERATIONS;
  const expires_at = new Date((options.now ?? new Date()).getTime() + (options.ttlMs ?? PAIR_TTL_MS)).toISOString();
  const endpoint = bucket.endpoint?.trim() ?? "";
  const payload: PairPayload = {
    v: 1,
    endpoint,
    bucket: bucket.bucket,
    region: bucket.region,
    prefix: bucket.prefix ?? "offeru",
    pathStyle: bucket.pathStyle ?? Boolean(endpoint),
    accessKeyId: bucket.accessKeyId,
    secretAccessKey: bucket.secretAccessKey,
    expires_at,
  };
  const salt = randomBytes(16);
  const count = new Uint8Array(4);
  new DataView(count.buffer).setUint32(0, iterations);
  const header = concat(PAIR_MAGIC, count, salt);
  const keys = await deriveKeys(passphrase, { alg: "PBKDF2-SHA256", iterations, salt: toBase64(salt) });
  const sealed = await seal(keys, utf8(JSON.stringify(payload)), headerAad(header));
  return { code: toBase64Url(concat(header, sealed)), expires_at };
}

/**
 * Opens a pairing code. Errors (SyncError, Chinese message):
 *   format     链接不完整 (truncated / not a pairing code)
 *   passphrase 口令不对
 *   expired    链接已过期
 */
export async function openPairing(code: string, passphrase: string, options: { now?: Date } = {}): Promise<PairPayload> {
  const raw = fromBase64Url(code.trim());
  if (raw.length < HEADER + 4 + 12 + 16 || PAIR_MAGIC.some((byte, i) => raw[i] !== byte)) {
    throw new SyncError("format", "链接不完整：请把 Agent 发来的整条链接一次复制完整再打开");
  }
  const header = raw.subarray(0, HEADER);
  const iterations = new DataView(header.buffer, header.byteOffset + PAIR_MAGIC.length, 4).getUint32(0);
  if (iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS) throw new SyncError("format", "链接不完整：配对码的格式不对");
  if (!passphrase) throw new SyncError("passphrase", "请输入同步口令");
  const keys = await deriveKeys(passphrase, { alg: "PBKDF2-SHA256", iterations, salt: toBase64(header.subarray(PAIR_MAGIC.length + 4)) });
  let payload: PairPayload;
  try {
    payload = JSON.parse(fromUtf8(await open(keys, raw.subarray(HEADER), headerAad(header)))) as PairPayload;
  } catch (cause) {
    // A truncated link also fails authentication; it cannot be told apart from a wrong passphrase.
    if (isSyncError(cause) && cause.code === "format") throw new SyncError("format", "链接不完整：请把 Agent 发来的整条链接一次复制完整再打开");
    throw new SyncError("passphrase", "口令不对：要和 Agent 告诉你的同步口令一字不差（区分大小写）");
  }
  if (payload?.v !== 1 || !payload.bucket || !payload.accessKeyId || !payload.secretAccessKey) {
    throw new SyncError("format", "链接不完整：配对内容缺少存储桶信息");
  }
  const expires = Date.parse(payload.expires_at);
  if (!Number.isFinite(expires) || expires <= (options.now ?? new Date()).getTime()) {
    throw new SyncError("expired", "链接已过期：请让 Agent 重新运行 offeru sync pair 发一条新链接");
  }
  return payload;
}

/** `<origin>/#/sync/pair?c=<code>`: the code stays in the fragment, which browsers never send to the server. */
export function pairingUrl(origin: string, code: string): string {
  return `${origin.replace(/\/+$/, "")}/#/sync/pair?c=${code}`;
}
