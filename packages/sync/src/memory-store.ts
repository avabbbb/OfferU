// In-memory CoreStore with the same semantics as the SQLite and browser demo
// adapters (merge-on-put, null drops a field, ids shared across types and the
// change log). Used by tests and as a stand-in "browser" store.

import type { ChangeRow, CoreStore, Json, PutOptions, RecordType, StoredRecord } from "@offeru/core";

const META = ["id", "type", "job_id", "created_at", "updated_at"];

export class MemoryCoreStore implements CoreStore {
  records: StoredRecord[] = [];
  changeRows: ChangeRow[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private inTx = false;

  async all(type: RecordType, jobId?: number | null): Promise<StoredRecord[]> {
    return this.records
      .filter((record) => record.type === type && (jobId === undefined || record.job_id === jobId))
      .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)) || b.id - a.id)
      .map((record) => structuredClone(record));
  }

  async get(type: RecordType, id: number): Promise<StoredRecord | null> {
    const found = this.records.find((record) => record.type === type && record.id === id);
    return found ? structuredClone(found) : null;
  }

  async first(type: RecordType): Promise<StoredRecord | null> {
    const found = this.records.filter((record) => record.type === type).sort((a, b) => a.id - b.id)[0];
    return found ? structuredClone(found) : null;
  }

  async put(type: RecordType, data: Json, options: PutOptions): Promise<StoredRecord> {
    const existing = options.id === undefined ? undefined : this.records.find((record) => record.type === type && record.id === options.id);
    if (options.id !== undefined && !existing && !options.restore) throw new Error(`${type} #${options.id} 不存在`);
    const base: Json = {};
    if (existing && !options.replace) {
      for (const [key, value] of Object.entries(existing)) if (!META.includes(key)) base[key] = value;
    }
    const merged: Json = { ...base, ...structuredClone(data) };
    for (const key of Object.keys(merged)) if (merged[key] === null || META.includes(key)) delete merged[key];
    const id = existing?.id ?? options.id ?? this.nextId();
    const record = {
      ...merged,
      id,
      type,
      job_id: options.jobId === undefined ? existing?.job_id ?? null : options.jobId,
      created_at: existing?.created_at ?? options.createdAt ?? options.now,
      updated_at: options.now,
    } as StoredRecord;
    this.records = [...this.records.filter((row) => !(row.type === type && row.id === id)), record];
    return structuredClone(record);
  }

  async remove(type: RecordType, id: number): Promise<void> {
    this.records = this.records.filter((record) => !(record.type === type && record.id === id));
  }

  async changes(limit: number): Promise<ChangeRow[]> {
    return [...this.changeRows].reverse().slice(0, limit).map((row) => structuredClone(row));
  }

  async getChange(id: number): Promise<ChangeRow | null> {
    const found = this.changeRows.find((row) => row.id === id);
    return found ? structuredClone(found) : null;
  }

  async lastChange(): Promise<ChangeRow | null> {
    const last = this.changeRows.at(-1);
    return last ? structuredClone(last) : null;
  }

  async addChange(row: Omit<ChangeRow, "id" | "undone_at">): Promise<number> {
    const id = (this.changeRows.at(-1)?.id ?? 0) + 1;
    this.changeRows.push({ ...structuredClone(row), id, undone_at: null });
    return id;
  }

  async updateChange(id: number, patch: Partial<Pick<ChangeRow, "at" | "after" | "undone_at">>): Promise<void> {
    const row = this.changeRows.find((item) => item.id === id);
    if (row) Object.assign(row, structuredClone(patch));
  }

  /** Snapshot + restore on error gives the same all-or-nothing contract as SQLite. */
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    if (this.inTx) return fn();
    const run = this.queue.then(async () => {
      this.inTx = true;
      const records = structuredClone(this.records);
      const changes = structuredClone(this.changeRows);
      try {
        return await fn();
      } catch (error) {
        this.records = records;
        this.changeRows = changes;
        throw error;
      } finally {
        this.inTx = false;
      }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private nextId(): number {
    return Math.max(0, ...this.records.map((record) => record.id), ...this.changeRows.map((row) => row.record_id)) + 1;
  }
}
