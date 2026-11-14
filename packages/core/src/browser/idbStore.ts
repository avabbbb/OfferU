// IndexedDB adapter for the shared core: the browser runtime's database.
//
// Layout (database "offeru" by default, version 1):
//   records     keyPath id, index "type"   one row per record + its rev
//   tombstones  keyPath id                 deleted records, for sync
//   changes     keyPath id                 the change log (undo)
//   meta        key "state"                { rev, nextRecordId, nextChangeId }
//   settings    free keys                  local-only config (LLM keys, sync creds)
//
// Transactions: an IndexedDB transaction auto-commits as soon as the code
// awaits anything that is not an IndexedDB request, and core operations await
// plenty. So writes inside `transaction(fn)` go to an in-memory overlay that
// reads see first; on success the overlay is written in ONE readwrite IDB
// transaction. Other tabs write the same database, so the commit checks that
// meta.rev is still the value read when `fn` started (optimistic concurrency).
// If another tab committed in between, the overlay is dropped and `fn` re-runs
// on fresh data. Within one tab, transactions queue.
//
// Browser-only API surface (IndexedDB) but no DOM/React: it also runs in Node
// tests over fake-indexeddb. Not exported from the core index; import
// "@offeru/core/idb".

import { openDB, type DBSchema, type IDBPDatabase } from "idb";

import { CoreError, type ChangeRow, type Json, type PutOptions, type RecordType, type StoredRecord } from "../types";
import { emptyState, nextIds, type PortableState, type RecordEntry, type SyncableStore } from "../stores";

type RecordRow = {
  id: number;
  type: RecordType;
  job_id: number | null;
  created_at: string;
  updated_at: string;
  rev: number;
  data: Json;
};

type TombRow = { id: number; type: RecordType; rev: number; deleted_at: string };

type Meta = { rev: number; nextRecordId: number; nextChangeId: number; origin: "empty" | "seed" | "migrated" | "replaced" };

interface OfferuDb extends DBSchema {
  records: { key: number; value: RecordRow; indexes: { type: RecordType } };
  tombstones: { key: number; value: TombRow };
  changes: { key: number; value: ChangeRow };
  meta: { key: string; value: Meta };
  settings: { key: string; value: unknown };
}

export type IdbStoreOptions = {
  /** IndexedDB database name. Default "offeru". */
  name?: string;
  /**
   * First open only (no meta yet): old data to carry over, e.g. the showcase
   * localforage snapshot. Runs before `seed`; null means nothing to migrate.
   */
  migrate?: () => Promise<PortableState | null>;
  /** First open only, when nothing was migrated: initial data (demo seed). */
  seed?: () => PortableState | null;
  /** How many times a transaction re-runs after losing a race with another tab. */
  maxRetries?: number;
  /** Called after every successful commit (cross-tab refresh hooks). */
  onCommit?: (rev: number) => void;
};

const META_KEY = "state";
const RESERVED = ["id", "type", "job_id", "created_at", "updated_at"];

const copy = <T>(value: T): T => (value === undefined || value === null ? value : structuredClone(value));

function toRecord(row: RecordRow): StoredRecord {
  return {
    ...copy(row.data),
    id: row.id,
    type: row.type,
    job_id: row.job_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  } as StoredRecord;
}

function dataOf(record: StoredRecord): Json {
  const out: Json = {};
  for (const [key, value] of Object.entries(record)) if (!RESERVED.includes(key)) out[key] = value;
  return out;
}

function sortRecords(items: StoredRecord[]): StoredRecord[] {
  return items.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)) || b.id - a.id);
}

class Overlay {
  readonly records = new Map<number, RecordRow | null>();
  readonly tombs = new Map<number, TombRow | null>();
  readonly changes = new Map<number, ChangeRow>();
  constructor(readonly meta: Meta, readonly baseRev: number) {}
  get empty(): boolean {
    return !this.records.size && !this.tombs.size && !this.changes.size;
  }
}

class LostRace extends Error {}

export class IdbCoreStore implements SyncableStore {
  readonly name: string;
  private dbPromise: Promise<IDBPDatabase<OfferuDb>> | null = null;
  private readyPromise: Promise<void> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private tx: Overlay | null = null;

  constructor(private readonly options: IdbStoreOptions = {}) {
    this.name = options.name ?? "offeru";
  }

  // ---- lifecycle -------------------------------------------------------

