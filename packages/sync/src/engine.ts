// The sync engine. Same code in the browser (IndexedDB demo store), the Node
// companion (SQLite) and a Worker: the caller injects a CoreStore (records +
// change log), a BlobStore (bucket) and a SyncStateStore (local sync state).
//
// One sync():
//   1. open repo (KDF + key check; wrong passphrase stops here), take the lock
//   2. read refs/latest -> snapshot index; download only records whose chunk
//      ids differ from our base
//   3. inside one store transaction: read local records, three-way merge per
//      record, write the result back with change-log rows (actor "同步")
//   4. build the new index, upload only chunks the bucket does not have,
//      write the index, CAS refs/latest (If-Match). Lost the race -> back to 2
//   5. release the lock, save state (new base = merged snapshot)

import { type CoreStore, type Json, type RecordType, type StoredRecord, TYPE_LABEL, label, plain } from "@offeru/core";

import { canonicalJson, fromUtf8, randomId, utf8 } from "./bytes";
import type { BlobStore } from "./blobstore";
import { type ChunkParams, DEFAULT_CHUNKS, chunk } from "./chunker";
import { SyncError } from "./errors";
import { type MergeOutcome, type Side, type SyncRecord, type Tomb, contentOf, isLive, isTombSide, mergeRecord } from "./merge";
import { type IndexEntry, RemoteRepo, type SnapshotIndex, isTomb } from "./repo";
import { type BaseEntry, type SyncState, type SyncStateStore, emptyState } from "./state";

export const RECORD_TYPES: RecordType[] = ["profile", "job", "memory", "event", "doc"];
const META = new Set(["id", "type", "job_id", "created_at", "updated_at"]);

export type SyncEngineOptions = {
  store: CoreStore;
  blobs: BlobStore;
  state: SyncStateStore;
  passphrase: string;
  /** change-log actor for writes made by sync */
  actor?: string;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  lock?: { ttlMs?: number; attempts?: number; waitMs?: number };
  /** how many times to re-merge when refs/latest moved under us */
  maxAttempts?: number;
  chunks?: ChunkParams;
  kdfIterations?: number;
};

export type SyncResult = {
  at: string;
  index: string | null;
  /** this sync initialized an empty bucket */
  initialized: boolean;
  /** local records created / updated / deleted by this sync */
  pulled: number;
  /** records whose remote entry changed in the new snapshot */
  pushed: number;
  uploaded: { objects: number; bytes: number };
  downloaded: { objects: number };
  conflicts: number;
  resurrected: number;
  attempts: number;
};

export type SyncStatus = {
  device: string;
  last_sync_at: string | null;
  last_index: string | null;
  /** local records that differ from the last synced snapshot */
  pending: number;
};

type LocalView = {
  sides: Map<string, Side>;
  /** uid -> local id */
  idOf: Map<string, number>;
  rows: Map<string, StoredRecord>;
  uids: Record<string, string>;
};

function dataOf(record: StoredRecord): Json {
  const data: Json = {};
  for (const [key, value] of Object.entries(record)) {
    if (META.has(key) || value === null || value === undefined) continue;
    data[key] = value;
  }
  return JSON.parse(canonicalJson(data)) as Json;
}

function entryOf(value: SyncRecord | Tomb, chunks: string[]): BaseEntry {
  return isLive(value) ? { c: chunks, r: value } : { t: value.deleted_at };
}

function sideOfBase(uid: string, entry: BaseEntry | undefined): Side {
  if (!entry) return undefined;
  return "t" in entry ? { uid, deleted_at: entry.t } : entry.r;
}

function sameChunks(a: string[] | undefined, b: string[] | undefined): boolean {
  return Boolean(a && b && a.length === b.length && a.every((id, i) => id === b[i]));
}

function recordLabel(record: SyncRecord, id = 0): string {
  return label({ ...record.data, id, type: record.type } as StoredRecord);
}

export class SyncEngine {
  private readonly actor: string;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly chunks: ChunkParams;
  private repo: RemoteRepo | null = null;

  constructor(private readonly options: SyncEngineOptions) {
    this.actor = options.actor ?? "同步";
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.chunks = options.chunks ?? DEFAULT_CHUNKS;
  }

