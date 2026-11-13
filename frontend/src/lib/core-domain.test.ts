import { describe, expect, it } from "vitest";

import { deleteRecord, overview, saveRecord, undoChange, searchRecords } from "@offeru/core";
import type { ChangeRow, CoreContext, CoreStore, Json, PutOptions, RecordType, StoredRecord } from "@offeru/core";

class MemoryStore implements CoreStore {
  records: StoredRecord[] = [];
  changeRows: ChangeRow[] = [];
  nextRecord = 1;
  nextChange = 1;

  async all(type: RecordType, jobId?: number | null): Promise<StoredRecord[]> {
    return this.records
      .filter((record) => record.type === type && (jobId === undefined || record.job_id === jobId))
      .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)) || b.id - a.id);
  }

  async get(type: RecordType, id: number): Promise<StoredRecord | null> {
    return this.records.find((record) => record.type === type && record.id === id) ?? null;
  }

  async first(type: RecordType): Promise<StoredRecord | null> {
    return this.records.filter((record) => record.type === type).sort((a, b) => a.id - b.id)[0] ?? null;
  }

  async put(type: RecordType, data: Json, options: PutOptions): Promise<StoredRecord> {
    const existing = options.id === undefined ? null : await this.get(type, options.id);
    if (options.id !== undefined && !existing && !options.restore) throw new Error("missing");
    if (existing) {
      const next: StoredRecord = options.replace
        ? { ...data, id: existing.id, type, job_id: options.jobId === undefined ? existing.job_id : options.jobId, created_at: existing.created_at, updated_at: options.now } as StoredRecord
        : { ...existing, ...data, job_id: options.jobId === undefined ? existing.job_id : options.jobId, updated_at: options.now } as StoredRecord;
      for (const key of Object.keys(next)) if (next[key] === null && key !== "job_id") delete next[key];
      this.records = this.records.map((record) => (record.id === existing.id ? next : record));
      return next;
    }
    const id = options.id ?? this.nextRecord++;
    const record = {
      ...data,
      id,
      type,
      job_id: options.jobId ?? null,
      created_at: options.createdAt ?? options.now,
      updated_at: options.now,
    } as StoredRecord;
    this.records.push(record);
    return record;
  }

  async remove(type: RecordType, id: number): Promise<void> {
    this.records = this.records.filter((record) => !(record.type === type && record.id === id));
  }

  async changes(limit: number): Promise<ChangeRow[]> {
    return [...this.changeRows].sort((a, b) => b.id - a.id).slice(0, limit);
  }

  async getChange(id: number): Promise<ChangeRow | null> {
    return this.changeRows.find((row) => row.id === id) ?? null;
  }

  async lastChange(): Promise<ChangeRow | null> {
    return [...this.changeRows].sort((a, b) => b.id - a.id)[0] ?? null;
  }

  async addChange(row: Omit<ChangeRow, "id" | "undone_at">): Promise<number> {
    const id = this.nextChange++;
    this.changeRows.push({ ...row, id, undone_at: null });
    return id;
  }

  async updateChange(id: number, patch: Partial<Pick<ChangeRow, "at" | "after" | "undone_at">>): Promise<void> {
    Object.assign(this.changeRows.find((row) => row.id === id)!, patch);
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    const records = structuredClone(this.records);
    const changeRows = structuredClone(this.changeRows);
    try {
      return await fn();
    } catch (error) {
      this.records = records;
      this.changeRows = changeRows;
      throw error;
    }
  }

  async seedProfile(): Promise<StoredRecord> {
    return this.put("profile", { name: "测试", stage: "applying" }, { now: "2026-01-01T09:00:00" });
  }
}

const ctx: CoreContext = { actor: "你", now: "2026-01-10T10:00:00", today: "2026-01-10" };

function job(store: MemoryStore, data: Json = {}) {
  return saveRecord(store, { type: "job", data: { company: "示例公司", title: "后端实习", ...data } }, ctx);
}