  private db(): Promise<IDBPDatabase<OfferuDb>> {
    this.dbPromise ??= openDB<OfferuDb>(this.name, 1, {
      upgrade(db) {
        const records = db.createObjectStore("records", { keyPath: "id" });
        records.createIndex("type", "type");
        db.createObjectStore("tombstones", { keyPath: "id" });
        db.createObjectStore("changes", { keyPath: "id" });
        db.createObjectStore("meta");
        db.createObjectStore("settings");
      },
    });
    return this.dbPromise;
  }

  /** Open the database and run first-open migration/seed. Idempotent; every method calls it. */
  ready(): Promise<void> {
    this.readyPromise ??= this.init().catch((error) => {
      this.readyPromise = null;
      throw error;
    });
    return this.readyPromise;
  }

  private async init(): Promise<void> {
    const db = await this.db();
    if (await db.get("meta", META_KEY)) return;
    let initial: PortableState | null = null;
    let origin: Meta["origin"] = "empty";
    if (this.options.migrate) {
      initial = await this.options.migrate();
      if (initial) origin = "migrated";
    }
    if (!initial && this.options.seed) {
      initial = this.options.seed();
      if (initial) origin = "seed";
    }
    const state = initial ?? emptyState();
    const t = db.transaction(["records", "changes", "meta"], "readwrite");
    // Another tab may have initialised while we were reading the old data.
    if (await t.objectStore("meta").get(META_KEY)) {
      await t.done;
      return;
    }
    const ids = nextIds(state);
    const writes: Array<Promise<unknown>> = [];
    for (const record of state.records) writes.push(t.objectStore("records").put(this.rowFrom(record, 1)));
    for (const change of state.changes) writes.push(t.objectStore("changes").put(copy(change)));
    writes.push(t.objectStore("meta").put({ rev: state.records.length ? 1 : 0, ...ids, origin }, META_KEY));
    await Promise.all(writes);
    await t.done;
  }

  /** How this database got its first data: "empty", "seed", "migrated" or "replaced". */
  async origin(): Promise<Meta["origin"]> {
    await this.ready();
    return (await (await this.db()).get("meta", META_KEY))!.origin;
  }

  close(): void {
    void this.dbPromise?.then((db) => db.close());
    this.dbPromise = null;
    this.readyPromise = null;
  }

  private rowFrom(record: StoredRecord, rev: number): RecordRow {
    return {
      id: record.id,
      type: record.type,
      job_id: typeof record.job_id === "number" ? record.job_id : null,
      created_at: record.created_at,
      updated_at: record.updated_at,
      rev,
      data: copy(dataOf(record)),
    };
  }

  private async meta(): Promise<Meta> {
    await this.ready();
    return (await (await this.db()).get("meta", META_KEY))!;
  }

  // ---- reads (overlay first, then committed data) ----------------------

  private async row(id: number): Promise<RecordRow | null> {
    if (this.tx?.records.has(id)) return this.tx.records.get(id) ?? null;
    await this.ready();
    return (await (await this.db()).get("records", id)) ?? null;
  }

  async all(type: RecordType, jobId?: number | null): Promise<StoredRecord[]> {
    await this.ready();
    const byId = new Map<number, RecordRow>();
    for (const row of await (await this.db()).getAllFromIndex("records", "type", type)) byId.set(row.id, row);
    if (this.tx) {
      for (const [id, row] of this.tx.records) {
        if (row && row.type === type) byId.set(id, row);
        else byId.delete(id);
      }
    }
    const rows = [...byId.values()].filter((row) => jobId === undefined || row.job_id === jobId);
    return sortRecords(rows.map(toRecord));
  }

  async get(type: RecordType, id: number): Promise<StoredRecord | null> {
    const row = await this.row(id);
    return row && row.type === type ? toRecord(row) : null;
  }

  async first(type: RecordType): Promise<StoredRecord | null> {
    const items = await this.all(type);
    return items.sort((a, b) => a.id - b.id)[0] ?? null;
  }

  async changes(limit: number): Promise<ChangeRow[]> {
    await this.ready();
    const db = await this.db();
    const rows = new Map<number, ChangeRow>();
    let cursor = await db.transaction("changes").store.openCursor(null, "prev");
    while (cursor && rows.size < limit) {
      rows.set(cursor.value.id, cursor.value);
      cursor = await cursor.continue();
    }
    if (this.tx) for (const [id, row] of this.tx.changes) rows.set(id, row);
    return [...rows.values()].sort((a, b) => b.id - a.id).slice(0, limit).map((row) => copy(row));
  }

