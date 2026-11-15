// Remote repository layout (dejavu-like, reimplemented):
//
//   <prefix>offeru-sync.json      plaintext: format, version, repo_id, KDF params, key check
//   <prefix>objects/ab/cdef...     sealed chunks, id = HMAC-SHA256(macKey, plaintext)
//   <prefix>indexes/<id>           sealed snapshot index, id = HMAC of its canonical JSON
//   <prefix>refs/latest            sealed { index, device, at }, updated with If-Match
//   <prefix>lock                   sealed { device, token, expires_at }, created with If-None-Match
//
// Objects and indexes are immutable and content addressed; only refs/latest and
// lock are ever overwritten, and only through conditional writes.

import { type Bytes, canonicalJson, fromUtf8, randomId, utf8 } from "./bytes";
import type { BlobStore } from "./blobstore";
import {
  type KdfParams,
  type SyncKeys,
  contentId,
  deriveKeys,
  makeKeyCheck,
  newKdfParams,
  open,
  openJson,
  seal,
  sealJson,
  verifyKeyCheck,
} from "./crypto";
import { PreconditionFailed, SyncError } from "./errors";

export const CONFIG_KEY = "offeru-sync.json";
export const LATEST_KEY = "refs/latest";
export const LOCK_KEY = "lock";
export const FORMAT_VERSION = 1;

export type RepoConfig = {
  format: "offeru-sync";
  version: number;
  repo_id: string;
  kdf: KdfParams;
  check: string;
  created_at: string;
};

/** Index entry: chunk ids of a live record, or a tombstone with its deletion time. */
export type IndexEntry = { c: string[] } | { t: string };

export type SnapshotIndex = {
  v: 1;
  parent: string | null;
  device: string;
  created_at: string;
  records: Record<string, IndexEntry>;
};

export type LatestRef = { index: string; device: string; at: string };

type LockBody = { device: string; token: string; expires_at: string };

export function objectKey(id: string): string {
  return `objects/${id.slice(0, 2)}/${id.slice(2)}`;
}

export function isTomb(entry: IndexEntry | undefined): entry is { t: string } {
  return Boolean(entry && "t" in entry);
}

export class RemoteRepo {
  private lockToken: string | null = null;

  private constructor(
    readonly blobs: BlobStore,
    readonly keys: SyncKeys,
    readonly config: RepoConfig,
    readonly created: boolean,
  ) {}

  /** Opens (or initializes) the repo; a wrong passphrase fails here, before any data moves. */
  static async open(blobs: BlobStore, passphrase: string, options: { iterations?: number; now?: string } = {}): Promise<RemoteRepo> {
    const existing = await blobs.get(CONFIG_KEY);
    if (existing) return RemoteRepo.fromConfig(blobs, passphrase, parseConfig(existing.body), false);

    const kdf = newKdfParams(options.iterations);
    const keys = await deriveKeys(passphrase, kdf);
    const config: RepoConfig = {
      format: "offeru-sync",
      version: FORMAT_VERSION,
      repo_id: randomId(),
      kdf,
      check: await makeKeyCheck(keys),
      created_at: options.now ?? new Date().toISOString(),
    };
    try {
      await blobs.put(CONFIG_KEY, utf8(JSON.stringify(config, null, 2)), { ifNoneMatch: "*" });
      return new RemoteRepo(blobs, keys, config, true);
    } catch (error) {
      if (!(error instanceof PreconditionFailed)) throw error;
      // Another device initialized the bucket first: use theirs.
      const winner = await blobs.get(CONFIG_KEY);
      if (!winner) throw error;
      return RemoteRepo.fromConfig(blobs, passphrase, parseConfig(winner.body), false);
    }
  }

  private static async fromConfig(blobs: BlobStore, passphrase: string, config: RepoConfig, created: boolean): Promise<RemoteRepo> {
    const keys = await deriveKeys(passphrase, config.kdf);
    await verifyKeyCheck(keys, config.check);
    return new RemoteRepo(blobs, keys, config, created);
  }

  get repoId(): string {
    return this.config.repo_id;
  }

  id(plaintext: Uint8Array): Promise<string> {
    return contentId(this.keys, plaintext);
  }

  async hasObject(id: string): Promise<boolean> {
    return (await this.blobs.head(objectKey(id))) !== null;
  }

  async putObject(id: string, plaintext: Uint8Array): Promise<void> {
    const key = objectKey(id);
    await this.blobs.put(key, await seal(this.keys, plaintext, key));
  }

  async getObject(id: string): Promise<Bytes> {
    const key = objectKey(id);
    const blob = await this.blobs.get(key);
    if (!blob) throw new SyncError("format", `远端缺少对象 ${id.slice(0, 12)}…，快照不完整`);
    const plain = await open(this.keys, blob.body, key);
    if ((await this.id(plain)) !== id) throw new SyncError("decrypt", `对象 ${id.slice(0, 12)}… 内容校验失败`);
    return plain;
  }