describe("demo core", () => {
  it("defaults a new job to saved and undo removes it", async () => {
    const store = new MemoryStore();
    const saved = (await job(store));
    expect(saved.record.status).toBe("saved");
    expect((await store.changes(5))[0].before).toBeNull();
    await undoChange(store, { change_id: saved.change_id }, { ...ctx, now: "2026-01-10T10:01:00" });
    expect((await store.get("job", saved.record.id))).toBeNull();
    expect((await store.getChange(saved.change_id!))?.undone_at).toBe("2026-01-10T10:01:00");
  });

  it("adds applied_at and undo restores the previous job", async () => {
    const store = new MemoryStore();
    const saved = (await job(store));
    const applied = (await saveRecord(store, { type: "job", id: saved.record.id, data: { status: "applied" } }, { ...ctx, now: "2026-01-10T10:02:00" }));
    expect(applied.record.status).toBe("applied");
    expect(applied.record.applied_at).toBe("2026-01-10");
    await undoChange(store, { change_id: applied.change_id }, { ...ctx, now: "2026-01-10T10:03:00" });
    expect((await store.get("job", saved.record.id))?.status).toBe("saved");
    expect((await store.get("job", saved.record.id))?.applied_at).toBeUndefined();
  });

  it("merges a duplicate URL without moving status backwards", async () => {
    const store = new MemoryStore();
    const saved = (await job(store, { url: "https://example.com/jobs/1?utm_source=x" }));
    await saveRecord(store, { type: "job", id: saved.record.id, data: { status: "applied" } }, ctx);
    const again = (await saveRecord(store, {
      type: "job",
      data: { url: "https://example.com/jobs/1", city: "杭州", status: "saved" },
    }, { ...ctx, now: "2026-01-10T10:04:00" }));
    expect(again.existed).toBe(true);
    expect(again.record.id).toBe(saved.record.id);
    expect(again.record.status).toBe("applied");
    expect(again.record.city).toBe("杭州");
  });

  it("deletes and restores a record", async () => {
    const store = new MemoryStore();
    const saved = (await job(store));
    const removed = (await deleteRecord(store, { type: "job", id: saved.record.id }, ctx));
    expect((await store.get("job", saved.record.id))).toBeNull();
    await undoChange(store, { change_id: removed.change_id }, { ...ctx, now: "2026-01-10T10:05:00" });
    expect((await store.get("job", saved.record.id))?.title).toBe("后端实习");
  });

  it("keeps agent writes behind the user-only guards", async () => {
    const store = new MemoryStore();
    const saved = (await job(store, { status: "offer" }));
    await expect((saveRecord(store, { type: "job", id: saved.record.id, data: { status: "saved" } }, { ...ctx, actor: "Agent" }))).rejects.toThrow(/只有用户/);
    await expect((saveRecord(store, { type: "memory", data: { kind: "skill", title: "x", confirmed: true } }, { ...ctx, actor: "Agent" }))).rejects.toThrow(/只有用户/);
  });

  it("buckets overview events and searches records", async () => {
    const store = new MemoryStore();
    await store.seedProfile();
    const saved = (await job(store, { company: "字节跳动", title: "后端" }));
    await store.put("event", { title: "逾期", kind: "todo", at: "2026-01-09T10:00", done: false, job_id: saved.record.id }, { now: "2026-01-09T09:00:00" });
    await store.put("event", { title: "今天", kind: "interview", at: "2026-01-10T14:00", done: false }, { now: "2026-01-09T09:00:00" });
    await store.put("event", { title: "以后", kind: "todo", at: null, done: false }, { now: "2026-01-09T09:00:00" });
    const view = (await overview(store, ctx));
    expect(view.todos.overdue.map((event) => event.title)).toContain("逾期");
    expect(view.todos.today.map((event) => event.title)).toContain("今天");
    expect(view.todos.undated.map((event) => event.title)).toContain("以后");
    expect((await searchRecords(store, { query: "字节" })).items[0]).toMatchObject({ type: "job", label: "字节跳动 · 后端" });
  });
});