  async getChange(id: number): Promise<ChangeRow | null> {
    const pending = this.tx?.changes.get(id);
    if (pending) return copy(pending);
    await this.ready();
    return copy((await (await this.db()).get("changes", id)) ?? null);
  }

  async lastChange(): Promise<ChangeRow | null> {
    return (await this.changes(1))[0] ?? null;
  }

  // ---- writes (always inside an overlay) -------------------------------

  async put(type: RecordType, data: Json, options: PutOptions): Promise<StoredRecord> {
    if (!this.tx) return this.transaction(() => this.put(type, data, options));
    const tx = this.tx;
    const existing = options.id === undefined ? null : await this.get(type, options.id);
    if (options.id !== undefined && !existing && !options.restore) {
      throw new Error(`${type} #${options.id} 不存在`);
    }
    const base = options.replace || !existing ? {} : dataOf(existing);
    const merged: Json = { ...base, ...copy(data) };
    for (const [key, value] of Object.entries(merged)) if (value === null || RESERVED.includes(key)) delete merged[key];

    const now = options.now;
    const id = existing?.id ?? options.id ?? tx.meta.nextRecordId++;
    tx.meta.nextRecordId = Math.max(tx.meta.nextRecordId, id + 1);
    const row: RecordRow = {
      id,
      type,
      job_id: options.jobId === undefined ? existing?.job_id ?? null : options.jobId,
      created_at: existing?.created_at ?? options.createdAt ?? now,
      updated_at: now,
      rev: 0,
      data: merged,
    };
    tx.records.set(id, row);
    tx.tombs.set(id, null);
    return toRecord(row);
  }

  async remove(type: RecordType, id: number): Promise<void> {
    if (!this.tx) return this.transaction(() => this.remove(type, id));
    const row = await this.row(id);
    if (!row || row.type !== type) return;
    this.tx.records.set(id, null);
    this.tx.tombs.set(id, { id, type, rev: 0, deleted_at: new Date().toISOString() });
  }

  async addChange(row: Omit<ChangeRow, "id" | "undone_at">): Promise<number> {
    if (!this.tx) return this.transaction(() => this.addChange(row));
    const tx = this.tx;
    const id = tx.meta.nextChangeId++;
    tx.meta.nextRecordId = Math.max(tx.meta.nextRecordId, row.record_id + 1);
    tx.changes.set(id, { ...copy(row), id, undone_at: null });
    return id;
  }

