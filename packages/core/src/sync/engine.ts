// S3 sync engine (dejavu-style repository, record-level three-way merge).
//
// Remote layout under <prefix>:
//   repo.json                    KDF salt/iterations + encrypted check value (plaintext JSON)
//   objects/<2>/<id>             immutable, content-addressed, AES-GCM sealed:
//                                  a record payload, a file chunk, or a file manifest
//   snapshots/<stamp>-<dev>.json sealed Snapshot: uid -> object id / tombstone, path -> manifest / tombstone
//   refs/latest                  {"snapshot": "<name>"} — written only with If-Match/If-None-Match
//
// One run: read refs/latest -> three-way merge (base = last agreed snapshot,
// local store, remote snapshot) -> apply remote changes locally in one store
// transaction (logged as undoable changes) -> upload new objects (resumable) ->
// write a new snapshot -> move refs/latest conditionally; a lost race re-merges.

import { label, plain, TYPE_LABEL, withoutMeta } from "../labels";
import { CoreError, type CoreStore, type Json, type RecordType, type StoredRecord } from "../types";
import { canonicalJson, fromUtf8, randomId, sha256Hex, utf8 } from "./bytes";
import { RepoKeys, type RepoKeyFile } from "./crypto";
import { pruneTombstones, threeWayMerge, type MergeConflict } from "./merge";
import { PreconditionFailed, type S3Client } from "./s3";
import type { Entry, EntryMap, GcResult, Snapshot, SyncConflict, SyncFileStore, SyncRunResult } from "./types";

export const RECORD_TYPES: RecordType[] = ["profile", "job", "memory", "event", "doc"];
export const CHUNK_SIZE = 4 * 1024 * 1024;
export const SYNC_ACTOR = "同步";
const STATE_KEY = "sync:state";
const MAX_ATTEMPTS = 5;
const DAY = 86_400_000;

/**
 * What sync needs from a CoreStore beyond the base interface. Both methods
 * are optional on CoreStore so other adapters keep compiling; sync refuses to
 * run without the meta pair.
 */
export type SyncableStore = CoreStore & {
  allRecords?(): Promise<StoredRecord[]>;
  getLocalMeta?(key: string): Promise<string | null>;
  setLocalMeta?(key: string, value: string | null): Promise<void>;
};

export type SyncPolicy = {
  /** Keep at least this many newest snapshots. Default 30. */
  keepSnapshots: number;
  /** Also keep every snapshot younger than this. Default 14. */
  keepDays: number;
  /** Unreferenced objects younger than this survive GC (a concurrent device may be mid-upload). Default 24. */
  gcGraceHours: number;
  /** Tombstones older than this are dropped from new snapshots. Default 180. */
  tombstoneDays: number;
  /** Automatic GC interval. Default 7 days. */
  gcEveryDays: number;
};

export const DEFAULT_POLICY: SyncPolicy = { keepSnapshots: 30, keepDays: 14, gcGraceHours: 24, tombstoneDays: 180, gcEveryDays: 7 };

type FileCache = { size: number; mtime: string; h: string; chunks: string[] };

type SyncState = {
  device_id: string;
  /** endpoint|bucket|prefix the base belongs to; a different repo starts over. */
  repo: string | null;
  /** "<type>:<local id>" -> uid (kept after deletion so an undo re-links the same uid). */
  map: Record<string, string>;
  base: { name: string | null; records: EntryMap; files: EntryMap } | null;
  files: Record<string, FileCache>;
  /** manifest object id -> chunk ids (GC needs them without downloading every manifest). */
  manifests: Record<string, string[]>;
  /** object id -> ms when uploaded but not yet known to be referenced remotely (resume). */
  uploaded: Record<string, number>;
  last_gc_at: string | null;
};

export type RecordPayload = {
  v: 1;
  type: RecordType;
  data: Json;
  /** uid of the job this record hangs off (records.job_id), so links survive different local ids. */
  job: string | null;
  created_at: string;
  updated_at: string;
};

export type EngineDeps = {
  store: SyncableStore;
  files?: SyncFileStore | null;
  s3: S3Client;
  /** Key prefix, ends with "/" (or empty). */
  prefix: string;
  passphrase: string;
  deviceName: string;
  repoId: string;
  now?: () => Date;
  policy?: Partial<SyncPolicy>;
  /** PBKDF2 iterations when this run creates the repository. */
  kdfIterations?: number;
  /** Cache of derived keys across runs (derivation is deliberately slow). */
  keyCache?: { get(id: string): RepoKeys | undefined; set(id: string, keys: RepoKeys): void };
};

