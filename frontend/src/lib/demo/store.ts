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

  constructor(private readonly initialState: () => DemoState = buildDemoState) {}

  async ready(): Promise<void> {
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

  all(type: RecordType, jobId?: number | null): StoredRecord[] {
    const items = this.current().records.filter((record) => record.type === type && (jobId === undefined || record.job_id === jobId));
    return [...items].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)) || b.id - a.id);
  }

  get(type: RecordType, id: number): StoredRecord | null {
    return this.current().records.find((record) => record.type === type && record.id === id) ?? null;
  }

  first(type: RecordType): StoredRecord | null {
    return this.current().records.filter((record) => record.type === type).sort((a, b) => a.id - b.id)[0] ?? null;
  }

  put(type: RecordType, data: Json, options: PutOptions): StoredRecord {
    const state = this.current();
    const clean: Json = {};
    for (const [key, value] of Object.entries(data)) {
      if (["id", "type", "job_id", "created_at", "updated_at"].includes(key)) continue;
      if (value !== null) clean[key] = value;
    }
    const existing = options.id !== undefined ? this.get(type, options.id) : null;
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

  remove(type: RecordType, id: number): void {
    const state = this.current();
    state.records = state.records.filter((record) => !(record.type === type && record.id === id));
  }

  changes(limit: number): ChangeRow[] {
    return clone([...this.current().changes].sort((a, b) => b.id - a.id).slice(0, limit));
  }

  getChange(id: number): ChangeRow | null {
    return this.current().changes.find((row) => row.id === id) ?? null;
  }

  lastChange(): ChangeRow | null {
    return this.current().changes.reduce<ChangeRow | null>((last, row) => (!last || row.id > last.id ? row : last), null);
  }

  addChange(row: Omit<ChangeRow, "id" | "undone_at">): number {
    const state = this.current();
    const id = state.nextChangeId++;
    state.changes.push({ ...row, id, undone_at: null });
    return id;
  }

  updateChange(id: number, patch: Partial<Pick<ChangeRow, "at" | "after" | "undone_at">>): void {
    const row = this.getChange(id);
    if (!row) throw new Error(`改动 #${id} 不存在`);
    Object.assign(row, patch);
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
  async replace(next: DemoState): Promise<void> {
    await this.writes;
    this.state = clone(next);
    await storage.setItem(STATE_KEY, this.state);
  }

  async reset(): Promise<void> {
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