  async updateChange(id: number, patch: Partial<Pick<ChangeRow, "at" | "after" | "undone_at">>): Promise<void> {
    if (!this.tx) return this.transaction(() => this.updateChange(id, patch));
    const row = await this.getChange(id);
    if (!row) throw new Error(`改动 #${id} 不存在`);
    this.tx.changes.set(id, { ...row, ...copy(patch) });
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    if (this.tx) return fn();
    const run = this.queue.then(() => this.runTransaction(fn));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async runTransaction<T>(fn: () => Promise<T>): Promise<T> {
    const retries = this.options.maxRetries ?? 8;
    for (let attempt = 0; ; attempt += 1) {
      const meta = await this.meta();
      const overlay = new Overlay({ ...meta }, meta.rev);
      this.tx = overlay;
      let result: T;
      try {
        result = await fn();
      } finally {
        this.tx = null;
      }
      if (overlay.empty) return result;
      try {
        const rev = await this.commit(overlay);
        this.options.onCommit?.(rev);
        return result;
      } catch (error) {
        if (!(error instanceof LostRace)) throw error;
        if (attempt >= retries) throw new CoreError("另一个标签页同时在改数据，这次没写进去，请再试一次", "conflict");
        await new Promise((resolve) => setTimeout(resolve, Math.random() * 20 * (attempt + 1)));
      }
    }
  }

  private async commit(overlay: Overlay): Promise<number> {
    const db = await this.db();
    const t = db.transaction(["records", "tombstones", "changes", "meta"], "readwrite");
    const current = await t.objectStore("meta").get(META_KEY);
    if (!current || current.rev !== overlay.baseRev) {
      t.abort();
      await t.done.catch(() => undefined);
      throw new LostRace();
    }
    const rev = overlay.baseRev + 1;
    const writes: Array<Promise<unknown>> = [];
    for (const [id, row] of overlay.records) {
      writes.push(row ? t.objectStore("records").put({ ...row, rev }) : t.objectStore("records").delete(id));
    }
    for (const [id, tomb] of overlay.tombs) {
      writes.push(tomb ? t.objectStore("tombstones").put({ ...tomb, rev }) : t.objectStore("tombstones").delete(id));
    }
    for (const row of overlay.changes.values()) writes.push(t.objectStore("changes").put(row));
    writes.push(t.objectStore("meta").put({ ...overlay.meta, rev }, META_KEY));
    await Promise.all(writes);
    await t.done;
    return rev;
  }

  // ---- SyncableStore ---------------------------------------------------

  async entries(): Promise<RecordEntry[]> {
    await this.ready();
    const t = (await this.db()).transaction(["records", "tombstones"]);
    const [rows, tombs] = await Promise.all([t.objectStore("records").getAll(), t.objectStore("tombstones").getAll()]);
    const out: RecordEntry[] = [
      ...rows.map((row) => ({ id: row.id, type: row.type, rev: row.rev, updated_at: row.updated_at, deleted: false })),
      ...tombs.map((tomb) => ({ id: tomb.id, type: tomb.type, rev: tomb.rev, updated_at: tomb.deleted_at, deleted: true })),
    ];
    return out.sort((a, b) => a.id - b.id);
  }

  async storeRev(): Promise<number> {
    return (await this.meta()).rev;
  }

  async exportState(): Promise<PortableState> {
    await this.ready();
    const t = (await this.db()).transaction(["records", "changes", "meta"]);
    const [rows, changes, meta] = await Promise.all([
      t.objectStore("records").getAll(),
      t.objectStore("changes").getAll(),
      t.objectStore("meta").get(META_KEY),
    ]);
    return {
      version: 1,
      nextRecordId: meta!.nextRecordId,
      nextChangeId: meta!.nextChangeId,
      records: rows.sort((a, b) => a.id - b.id).map(toRecord),
      changes: changes.sort((a, b) => a.id - b.id),
    };
  }

  replaceState(state: PortableState): Promise<void> {
    const run = this.queue.then(async () => {
      await this.ready();
      const db = await this.db();
      const t = db.transaction(["records", "tombstones", "changes", "meta"], "readwrite");
      const meta = (await t.objectStore("meta").get(META_KEY))!;
      const rev = meta.rev + 1;
      const keep = new Set(state.records.map((record) => record.id));
      const old = await t.objectStore("records").getAll();
      const now = new Date().toISOString();
      const writes: Array<Promise<unknown>> = [];
      for (const row of old) {
        if (!keep.has(row.id)) writes.push(t.objectStore("tombstones").put({ id: row.id, type: row.type, rev, deleted_at: now }));
      }
      writes.push(t.objectStore("records").clear(), t.objectStore("changes").clear());
      await Promise.all(writes.splice(0));
      for (const record of state.records) {
        writes.push(t.objectStore("records").put(this.rowFrom(record, rev)), t.objectStore("tombstones").delete(record.id));
      }
      for (const change of state.changes) writes.push(t.objectStore("changes").put(copy(change)));
      const ids = nextIds(state);
      writes.push(t.objectStore("meta").put({
        rev,
        nextRecordId: Math.max(ids.nextRecordId, meta.nextRecordId),
        nextChangeId: Math.max(ids.nextChangeId, meta.nextChangeId),
        origin: "replaced",
      }, META_KEY));
      await Promise.all(writes);
      await t.done;
      this.options.onCommit?.(rev);
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  // ---- local settings (never synced, never exported) -------------------

  async getSetting<T = unknown>(key: string): Promise<T | null> {
    await this.ready();
    return ((await (await this.db()).get("settings", key)) as T | undefined) ?? null;
  }

  async setSetting(key: string, value: unknown): Promise<void> {
    await this.ready();
    await (await this.db()).put("settings", copy(value), key);
  }

  async deleteSetting(key: string): Promise<void> {
    await this.ready();
    await (await this.db()).delete("settings", key);
  }
}

export function openIdbStore(options: IdbStoreOptions = {}): IdbCoreStore {
  return new IdbCoreStore(options);
}