  /** Opens the repo and checks the passphrase without syncing. */
  async connect(): Promise<RemoteRepo> {
    this.repo ??= await RemoteRepo.open(this.options.blobs, this.options.passphrase, {
      iterations: this.options.kdfIterations,
      now: this.now().toISOString(),
    });
    return this.repo;
  }

  async status(): Promise<SyncStatus> {
    const state = await this.loadState(null);
    const local = await this.readLocal(state, new Map(), false);
    let pending = 0;
    const uids = new Set([...local.sides.keys(), ...Object.keys(state.base)]);
    for (const uid of uids) {
      const now = local.sides.get(uid);
      const base = sideOfBase(uid, state.base[uid]);
      if (isLive(now) !== isLive(base) || (isLive(now) && isLive(base) && contentOf(now) !== contentOf(base))) pending += 1;
    }
    return { device: state.device, last_sync_at: state.last_sync_at, last_index: state.last_index, pending };
  }

  async sync(): Promise<SyncResult> {
    const repo = await this.connect();
    const initialized = repo.created;
    let state = await this.loadState(repo);
    const lock = this.options.lock ?? {};
    await repo.acquireLock(state.device, {
      ttlMs: lock.ttlMs ?? 120_000,
      attempts: lock.attempts ?? 5,
      waitMs: lock.waitMs ?? 2_000,
      now: () => this.now().getTime(),
      sleep: this.sleep,
    });
    const result: SyncResult = {
      at: "", index: null, initialized, pulled: 0, pushed: 0,
      uploaded: { objects: 0, bytes: 0 }, downloaded: { objects: 0 }, conflicts: 0, resurrected: 0, attempts: 0,
    };
    try {
      const maxAttempts = this.options.maxAttempts ?? 4;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        result.attempts = attempt;
        const done = await this.attempt(repo, state, result);
        state = done.state;
        await this.options.state.save(state);
        if (done.committed) {
          result.at = state.last_sync_at!;
          result.index = state.last_index;
          return result;
        }
      }
      throw new SyncError("conflict", "远端快照一直在变（其他设备同时在同步），稍后再试");
    } finally {
      await repo.releaseLock().catch(() => undefined);
    }
  }

  private async attempt(repo: RemoteRepo, state: SyncState, result: SyncResult): Promise<{ state: SyncState; committed: boolean }> {
    const nowIso = this.now().toISOString();
    const latest = await repo.getLatest();
    const remoteIndex = latest ? await repo.getIndex(latest.ref.index) : null;
    const remote = await this.readRemote(repo, state, remoteIndex, result);

    // Merge + apply locally in one transaction so concurrent local writes queue behind us.
    const applied = await this.options.store.transaction(async () => {
      const local = await this.readLocal(state, remote.sides, state.last_index === null);
      const merged = new Map<string, SyncRecord | Tomb>();
      const outcomes = new Map<string, MergeOutcome>();
      const uids = new Set([...Object.keys(state.base), ...local.sides.keys(), ...remote.sides.keys()]);
      for (const uid of uids) {
        const outcome = mergeRecord(sideOfBase(uid, state.base[uid]), local.sides.get(uid), remote.sides.get(uid));
        outcomes.set(uid, outcome);
        if (outcome.value) merged.set(uid, outcome.value);
      }
      for (const outcome of outcomes.values()) {
        if (outcome.resurrected) result.resurrected += 1;
        if (!outcome.conflict) continue;
        result.conflicts += 1;
        const copy = this.conflictCopy(outcome.conflict.loser, outcome.conflict.fields, outcome.conflict.winner, nowIso);
        merged.set(copy.uid, copy);
      }
      result.pulled += await this.apply(local, merged, nowIso);
      return { merged, uids: local.uids, idOf: local.idOf };
    });

    // Local store now holds the merged snapshot. Persist the id map right away and a
    // base that already accounts for what we took from remote, so a crash or a lost
    // CAS never makes remote changes look like local edits next time.
    const working: SyncState = { ...state, uids: applied.uids, base: retryBase(state.base, remote.entries, remote.sides, applied.merged) };

    const records: Record<string, IndexEntry> = {};
    const uploads = new Map<string, Uint8Array>();
    const chunkIds = new Map<string, string[]>();
    for (const [uid, value] of [...applied.merged.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (!isLive(value)) {
        records[uid] = { t: value.deleted_at };
        continue;
      }
      const remoteEntry = remote.entries[uid];
      const remoteSide = remote.sides.get(uid);
      if (remoteEntry && !isTomb(remoteEntry) && isLive(remoteSide) && canonicalJson(remoteSide) === canonicalJson(value)) {
        records[uid] = remoteEntry;
        chunkIds.set(uid, remoteEntry.c);
        continue;
      }
      const ids: string[] = [];
      for (const part of chunk(utf8(canonicalJson(value)), this.chunks)) {
        const id = await repo.id(part);
        ids.push(id);
        uploads.set(id, part);
      }
      records[uid] = { c: ids };
      chunkIds.set(uid, ids);
    }

    const committedBase = (): Record<string, BaseEntry> => {
      const base: Record<string, BaseEntry> = {};
      for (const [uid, value] of applied.merged) base[uid] = entryOf(value, chunkIds.get(uid) ?? []);
      return base;
    };

    const unchanged = remoteIndex
      ? canonicalJson(remoteIndex.records) === canonicalJson(records)
      : Object.keys(records).length === 0;
    if (unchanged) {
      return {
        committed: true,
        state: { ...working, base: committedBase(), last_index: latest?.ref.index ?? null, last_sync_at: nowIso },
      };
    }

    // Upload only chunks the bucket does not already hold.
    const known = new Set<string>();
    for (const entry of Object.values(remote.entries)) if (!isTomb(entry)) entry.c.forEach((id) => known.add(id));
    for (const entry of Object.values(state.base)) if ("c" in entry) entry.c.forEach((id) => known.add(id));
    for (const [id, part] of uploads) {
      if (known.has(id) || await repo.hasObject(id)) continue;
      await repo.putObject(id, part);
      known.add(id);
      result.uploaded.objects += 1;
      result.uploaded.bytes += part.length;
    }
    for (const uid of Object.keys(records)) {
      if (canonicalJson(records[uid]) !== canonicalJson(remote.entries[uid])) result.pushed += 1;
    }

    const index: SnapshotIndex = { v: 1, parent: latest?.ref.index ?? null, device: working.device, created_at: nowIso, records };
    const indexId = await repo.putIndex(index);
    const ok = await repo.casLatest({ index: indexId, device: working.device, at: nowIso }, latest?.etag ?? null);
    if (!ok) {
      result.pushed = 0;
      return { committed: false, state: working };
    }
    return { committed: true, state: { ...working, base: committedBase(), last_index: indexId, last_sync_at: nowIso } };
  }

  private async loadState(repo: RemoteRepo | null): Promise<SyncState> {
    const saved = await this.options.state.load();
    let state = saved ?? emptyState(randomId(8));
    if (repo && (state.repo_id !== repo.repoId || state.location !== this.options.blobs.location)) {
      // New or re-created bucket: start over (records are matched by content on first sync).
      state = { ...emptyState(state.device), repo_id: repo.repoId, location: this.options.blobs.location };
    }
    if (!saved) await this.options.state.save(state);
    return state;
  }

  private async readRemote(
    repo: RemoteRepo,
    state: SyncState,
    index: SnapshotIndex | null,
    result: SyncResult,
  ): Promise<{ sides: Map<string, Side>; entries: Record<string, IndexEntry> }> {
    const sides = new Map<string, Side>();
    const entries = index?.records ?? {};
    const cache = new Map<string, Uint8Array>();
    for (const [uid, entry] of Object.entries(entries)) {
      if (isTomb(entry)) {
        sides.set(uid, { uid, deleted_at: entry.t });
        continue;
      }
      const base = state.base[uid];
      if (base && "c" in base && sameChunks(base.c, entry.c)) {
        sides.set(uid, base.r);
        continue;
      }
      const parts: Uint8Array[] = [];
      for (const id of entry.c) {
        let part = cache.get(id);
        if (!part) {
          part = await repo.getObject(id);
          cache.set(id, part);
          result.downloaded.objects += 1;
        }
        parts.push(part);
      }
      const total = parts.reduce((sum, part) => sum + part.length, 0);
      const joined = new Uint8Array(total);
      let offset = 0;
      for (const part of parts) {
        joined.set(part, offset);
        offset += part.length;
      }
      sides.set(uid, JSON.parse(fromUtf8(joined)) as SyncRecord);
    }
    return { sides, entries };
  }

  /**
   * Local records as merge sides keyed by uid. On the first sync with a repo,
   * unmapped local records adopt the uid of an identical remote record (and the
   * single profile adopts the remote profile), so linking a second device that
   * already has the same data does not duplicate it.
   */
  private async readLocal(state: SyncState, remote: Map<string, Side>, adopt: boolean): Promise<LocalView> {
    const rows: StoredRecord[] = [];
    for (const type of RECORD_TYPES) rows.push(...await this.options.store.all(type));
    rows.sort((a, b) => a.id - b.id);

    const uids: Record<string, string> = {};
    const claimed = new Set<string>();
    for (const row of rows) {
      const uid = state.uids[String(row.id)];
      if (uid) {
        uids[String(row.id)] = uid;
        claimed.add(uid);
      }
    }
    if (adopt) {
      const byContent = new Map<string, string>();
      const profiles: string[] = [];
      for (const side of remote.values()) {
        if (!isLive(side) || claimed.has(side.uid)) continue;
        byContent.set(canonicalJson({ type: side.type, data: side.data, created_at: side.created_at }), side.uid);
        if (side.type === "profile") profiles.push(side.uid);
      }
      for (const row of rows) {
        if (uids[String(row.id)]) continue;
        const key = canonicalJson({ type: row.type, data: dataOf(row), created_at: row.created_at });
        let uid = byContent.get(key);
        if ((!uid || claimed.has(uid)) && row.type === "profile" && profiles.length === 1 && !claimed.has(profiles[0])) uid = profiles[0];
        if (uid && !claimed.has(uid)) {
          uids[String(row.id)] = uid;
          claimed.add(uid);
        }
      }
    }
    for (const row of rows) uids[String(row.id)] ??= randomId(16);

    const sides = new Map<string, Side>();
    const idOf = new Map<string, number>();
    const byUid = new Map<string, StoredRecord>();
    for (const row of rows) {
      const uid = uids[String(row.id)];
      idOf.set(uid, row.id);
      byUid.set(uid, row);
      sides.set(uid, {
        uid,
        type: row.type,
        job: row.job_id === null || row.job_id === undefined ? null : uids[String(row.job_id)] ?? null,
        data: dataOf(row),
        created_at: row.created_at,
        updated_at: row.updated_at,
      });
    }
    // Remember ids of records deleted here while the snapshot still tracks them, so a
    // record resurrected by a concurrent edit elsewhere comes back under its old id.
    for (const [id, uid] of Object.entries(state.uids)) {
      if (idOf.has(uid) || !state.base[uid]) continue;
      idOf.set(uid, Number(id));
      uids[id] = uid;
    }
    const deletedAt = this.now().toISOString();
    for (const [uid, entry] of Object.entries(state.base)) {
      if (sides.has(uid)) continue;
      sides.set(uid, "t" in entry ? { uid, deleted_at: entry.t } : { uid, deleted_at: deletedAt });
    }
    return { sides, idOf, rows: byUid, uids };
  }

  private conflictCopy(loser: SyncRecord, fields: string[], winner: "local" | "remote", at: string): SyncRecord {
    const lines = fields.map((field) => {
      const value = field === "job_id" ? loser.job : loser.data[field];
      return `- ${field}: ${typeof value === "string" ? value : JSON.stringify(value)}`;
    });
    const where = winner === "local" ? "另一台设备" : "这台设备";
    return {
      uid: randomId(16),
      type: "doc",
      job: loser.type === "job" ? loser.uid : loser.job,
      data: {
        kind: "note",
        title: `同步冲突：${TYPE_LABEL[loser.type]}「${recordLabel(loser)}」未采用的版本`,
        body: [
          `两台设备同时改了同一条${TYPE_LABEL[loser.type]}。已按最后修改时间保留较新的版本，${where}的版本存在这里，需要的话手动挑回去。`,
          "",
          "冲突字段（未采用的值）：",
          ...lines,
          "",
          "完整的未采用版本：",
          "```json",
          JSON.stringify({ ...loser.data, updated_at: loser.updated_at }, null, 2),
          "```",
        ].join("\n"),
        sync_conflict: { uid: loser.uid, type: loser.type, fields, at },
      },
      created_at: at,
      updated_at: at,
    };
  }

  /** Writes merged values that differ from local through the store, one change-log row each. */
  private async apply(local: LocalView, merged: Map<string, SyncRecord | Tomb>, now: string): Promise<number> {
    const store = this.options.store;
    let count = 0;
    const order = (type: RecordType) => RECORD_TYPES.indexOf(type);
    const live = [...merged.values()].filter(isLive).sort((a, b) => order(a.type) - order(b.type) || (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));

    for (const record of live) {
      const current = local.rows.get(record.uid);
      const side = local.sides.get(record.uid);
      // Timestamp-only differences are not worth a write or a change-log row.
      if (current && isLive(side) && contentOf(side) === contentOf(record)) continue;
      const linked = record.job ? local.rows.get(record.job)?.id ?? null : null;
      const previousId = local.idOf.get(record.uid);
      const restore = !current && previousId !== undefined && !(await this.idTaken(previousId));
      const saved = await store.put(record.type, record.data, {
        id: current ? current.id : restore ? previousId : undefined,
        jobId: linked,
        now: record.updated_at,
        createdAt: record.created_at,
        replace: true,
        restore,
      });
      local.rows.set(record.uid, saved);
      local.idOf.set(record.uid, saved.id);
      local.uids[String(saved.id)] = record.uid;
      const verb = current ? "更新" : restore ? "恢复" : "新建";
      await store.addChange({
        at: now,
        actor: this.actor,
        summary: `同步${verb}${TYPE_LABEL[record.type]}「${label(saved)}」`,
        type: record.type,
        record_id: saved.id,
        before: plain(current ?? null),
        after: plain(saved),
      });
      count += 1;
    }

    for (const [uid, value] of merged) {
      if (!isTombSide(value)) continue;
      const current = local.rows.get(uid);
      if (!current) continue;
      await store.remove(current.type, current.id);
      local.rows.delete(uid);
      await store.addChange({
        at: now,
        actor: this.actor,
        summary: `同步删除${TYPE_LABEL[current.type]}「${label(current)}」`,
        type: current.type,
        record_id: current.id,
        before: plain(current),
        after: null,
      });
      count += 1;
    }
    return count;
  }

  private async idTaken(id: number): Promise<boolean> {
    for (const type of RECORD_TYPES) if (await this.options.store.get(type, id)) return true;
    return false;
  }
}

