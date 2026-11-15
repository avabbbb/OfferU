// Encrypted backup bundle: one file that holds a complete sync repo
// (offeru-sync.json + refs/latest + indexes/* + objects/*), in exactly the
// format that lives in a bucket. Export = sync the local store into an empty
// in-memory repo; import = sync the bundle's repo into the local store (union
// merge, identical records are matched, nothing is deleted). Works offline and
// between any two runtimes (browser IndexedDB <-> desktop companion SQLite).
//
// File layout (all integers big-endian):
//   "OUBK" | version u8 (1) | count u32 | count × ( keyLen u16 | key utf8 | bodyLen u32 | body )
// Bodies are the bucket objects as-is: everything except offeru-sync.json is
// sealed with the passphrase-derived key, so the file is as safe as the bucket.

import type { CoreStore } from "../../core/src/index";

import { type Bytes, fromUtf8, utf8 } from "./bytes";
import type { BlobStore, PutCondition } from "./blobstore";
import { PreconditionFailed, SyncError } from "./errors";
import { SyncEngine, type SyncProgress, type SyncResult } from "./engine";
import { CONFIG_KEY, LOCK_KEY } from "./repo";
import { MemoryStateStore } from "./state";

export const BUNDLE_MAGIC = utf8("OUBK");
export const BUNDLE_VERSION = 1;
export const BUNDLE_EXTENSION = ".offeru";
export const BUNDLE_MIME = "application/vnd.offeru.backup";

/** A BlobStore in memory: ETags and conditional PUT, no network. */
export class MapBlobStore implements BlobStore {
  readonly objects = new Map<string, { body: Bytes; etag: string }>();
  readonly location: string;
  private version = 0;

  constructor(location = "bundle:") {
    this.location = location;
  }

  async get(key: string) {
    const found = this.objects.get(key);
    return found ? { body: found.body.slice() as Bytes, etag: found.etag } : null;
  }

  async head(key: string) {
    return this.objects.get(key)?.etag ?? null;
  }

  async put(key: string, body: Uint8Array, condition: PutCondition = {}) {
    const existing = this.objects.get(key);
    if (condition.ifNoneMatch === "*" && existing) throw new PreconditionFailed(key);
    if (condition.ifMatch && existing?.etag !== condition.ifMatch) throw new PreconditionFailed(key);
    this.version += 1;
    const etag = `"${this.version}"`;
    this.objects.set(key, { body: new Uint8Array(body) as Bytes, etag });
    return etag;
  }

  async delete(key: string) {
    this.objects.delete(key);
  }
}

export function encodeBundle(objects: Map<string, { body: Uint8Array }>): Uint8Array {
  const entries = [...objects.entries()].filter(([key]) => key !== LOCK_KEY).sort(([a], [b]) => (a < b ? -1 : 1));
  const keys = entries.map(([key]) => utf8(key));
  const size = 4 + 1 + 4 + entries.reduce((sum, [, value], i) => sum + 2 + keys[i].length + 4 + value.body.length, 0);
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(BUNDLE_MAGIC, 0);
  view.setUint8(4, BUNDLE_VERSION);
  view.setUint32(5, entries.length);
  let offset = 9;
  entries.forEach(([, value], i) => {
    view.setUint16(offset, keys[i].length);
    out.set(keys[i], offset + 2);
    offset += 2 + keys[i].length;
    view.setUint32(offset, value.body.length);
    out.set(value.body, offset + 4);
    offset += 4 + value.body.length;
  });
  return out;
}

export function decodeBundle(bytes: Uint8Array): MapBlobStore {
  const bad = (why: string) => new SyncError("format", `不是 OfferU 加密备份文件（${why}）`);
  if (bytes.length < 9 || !BUNDLE_MAGIC.every((byte, i) => bytes[i] === byte)) throw bad("文件头不对");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint8(4);
  if (version > BUNDLE_VERSION) throw new SyncError("format", `备份格式 v${version} 比本机新，请先升级 OfferU`);
  const count = view.getUint32(5);
  const store = new MapBlobStore();
  let offset = 9;
  for (let i = 0; i < count; i += 1) {
    if (offset + 2 > bytes.length) throw bad("文件被截断");
    const keyLength = view.getUint16(offset);
    if (offset + 2 + keyLength + 4 > bytes.length) throw bad("文件被截断");
    const key = fromUtf8(bytes.subarray(offset + 2, offset + 2 + keyLength));
    offset += 2 + keyLength;
    const length = view.getUint32(offset);
    if (offset + 4 + length > bytes.length) throw bad("文件被截断");
    store.objects.set(key, { body: bytes.slice(offset + 4, offset + 4 + length) as Bytes, etag: `"b${i}"` });
    offset += 4 + length;
  }
  if (!store.objects.has(CONFIG_KEY)) throw bad(`缺少 ${CONFIG_KEY}`);
  return store;
}

type BundleOptions = {
  store: CoreStore;
  passphrase: string;
  kdfIterations?: number;
  now?: () => Date;
  onProgress?: (progress: SyncProgress) => void;
};

function engine(options: BundleOptions, blobs: BlobStore, actor: string): SyncEngine {
  return new SyncEngine({
    store: options.store,
    blobs,
    state: new MemoryStateStore(),
    passphrase: options.passphrase,
    kdfIterations: options.kdfIterations,
    now: options.now,
    onProgress: options.onProgress,
    actor,
    lock: { attempts: 1 },
    concurrency: 8,
  });
}

/** Snapshot every local record into a fresh encrypted repo and serialize it. Local data is not touched. */
export async function exportBundle(options: BundleOptions): Promise<{ bytes: Uint8Array; records: number; result: SyncResult }> {
  if (options.passphrase.length < 8) throw new SyncError("config", "备份口令至少 8 个字符；导入时要用同一个口令");
  const blobs = new MapBlobStore();
  const result = await engine(options, blobs, "导出备份").sync();
  return { bytes: encodeBundle(blobs.objects), records: result.pushed, result };
}

/**
 * Merge a bundle into the local store with the normal sync merge: records that
 * already exist identically are matched, the rest is added, two profiles are
 * merged field by field (conflicting values kept as a conflict note). Wrong
 * passphrase fails before anything is written. Every write is an undoable change.
 */
export async function importBundle(options: BundleOptions & { bytes: Uint8Array }): Promise<SyncResult> {
  const blobs = decodeBundle(options.bytes);
  return engine(options, blobs, "导入备份").sync();
}