function requireMeta(store: SyncableStore): Required<Pick<SyncableStore, "getLocalMeta" | "setLocalMeta">> {
  if (!store.getLocalMeta || !store.setLocalMeta) {
    throw new CoreError("这个存储不支持同步（缺少本地同步状态读写）", "unsupported");
  }
  return { getLocalMeta: store.getLocalMeta.bind(store), setLocalMeta: store.setLocalMeta.bind(store) };
}

export async function loadState(store: SyncableStore): Promise<SyncState> {
  const raw = await requireMeta(store).getLocalMeta(STATE_KEY);
  const parsed = raw ? JSON.parse(raw) as Partial<SyncState> : {};
  return {
    device_id: parsed.device_id || randomId(8),
    repo: parsed.repo ?? null,
    map: parsed.map ?? {},
    base: parsed.base ?? null,
    files: parsed.files ?? {},
    manifests: parsed.manifests ?? {},
    uploaded: parsed.uploaded ?? {},
    last_gc_at: parsed.last_gc_at ?? null,
  };
}

async function saveState(store: SyncableStore, state: SyncState): Promise<void> {
  await requireMeta(store).setLocalMeta(STATE_KEY, JSON.stringify(state));
}

/** Store records → payload (top-level nulls dropped, like every CoreStore.put). */
export function recordPayload(record: StoredRecord, jobUid: string | null): RecordPayload {
  const data = withoutMeta(record) ?? {};
  for (const [key, value] of Object.entries(data)) if (value === null || value === undefined) delete data[key];
  return { v: 1, type: record.type, data, job: jobUid, created_at: record.created_at, updated_at: record.updated_at };
}

function stamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(".", "");
}