/**
 * Base to use after the merged result is applied locally but before (or
 * without) committing it: wherever we adopted the remote value, the remote
 * snapshot is the new common ancestor; elsewhere keep the old base.
 */
function retryBase(
  base: Record<string, BaseEntry>,
  remoteEntries: Record<string, IndexEntry>,
  remoteSides: Map<string, Side>,
  merged: Map<string, SyncRecord | Tomb>,
): Record<string, BaseEntry> {
  const next: Record<string, BaseEntry> = { ...base };
  for (const [uid, value] of merged) {
    const remote = remoteSides.get(uid);
    const entry = remoteEntries[uid];
    if (!remote || !entry) continue;
    if (isLive(value) && isLive(remote) && !isTomb(entry)) {
      if (contentOf(value) === contentOf(remote)) {
        next[uid] = { c: entry.c, r: remote };
        continue;
      }
      const old = sideOfBase(uid, base[uid]);
      const oldData = isLive(old) ? old.data : {};
      const data: Json = {};
      const keys = new Set([...Object.keys(oldData), ...Object.keys(remote.data), ...Object.keys(value.data)]);
      for (const key of keys) {
        const pick = canonicalJson(value.data[key]) === canonicalJson(remote.data[key]) ? remote.data[key] : oldData[key];
        if (pick !== undefined) data[key] = pick;
      }
      const job = value.job === remote.job ? remote.job : isLive(old) ? old.job : null;
      next[uid] = { c: [], r: { ...remote, job, data } };
    } else if (!isLive(value) && isTombSide(remote)) {
      next[uid] = { t: remote.deleted_at };
    }
  }
  return next;
}
