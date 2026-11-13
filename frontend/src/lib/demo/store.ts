import localforage from "localforage";

import { buildDemoState, type DemoState } from "./seed";
import type { ChangeRow, CoreStore, Json, PutOptions, RecordType, StoredRecord } from "@offeru/core";

const STATE_KEY = "offeru-demo-state:v1";
const storage = localforage.createInstance({ name: "offeru-demo", storeName: "records" });

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export class BrowserDemoStore implements CoreStore {
  private state: DemoState | null = null;
  private loading: Promise<void> | null = null;
  private writes: Promise<void> = Promise.resolve();
  private txQueue: Promise<unknown> = Promise.resolve();
  private inTx = false;

  constructor(private readonly initialState: () => DemoState = buildDemoState) {}

  async ready(): Promise<Promise<void>> {
    this.loading ??= this.load();
    await this.loading;
  }

  private async load(): Promise<void> {
    const saved = await storage.getItem<DemoState>(STATE_KEY);
    if (saved && saved.version === 1 && Array.isArray(saved.records) && Array.isArray(saved.changes)) {
      this.state = saved;
      return;
    }
    this.state = this.initialState();
    await storage.setItem(STATE_KEY, this.state);
  }

  private current(): DemoState {
    if (!this.state) throw new Error("Demo store 还没加载");
    return this.state;
  }

  async all(type: RecordType, jobId?: number | null): Promise<StoredRecord[]> {
    const items = this.current().records.filter((record) => record.type === type && (jobId === undefined || record.job_id === jobId));
    return [...items].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)) || b.id - a.id);
  }

  async get(type: RecordType, id: number): Promise<StoredRecord | null> {
    return this.current().records.find((record) => record.type === type && record.id === id) ?? null;
  }

  async first(type: RecordType): Promise<StoredRecord | null> {
    return this.current().records.filter((record) => record.type === type).sort((a, b) => a.id - b.id)[0] ?? null;
  }

  async put(type: RecordType, data: Json, options: PutOptions): Promise<StoredRecord> {
    const state = this.current();
    const clean: Json = {};
    for (const [key, value] of Object.entries(data)) {
      if (["id", "type", "job_id", "created_at", "updated_at"].includes(key)) continue;
      if (value !== null) clean[key] = value;
    }
    const existing = options.id !== undefined ? await this.get(type, options.id) : null;
    if (options.id !== undefined && !existing && !options.restore) throw new Error(`${type} #${options.id} 不存在`);
    if (existing) {
      const merged: StoredRecord = options.replace
        ? {
            ...clean,
            id: existing.id,
            type,
            job_id: options.jobId === undefined ? existing.job_id : options.jobId,
            created_at: existing.created_at,
            updated_at: options.now,
          }
        : {
            ...existing,
            ...clean,
            id: existing.id,
            type,
            job_id: options.jobId === undefined ? existing.job_id : options.jobId,
            created_at: existing.created_at,
            updated_at: options.now,
          };
      for (const key of Object.keys(merged)) {
        if (merged[key] === null && !["job_id"].includes(key)) delete merged[key];
      }
      state.records = state.records.map((record) => (record.id === existing.id ? merged : record));
      return clone(merged);
    }
    const id = options.id ?? state.nextRecordId++;
    if (options.id !== undefined) state.nextRecordId = Math.max(state.nextRecordId, id + 1);
    const record: StoredRecord = {
      ...clean,
      id,
      type,
      job_id: options.jobId ?? null,
      created_at: options.createdAt ?? options.now,
      updated_at: options.now,
    };
    state.records.push(record);
    return clone(record);
  }

  async remove(type: RecordType, id: number): Promise<void> {
    const state = this.current();
    state.records = state.records.filter((record) => !(record.type === type && record.id === id));
  }

  async changes(limit: number): Promise<ChangeRow[]> {
    return clone([...this.current().changes].sort((a, b) => b.id - a.id).slice(0, limit));
  }

  async getChange(id: number): Promise<ChangeRow | null> {
    return this.current().changes.find((row) => row.id === id) ?? null;
  }

  async lastChange(): Promise<ChangeRow | null> {
    return this.current().changes.reduce<ChangeRow | null>((last, row) => (!last || row.id > last.id ? row : last), null);
  }

  async addChange(row: Omit<ChangeRow, "id" | "undone_at">): Promise<number> {
    const state = this.current();
    const id = state.nextChangeId++;
    state.changes.push({ ...row, id, undone_at: null });
    return id;
  }

  async updateChange(id: number, patch: Partial<Pick<ChangeRow, "at" | "after" | "undone_at">>): Promise<void> {
    const row = this.current().changes.find((change) => change.id === id);
    if (!row) throw new Error(`改动 #${id} 不存在`);
    Object.assign(row, patch);
  }

  /**
   * All-or-nothing over the in-memory state: on failure the snapshot taken at
   * BEGIN is restored, on success the state is flushed to IndexedDB. Calls
   * queue so two concurrent tool calls never see each other's half-writes.
   */
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    if (this.inTx) return fn();
    const run = this.txQueue.then(async () => {
      const before = clone(this.current());
      this.inTx = true;
      try {
        const result = await fn();
        this.inTx = false;
        await this.flush();
        return result;
      } catch (error) {
        this.state = before;
        throw error;
      } finally {
        this.inTx = false;
      }
    });
    this.txQueue = run.catch(() => undefined);
    return run;
  }

  /** Persist the current snapshot; writes are serialized so a slow IndexedDB write never reorders. */
  flush(): Promise<void> {
    const snapshot = this.state ? clone(this.state) : null;
    this.writes = this.writes.then(async () => {
      if (snapshot) await storage.setItem(STATE_KEY, snapshot);
    });
    return this.writes;
  }

  /** Replace the entire demo state, e.g. after importing a portable data package. */
  async replace(next: DemoState): Promise<Promise<void>> {
    await this.writes;
    this.state = clone(next);
    await storage.setItem(STATE_KEY, this.state);
  }

  async reset(): Promise<Promise<void>> {
    await this.writes;
    this.state = this.initialState();
    await storage.setItem(STATE_KEY, this.state);
  }

  /** Test/debug helper: a copy that cannot mutate the live store. */
  snapshot(): DemoState {
    return clone(this.current());
  }
}

export const demoStore = new BrowserDemoStore();

export async function resetDemoData(): Promise<void> {
  await demoStore.reset();
}