function conflictPath(path: string, device: string, at: Date): string {
  const slash = path.lastIndexOf("/");
  const dir = path.slice(0, slash + 1);
  const name = path.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  const safeDevice = device.replace(/[\\/:*?"<>|]/g, "_");
  return `${dir}${stem} (冲突 ${safeDevice} ${at.toISOString().slice(0, 10)})${ext}`;
}

export class SyncEngine {
  private keys!: RepoKeys;
  private readonly policy: SyncPolicy;
  private readonly now: () => Date;

  constructor(private readonly deps: EngineDeps) {
    this.policy = { ...DEFAULT_POLICY, ...deps.policy };
    this.now = deps.now ?? (() => new Date());
  }

  private key(...parts: string[]): string {
    return this.deps.prefix + parts.join("/");
  }

  private objectKey(id: string): string {
    return this.key("objects", id.slice(0, 2), id);
  }

  // ---------- repository ----------

  /** Open (or create) the repository and derive keys. Wrong passphrase -> CoreError forbidden. */
  async openRepo(): Promise<void> {
    const { s3 } = this.deps;
    const existing = await s3.get(this.key("repo.json"));
    let file: RepoKeyFile;
    if (existing) {
      try {
        file = JSON.parse(fromUtf8(existing.body)) as RepoKeyFile;
      } catch {
        throw new CoreError("远端 repo.json 损坏，不是 OfferU 同步仓库", "invalid");
      }
    } else {
      const created = await RepoKeys.create(this.deps.passphrase, this.deps.kdfIterations, this.now().toISOString());
      try {
        await s3.put(this.key("repo.json"), utf8(JSON.stringify(created.file, null, 2)), { ifNoneMatch: true, contentType: "application/json" });
        this.keys = created.keys;
        this.deps.keyCache?.set(await this.cacheId(created.file), created.keys);
        return;
      } catch (error) {
        if (!(error instanceof PreconditionFailed)) throw error;
        // Another device created it first: use theirs.
        const theirs = await s3.get(this.key("repo.json"));
        if (!theirs) throw error;
        file = JSON.parse(fromUtf8(theirs.body)) as RepoKeyFile;
      }
    }
    const id = await this.cacheId(file);
    const cached = this.deps.keyCache?.get(id);
    this.keys = cached ?? await RepoKeys.open(this.deps.passphrase, file);
    if (!cached) this.deps.keyCache?.set(id, this.keys);
  }

  private async cacheId(file: RepoKeyFile): Promise<string> {
    return `${this.deps.repoId}|${file.kdf.salt}|${file.kdf.iterations}|${file.check}|${await sha256Hex(utf8(this.deps.passphrase))}`;
  }

  private async putObject(plainBytes: Uint8Array, id?: string): Promise<string> {
    const objectId = await this.keys.objectId(plainBytes);
    if (id && id !== objectId) throw new CoreError("文件在同步过程中被改了，这次先不传；再同步一次", "conflict");
    await this.deps.s3.put(this.objectKey(objectId), await this.keys.encrypt(plainBytes));
    return objectId;
  }

  private async getObject(id: string): Promise<Uint8Array> {
    const found = await this.deps.s3.get(this.objectKey(id));
    if (!found) throw new CoreError(`远端缺少对象 ${id.slice(0, 12)}…（仓库不完整，可能被手动删过）`, "invalid");
    let plainBytes: Uint8Array;
    try {
      plainBytes = await this.keys.decrypt(found.body);
    } catch {
      throw new CoreError("远端对象解不开：口令不对或数据损坏", "forbidden");
    }
    if (await this.keys.objectId(plainBytes) !== id) throw new CoreError(`远端对象 ${id.slice(0, 12)}… 校验失败`, "invalid");
    return plainBytes;
  }

  private async getJson<T>(id: string): Promise<T> {
    return JSON.parse(fromUtf8(await this.getObject(id))) as T;
  }

  private async readRef(): Promise<{ name: string | null; etag: string | null; exists: boolean }> {
    const ref = await this.deps.s3.get(this.key("refs", "latest"));
    if (!ref) return { name: null, etag: null, exists: false };
    const parsed = JSON.parse(fromUtf8(ref.body)) as { snapshot?: string };
    return { name: parsed.snapshot ?? null, etag: ref.etag, exists: true };
  }

  async readSnapshot(name: string): Promise<Snapshot> {
    const found = await this.deps.s3.get(this.key("snapshots", name));
    if (!found) throw new CoreError(`远端快照 ${name} 不见了`, "invalid");
    try {
      return JSON.parse(fromUtf8(await this.keys.decrypt(found.body))) as Snapshot;
    } catch {
      throw new CoreError("远端快照解不开：同步口令不对或数据损坏", "forbidden");
    }
  }

  // ---------- local side ----------

  private async localRecords(): Promise<StoredRecord[]> {
    const { store } = this.deps;
    if (store.allRecords) return store.allRecords();
    const out: StoredRecord[] = [];
    for (const type of RECORD_TYPES) out.push(...await store.all(type));
    return out;
  }

  /**
   * Local snapshot. New local records get a uid; on first contact with a
   * repository, a record whose content equals an unclaimed remote record adopts
   * that uid instead of duplicating it.
   */
  private async scanRecords(state: SyncState, base: EntryMap, remote: EntryMap): Promise<{ entries: EntryMap; payloads: Map<string, Uint8Array>; byUid: Map<string, StoredRecord> }> {
    const records = await this.localRecords();
    const order = (record: StoredRecord) => (record.type === "job" ? 0 : 1);
    records.sort((a, b) => order(a) - order(b) || a.id - b.id);

    const claimed = new Set(Object.values(state.map));
    const unclaimedByHash = new Map<string, string>();
    for (const [uid, entry] of Object.entries(remote)) {
      if (!entry.del && entry.h && !claimed.has(uid)) unclaimedByHash.set(`${entry.t}:${entry.h}`, uid);
    }
    let unclaimedProfile = Object.entries(remote).find(([uid, entry]) => entry.t === "profile" && !entry.del && !claimed.has(uid))?.[0];
    if (records.some((record) => record.type === "profile" && state.map[`profile:${record.id}`])) unclaimedProfile = undefined;

    const entries: EntryMap = {};
    const payloads = new Map<string, Uint8Array>();
    const byUid = new Map<string, StoredRecord>();
    const present = new Set<string>();
    for (const record of records) {
      const localKey = `${record.type}:${record.id}`;
      present.add(localKey);
      const jobUid = record.job_id ? state.map[`job:${record.job_id}`] ?? null : null;
      const bytes = utf8(canonicalJson(recordPayload(record, jobUid)));
      const h = await this.keys.objectId(bytes);
      let uid = state.map[localKey];
      if (!uid) {
        uid = unclaimedByHash.get(`${record.type}:${h}`)
          // The profile is a singleton: two devices that each made one before
          // their first sync share it (newer wins, the other stays in the change log).
          ?? (record.type === "profile" ? unclaimedProfile : undefined)
          ?? randomId(12);
        unclaimedByHash.delete(`${record.type}:${h}`);
        if (uid === unclaimedProfile) unclaimedProfile = undefined;
        state.map[localKey] = uid;
      }
      entries[uid] = { h, u: comparableTime(record.updated_at), t: record.type };
      payloads.set(h, bytes);
      byUid.set(uid, record);
    }
    // Deleted locally since the base.
    const nowIso = this.now().toISOString();
    for (const [localKey, uid] of Object.entries(state.map)) {
      if (present.has(localKey) || entries[uid]) continue;
      const before = base[uid];
      if (before && !before.del) entries[uid] = { h: null, u: nowIso, del: true, t: before.t };
      else if (before) entries[uid] = before;
    }
    // uids in the base that this device never materialized (should not happen) stay as-is.
    const mapped = new Set(Object.values(state.map));
    for (const [uid, entry] of Object.entries(base)) if (!entries[uid] && !mapped.has(uid)) entries[uid] = entry;
    return { entries, payloads, byUid };
  }

  private async fileEntry(state: SyncState, info: { path: string; size: number; mtime: string }): Promise<FileCache> {
    const cached = state.files[info.path];
    if (cached && cached.size === info.size && cached.mtime === info.mtime) return cached;
    const bytes = await this.deps.files!.read(info.path);
    const chunks: string[] = [];
    for (let offset = 0; offset < bytes.length || (offset === 0 && chunks.length === 0); offset += CHUNK_SIZE) {
      chunks.push(await this.keys.objectId(bytes.subarray(offset, offset + CHUNK_SIZE)));
      if (bytes.length === 0) break;
    }
    const manifest = utf8(canonicalJson({ v: 1, size: bytes.length, chunks }));
    const h = await this.keys.objectId(manifest);
    const entry = { size: info.size, mtime: info.mtime, h, chunks };
    state.files[info.path] = entry;
    state.manifests[h] = chunks;
    return entry;
  }

  private async scanFiles(state: SyncState, base: EntryMap): Promise<EntryMap> {
    const entries: EntryMap = {};
    if (!this.deps.files) return { ...base };
    const listed = await this.deps.files.list();
    const seen = new Set<string>();
    for (const info of listed) {
      seen.add(info.path);
      const cache = await this.fileEntry(state, info);
      entries[info.path] = { h: cache.h, u: info.mtime, size: info.size };
    }
    const nowIso = this.now().toISOString();
    for (const [path, entry] of Object.entries(base)) {
      if (seen.has(path)) continue;
      entries[path] = entry.del ? entry : { h: null, u: nowIso, del: true };
      delete state.files[path];
    }
    return entries;
  }

  // ---------- one run ----------

  async run(options: { gc?: boolean } = {}): Promise<SyncRunResult> {
    const { store } = this.deps;
    requireMeta(store);
    await this.openRepo();
    const state = await loadState(store);
    if (state.repo !== this.deps.repoId) {
      state.repo = this.deps.repoId;
      state.base = null;
      state.uploaded = {};
    }

    let pulled = 0;
    let uploadedObjects = 0;
    const conflicts: SyncConflict[] = [];
    let attempts = 0;
    let committed: string | null = null;
    let pushed = 0;

    for (;;) {
      attempts += 1;
      const ref = await this.readRef();
      // Remote repository was emptied/recreated: never replay that as "delete everything here".
      if (!ref.name && state.base?.name) state.base = null;
      const base = state.base ?? { name: null, records: {}, files: {} };
      const remote: { records: EntryMap; files: EntryMap; name: string | null } = ref.name
        ? (ref.name === base.name ? { ...base, name: base.name } : await this.readSnapshot(ref.name))
        : { records: {}, files: {}, name: null };

      const scanned = await this.scanRecords(state, base.records, remote.records);
      const localFiles = await this.scanFiles(state, base.files);
      const recordMerge = threeWayMerge(base.records, scanned.entries, remote.records);
      const fileMerge = this.deps.files ? threeWayMerge(base.files, localFiles, remote.files) : { merged: { ...remote.files }, pull: [], conflicts: [] };

      // 1) Bring remote changes (and conflict copies) into the local store.
      const applied = await this.applyRecords(state, recordMerge.merged, remote.records, recordMerge.pull, recordMerge.conflicts, scanned);
      pulled += applied.pulled;
      conflicts.push(...applied.conflicts);
      const fileApplied = await this.applyFiles(state, fileMerge.merged, remote.files, fileMerge.pull, fileMerge.conflicts);
      pulled += fileApplied.pulled;
      conflicts.push(...fileApplied.conflicts);

      // Local now contains the remote snapshot: it becomes the base, so a lost
      // race below re-merges against it instead of reporting false conflicts.
      if (remote.name) state.base = { name: remote.name, records: remote.records, files: remote.files };
      await saveState(store, state);

      const cutoff = new Date(this.now().getTime() - this.policy.tombstoneDays * DAY).toISOString();
      const mergedRecords = pruneTombstones(recordMerge.merged, cutoff);
      const mergedFiles = pruneTombstones(fileMerge.merged, cutoff);
      const changed = !sameMap(mergedRecords, remote.records) || !sameMap(mergedFiles, remote.files);
      if (!changed) {
        committed = remote.name;
        break;
      }

      // 2) Upload objects the remote does not have yet (resumable).
      uploadedObjects += await this.uploadMissing(state, mergedRecords, mergedFiles, remote, applied.payloads);

      // 3) Snapshot + conditional ref move.
      const at = this.now();
      const name = `${stamp(at)}-${state.device_id}.json`;
      const snapshot: Snapshot = {
        format: 1,
        name,
        parent: remote.name,
        device: state.device_id,
        device_name: this.deps.deviceName,
        created_at: at.toISOString(),
        records: mergedRecords,
        files: mergedFiles,
      };
      await this.deps.s3.put(this.key("snapshots", name), await this.keys.encrypt(utf8(JSON.stringify(snapshot))), { ifNoneMatch: true });
      try {
        await this.deps.s3.put(
          this.key("refs", "latest"),
          utf8(JSON.stringify({ snapshot: name, device: state.device_id, at: at.toISOString() })),
          ref.exists ? { ifMatch: ref.etag ?? "*", contentType: "application/json" } : { ifNoneMatch: true, contentType: "application/json" },
        );
      } catch (error) {
        if (!(error instanceof PreconditionFailed)) throw error;
        // Another device moved refs/latest first. Our snapshot stays orphaned (GC removes it); re-merge.
        if (attempts >= MAX_ATTEMPTS) {
          throw new CoreError("别的设备一直在同步，这次没写进去；稍后再试", "conflict");
        }
        continue;
      }
      pushed = countDiff(mergedRecords, remote.records) + countDiff(mergedFiles, remote.files);
      state.base = { name, records: mergedRecords, files: mergedFiles };
      state.uploaded = {};
      committed = name;
      break;
    }

    let gc: GcResult | undefined;
    const gcDue = !state.last_gc_at || Date.parse(state.last_gc_at) + this.policy.gcEveryDays * DAY < this.now().getTime();
    if (options.gc || gcDue) {
      gc = await this.gc(state);
      state.last_gc_at = this.now().toISOString();
    }
    await saveState(store, state);
    return {
      ok: true,
      at: this.now().toISOString(),
      snapshot: committed,
      pulled,
      pushed,
      uploaded_objects: uploadedObjects,
      conflicts,
      attempts,
      ...(gc ? { gc } : {}),
    };
  }

  private async applyRecords(
    state: SyncState,
    merged: EntryMap,
    remote: EntryMap,
    pull: string[],
    mergeConflicts: MergeConflict[],
    scanned: { payloads: Map<string, Uint8Array>; byUid: Map<string, StoredRecord> },
  ): Promise<{ pulled: number; conflicts: SyncConflict[]; payloads: Map<string, Uint8Array> }> {
    const { store } = this.deps;
    const payloads = new Map(scanned.payloads);
    const uidToLocal = new Map<string, { type: RecordType; id: number }>();
    for (const [localKey, uid] of Object.entries(state.map)) {
      const [type, id] = localKey.split(":");
      uidToLocal.set(uid, { type: type as RecordType, id: Number(id) });
    }

    // Fetch everything first: no network inside the store transaction.
    const fetched = new Map<string, RecordPayload>();
    const need = new Set<string>();
    for (const uid of pull) if (remote[uid]?.h && !remote[uid].del) need.add(remote[uid].h!);
    for (const conflict of mergeConflicts) if (conflict.keep === "local" && conflict.loser.h) need.add(conflict.loser.h);
    for (const h of need) {
      const bytes = scanned.payloads.get(h) ?? await this.getObject(h);
      payloads.set(h, bytes);
      fetched.set(h, JSON.parse(fromUtf8(bytes)) as RecordPayload);
    }

    const conflicts: SyncConflict[] = [];
    let pulled = 0;
    if (!pull.length && !mergeConflicts.length) return { pulled, conflicts, payloads };
    const now = this.now();
    const nowIso = now.toISOString();
    const jobLocalId = (jobUid: string | null) => {
      if (!jobUid) return null;
      const local = uidToLocal.get(jobUid);
      return local && local.type === "job" ? local.id : null;
    };
    const log = (summary: string, type: RecordType, recordId: number, before: StoredRecord | null, after: StoredRecord | null) =>
      store.addChange({ at: nowIso, actor: SYNC_ACTOR, summary, type, record_id: recordId, before: plain(before), after: plain(after) });

    await store.transaction(async () => {
      // Decide conflict copies before the pull overwrites the local loser.
      const copies: Array<{ uid: string; payload: RecordPayload; report: SyncConflict }> = [];
      for (const conflict of mergeConflicts) {
        const type = (merged[conflict.key]?.t ?? conflict.loser.t)!;
        const local = uidToLocal.get(conflict.key);
        const report: SyncConflict = { kind: "record", what: local ? `${TYPE_LABEL[type]} #${local.id}` : TYPE_LABEL[type], kept: conflict.keep, copy: "change-log" };
        conflicts.push(report);
        if (type === "profile") {
          // Singleton: no copy. Remote wins -> the overwrite below is a logged, undoable change.
          // Local wins -> log the remote version as "before" so undo brings it back.
          if (conflict.keep === "local" && local) {
            const current = await store.get("profile", local.id);
            const theirs = fetched.get(conflict.loser.h!)!;
            await store.addChange({
              at: nowIso, actor: SYNC_ACTOR, summary: "同步冲突：两台设备都改了档案，保留了较新的这版（撤销可换回另一台的）",
              type: "profile", record_id: local.id, before: { ...theirs.data, job_id: null }, after: plain(current),
            });
          }
          continue;
        }
        let payload: RecordPayload;
        if (conflict.keep === "remote") {
          const record = scanned.byUid.get(conflict.key)!;
          payload = recordPayload(record, record.job_id ? state.map[`job:${record.job_id}`] ?? null : null);
        } else {
          payload = fetched.get(conflict.loser.h!)!;
        }
        copies.push({ uid: conflict.key, payload, report });
      }

      // Jobs first so children can resolve their job uid.
      const isJob = (uid: string) => (remote[uid]?.t ?? merged[uid]?.t ?? uidToLocal.get(uid)?.type) === "job";
      const ordered = [...pull].sort((a, b) => Number(!isJob(a)) - Number(!isJob(b)));
      for (const uid of ordered) {
        const entry = remote[uid];
        const local = uidToLocal.get(uid);
        const type = entry?.t ?? local?.type;
        if (!type) continue;
        const before = local ? await store.get(local.type, local.id) : null;
        if (!entry || entry.del || !entry.h) {
          if (before) {
            await store.remove(before.type, before.id);
            await log(`同步：其他设备删除了${TYPE_LABEL[before.type]}「${label(before)}」`, before.type, before.id, before, null);
            pulled += 1;
          }
          continue;
        }
        const payload = fetched.get(entry.h)!;
        // A uid this device deleted earlier comes back under its old local id.
        const revive = !before && local && local.type === type ? local.id : undefined;
        const record = await store.put(type, payload.data, {
          id: before ? before.id : revive,
          jobId: jobLocalId(payload.job),
          now: payload.updated_at,
          createdAt: payload.created_at,
          replace: true,
          restore: revive !== undefined,
        });
        if (!before) {
          state.map[`${type}:${record.id}`] = uid;
          uidToLocal.set(uid, { type, id: record.id });
        }
        await log(`同步：其他设备${before ? "更新" : "新建"}了${TYPE_LABEL[type]}「${label(record)}」`, type, record.id, before, record);
        pulled += 1;
      }

      // Conflict copies become new records (new uid, uploaded with this run's snapshot).
      for (const { uid, payload, report } of copies) {
        const data: Json = { ...payload.data, sync_conflict: { of: uid, at: nowIso, device: this.deps.deviceName } };
        for (const field of ["title", "name"]) {
          if (typeof data[field] === "string" && data[field]) {
            data[field] = `${data[field] as string}（同步冲突副本）`;
            break;
          }
        }
        const copy = await store.put(payload.type, data, { jobId: jobLocalId(payload.job), now: nowIso, createdAt: payload.created_at });
        const copyUid = randomId(12);
        state.map[`${copy.type}:${copy.id}`] = copyUid;
        uidToLocal.set(copyUid, { type: copy.type, id: copy.id });
        await log(`同步冲突：两台设备都改了「${label(copy)}」，另一版另存为副本`, copy.type, copy.id, null, copy);
        const bytes = utf8(canonicalJson(recordPayload(copy, payload.job)));
        const h = await this.keys.objectId(bytes);
        payloads.set(h, bytes);
        merged[copyUid] = { h, u: comparableTime(copy.updated_at), t: copy.type };
        report.copy = `${TYPE_LABEL[copy.type]} #${copy.id}`;
      }
    });
    return { pulled, conflicts, payloads };
  }

  private async readFile(manifestId: string): Promise<Uint8Array> {
    const manifest = await this.getJson<{ size: number; chunks: string[] }>(manifestId);
    const parts: Uint8Array[] = [];
    for (const chunk of manifest.chunks) parts.push(await this.getObject(chunk));
    const out = new Uint8Array(manifest.size);
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }

  private async applyFiles(state: SyncState, merged: EntryMap, remote: EntryMap, pull: string[], mergeConflicts: MergeConflict[]): Promise<{ pulled: number; conflicts: SyncConflict[] }> {
    const files = this.deps.files;
    const conflicts: SyncConflict[] = [];
    if (!files) return { pulled: 0, conflicts };
    const at = this.now();
    for (const conflict of mergeConflicts) {
      const copyPath = conflictPath(conflict.key, this.deps.deviceName, at);
      if (conflict.keep === "remote") {
        // Our version loses: move it aside before the pull overwrites it.
        await files.write(copyPath, await files.read(conflict.key));
      } else {
        await files.write(copyPath, await this.readFile(conflict.loser.h!));
      }
      const listed = (await files.list()).find((info) => info.path === copyPath);
      const cache = await this.fileEntry(state, listed ?? { path: copyPath, size: -1, mtime: at.toISOString() });
      merged[copyPath] = { h: cache.h, u: listed?.mtime ?? at.toISOString(), size: cache.size };
      conflicts.push({ kind: "file", what: conflict.key, kept: conflict.keep, copy: copyPath });
    }
    let pulled = 0;
    const written: Array<{ path: string; h: string; size: number; u: string }> = [];
    for (const path of pull) {
      const entry = remote[path];
      if (!entry || entry.del || !entry.h) {
        await files.remove(path);
        delete state.files[path];
      } else {
        const bytes = await this.readFile(entry.h);
        await files.write(path, bytes, entry.u);
        written.push({ path, h: entry.h, size: bytes.length, u: entry.u });
      }
      pulled += 1;
    }
    if (written.length) {
      const listed = new Map((await files.list()).map((info) => [info.path, info]));
      for (const item of written) {
        const info = listed.get(item.path);
        const chunks = state.manifests[item.h] ?? (await this.getJson<{ chunks: string[] }>(item.h)).chunks;
        state.manifests[item.h] = chunks;
        state.files[item.path] = { size: info?.size ?? item.size, mtime: info?.mtime ?? item.u, h: item.h, chunks };
      }
    }
    return { pulled, conflicts };
  }

  /** Upload every object the merged snapshot references that the remote may lack. Progress survives interruption. */
  private async uploadMissing(
    state: SyncState,
    records: EntryMap,
    files: EntryMap,
    remote: { records: EntryMap; files: EntryMap },
    payloads: Map<string, Uint8Array>,
  ): Promise<number> {
    const known = new Set<string>();
    for (const entry of Object.values(remote.records)) if (entry.h) known.add(entry.h);
    for (const entry of Object.values(remote.files)) if (entry.h) known.add(entry.h);
    // Trust our own earlier uploads only while GC would not have collected them.
    const trustAfter = this.now().getTime() - (this.policy.gcGraceHours * 3_600_000) / 2;
    for (const [id, at] of Object.entries(state.uploaded)) {
      if (at >= trustAfter) known.add(id);
      else delete state.uploaded[id];
    }

    let count = 0;
    let sinceSave = 0;
    const mark = async (id: string) => {
      state.uploaded[id] = this.now().getTime();
      known.add(id);
      count += 1;
      sinceSave += 1;
      if (sinceSave >= 20) {
        sinceSave = 0;
        await saveState(this.deps.store, state);
      }
    };
    try {
      for (const entry of Object.values(records)) {
        if (!entry.h || entry.del || known.has(entry.h)) continue;
        const bytes = payloads.get(entry.h);
        if (!bytes) throw new CoreError("本地找不到要上传的记录内容（同步期间被改了？再同步一次）", "conflict");
        await this.putObject(bytes, entry.h);
        await mark(entry.h);
      }
      const pathOf = new Map<string, string>();
      for (const [path, cache] of Object.entries(state.files)) pathOf.set(cache.h, path);
      for (const entry of Object.values(files)) {
        if (!entry.h || entry.del || known.has(entry.h)) continue;
        const path = pathOf.get(entry.h);
        if (!path || !this.deps.files) throw new CoreError("本地找不到要上传的文件（同步期间被删了？再同步一次）", "conflict");
        const cache = state.files[path];
        const bytes = await this.deps.files.read(path);
        for (let i = 0; i < cache.chunks.length; i += 1) {
          const id = cache.chunks[i];
          if (known.has(id)) continue;
          await this.putObject(bytes.subarray(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE), id);
          await mark(id);
        }
        await this.putObject(utf8(canonicalJson({ v: 1, size: bytes.length, chunks: cache.chunks })), entry.h);
        await mark(entry.h);
      }
    } finally {
      await saveState(this.deps.store, state);
    }
    return count;
  }

  // ---------- retention ----------

  /** Keep recent snapshots, delete older ones, then unreferenced objects past the grace period. */
  async gc(state?: SyncState): Promise<GcResult> {
    const own = state ?? await loadState(this.deps.store);
    if (!this.keys) await this.openRepo();
    const { s3 } = this.deps;
    const ref = await this.readRef();
    const listed = (await s3.list(this.key("snapshots") + "/")).map((item) => ({ ...item, name: item.key.slice(this.key("snapshots").length + 1) }));
    listed.sort((a, b) => (a.name < b.name ? 1 : -1));
    const nowMs = this.now().getTime();
    const keep = new Set<string>();
    listed.slice(0, this.policy.keepSnapshots).forEach((item) => keep.add(item.name));
    for (const item of listed) {
      const time = Date.parse(item.lastModified);
      if (Number.isFinite(time) && nowMs - time < this.policy.keepDays * DAY) keep.add(item.name);
      if (Number.isFinite(time) && nowMs - time < this.policy.gcGraceHours * 3_600_000) keep.add(item.name);
    }
    if (ref.name) keep.add(ref.name);

    const referenced = new Set<string>();
    for (const name of keep) {
      if (!listed.some((item) => item.name === name)) continue;
      const snapshot = await this.readSnapshot(name);
      for (const entry of Object.values(snapshot.records)) if (entry.h) referenced.add(entry.h);
      for (const entry of Object.values(snapshot.files)) {
        if (!entry.h) continue;
        referenced.add(entry.h);
        let chunks = own.manifests[entry.h];
        if (!chunks) {
          chunks = (await this.getJson<{ chunks: string[] }>(entry.h)).chunks;
          own.manifests[entry.h] = chunks;
        }
        chunks.forEach((chunk) => referenced.add(chunk));
      }
    }

    let snapshotsDeleted = 0;
    for (const item of listed) {
      if (keep.has(item.name)) continue;
      await s3.delete(item.key);
      snapshotsDeleted += 1;
    }
    let objectsDeleted = 0;
    const graceMs = this.policy.gcGraceHours * 3_600_000;
    for (const item of await s3.list(this.key("objects") + "/")) {
      const id = item.key.slice(item.key.lastIndexOf("/") + 1);
      if (referenced.has(id)) continue;
      const time = Date.parse(item.lastModified);
      if (!Number.isFinite(time) || nowMs - time < graceMs) continue;
      await s3.delete(item.key);
      delete own.manifests[id];
      objectsDeleted += 1;
    }
    return { snapshots_deleted: snapshotsDeleted, objects_deleted: objectsDeleted, snapshots_kept: listed.length - snapshotsDeleted };
  }
}

/**
 * Entry times must compare across devices. Store stamps are local wall-clock
 * without a zone (Python/labels nowIso, second precision); read them as this
 * device's local time and keep UTC ISO. Only used to pick a winner when both
 * sides edited the same record; equal content never depends on it.
 */
export function comparableTime(value: string): string {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : value;
}

function sameMap(a: EntryMap, b: EntryMap): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    const x: Entry | undefined = a[key];
    const y: Entry | undefined = b[key];
    if (!x || !y) return false;
    if (x.h !== y.h || Boolean(x.del) !== Boolean(y.del)) return false;
  }
  return true;
}

function countDiff(a: EntryMap, b: EntryMap): number {
  let n = 0;
  for (const [key, entry] of Object.entries(a)) {
    const other = b[key];
    if (!other || other.h !== entry.h || Boolean(other.del) !== Boolean(entry.del)) n += 1;
  }
  return n;
}