  async putIndex(index: SnapshotIndex): Promise<string> {
    const plain = utf8(canonicalJson(index));
    const id = await this.id(plain);
    const key = `indexes/${id}`;
    if ((await this.blobs.head(key)) === null) await this.blobs.put(key, await seal(this.keys, plain, key));
    return id;
  }

  async getIndex(id: string): Promise<SnapshotIndex> {
    const key = `indexes/${id}`;
    const blob = await this.blobs.get(key);
    if (!blob) throw new SyncError("format", `远端缺少快照索引 ${id.slice(0, 12)}…`);
    const plain = await open(this.keys, blob.body, key);
    if ((await this.id(plain)) !== id) throw new SyncError("decrypt", `快照索引 ${id.slice(0, 12)}… 校验失败`);
    return JSON.parse(fromUtf8(plain)) as SnapshotIndex;
  }

  async getLatest(): Promise<{ ref: LatestRef; etag: string } | null> {
    const blob = await this.blobs.get(LATEST_KEY);
    if (!blob) return null;
    return { ref: await openJson<LatestRef>(this.keys, blob.body, LATEST_KEY), etag: blob.etag };
  }

  /** Compare-and-swap refs/latest. False when someone else moved it first. */
  async casLatest(ref: LatestRef, etag: string | null): Promise<boolean> {
    try {
      await this.blobs.put(LATEST_KEY, await sealJson(this.keys, ref, LATEST_KEY), etag ? { ifMatch: etag } : { ifNoneMatch: "*" });
      return true;
    } catch (error) {
      if (error instanceof PreconditionFailed) return false;
      throw error;
    }
  }

  /**
   * Advisory lock with expiry. Created with If-None-Match: *; an expired lock
   * (or our own) is taken over with If-Match on its ETag, so two devices
   * racing for a stale lock cannot both win.
   */
  async acquireLock(device: string, options: { ttlMs: number; attempts: number; waitMs: number; now: () => number; sleep: (ms: number) => Promise<void> }): Promise<void> {
    const token = randomId(8);
    for (let attempt = 0; attempt < Math.max(1, options.attempts); attempt += 1) {
      const body: LockBody = { device, token, expires_at: new Date(options.now() + options.ttlMs).toISOString() };
      const sealed = await sealJson(this.keys, body, LOCK_KEY);
      try {
        await this.blobs.put(LOCK_KEY, sealed, { ifNoneMatch: "*" });
        this.lockToken = token;
        return;
      } catch (error) {
        if (!(error instanceof PreconditionFailed)) throw error;
      }
      const current = await this.blobs.get(LOCK_KEY);
      if (current) {
        let holder: LockBody | null = null;
        try {
          holder = await openJson<LockBody>(this.keys, current.body, LOCK_KEY);
        } catch {
          holder = null; // unreadable lock: treat as stale
        }
        const stale = !holder || holder.device === device || Date.parse(holder.expires_at) <= options.now();
        if (stale) {
          try {
            await this.blobs.put(LOCK_KEY, sealed, { ifMatch: current.etag });
            this.lockToken = token;
            return;
          } catch (error) {
            if (!(error instanceof PreconditionFailed)) throw error;
            continue;
          }
        }
        if (attempt === options.attempts - 1) {
          throw new SyncError("locked", `另一台设备正在同步（锁到 ${holder!.expires_at} 过期），稍后再试`);
        }
      }
      await options.sleep(options.waitMs);
    }
    throw new SyncError("locked", "另一台设备正在同步，稍后再试");
  }

  async releaseLock(): Promise<void> {
    if (!this.lockToken) return;
    const token = this.lockToken;
    this.lockToken = null;
    const current = await this.blobs.get(LOCK_KEY);
    if (!current) return;
    try {
      const holder = await openJson<LockBody>(this.keys, current.body, LOCK_KEY);
      if (holder.token !== token) return; // someone took over an expired lock; leave theirs alone
    } catch {
      return;
    }
    await this.blobs.delete(LOCK_KEY);
  }
}

function parseConfig(body: Uint8Array): RepoConfig {
  let config: RepoConfig;
  try {
    config = JSON.parse(fromUtf8(body)) as RepoConfig;
  } catch {
    throw new SyncError("format", `${CONFIG_KEY} 不是合法 JSON：这个前缀下可能不是 OfferU 同步数据`);
  }
  if (config.format !== "offeru-sync") throw new SyncError("format", `${CONFIG_KEY} 不是 OfferU 同步配置`);
  if (config.version > FORMAT_VERSION) throw new SyncError("format", `远端同步格式 v${config.version} 比本机新，请先升级 OfferU`);
  return config;
}
