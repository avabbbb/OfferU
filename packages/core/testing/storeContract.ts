// Shared store contract. Every SyncableStore (companion SQLite, browser
// IndexedDB, anything later) runs this same suite so the core behaves the same
// on every runtime. The test runner is injected so this file does not import
// vitest (each package resolves its own copy).
//
//   import { describe, it, expect } from "vitest";
//   runStoreContract("sqlite", async () => openStore(":memory:"), { describe, it, expect });

import {
  deleteRecord,
  exportPackage,
  importMerge,
  importReplace,
  parsePackage,
  saveRecord,
  undoChange,
  type CoreContext,
  type SyncableStore,
} from "../src/index";

/* eslint-disable @typescript-eslint/no-explicit-any */
export type ContractRunner = {
  describe: (name: string, fn: () => void) => void;
  it: (name: string, fn: () => Promise<void>) => void;
  expect: (value: unknown) => any;
};

const ctx = (actor = "你", now = "2026-11-15T10:00:00"): CoreContext => ({ actor, now, today: now.slice(0, 10) });

export function runStoreContract(label: string, makeStore: () => Promise<SyncableStore>, { describe, it, expect }: ContractRunner): void {
  describe(`store contract: ${label}`, () => {
    it("put / get / all / first keep the record shape", async () => {
      const store = await makeStore();
      const job = await store.put("job", { company: "A", title: "后端", tags: ["x"] }, { now: "2026-01-01T00:00:00" });
      expect(job).toMatchObject({ type: "job", company: "A", job_id: null, created_at: "2026-01-01T00:00:00", updated_at: "2026-01-01T00:00:00" });
      const event = await store.put("event", { title: "面试" }, { now: "2026-01-02T00:00:00", jobId: job.id });
      expect(event.job_id).toBe(job.id);
      expect(await store.get("job", job.id)).toEqual(job);
      expect(await store.get("event", job.id)).toBeNull();
      expect((await store.all("event", job.id)).map((item) => item.id)).toEqual([event.id]);
      expect(await store.all("event", 999)).toEqual([]);
      const second = await store.put("job", { company: "B" }, { now: "2026-01-03T00:00:00" });
      expect((await store.all("job")).map((item) => item.id)).toEqual([second.id, job.id]);
      expect((await store.first("job"))!.id).toBe(job.id);
    });

    it("merge vs replace, null drops a field, reserved keys ignored", async () => {
      const store = await makeStore();
      const job = await store.put("job", { company: "A", title: "T", city: "杭州" }, { now: "2026-01-01T00:00:00" });
      const merged = await store.put("job", { city: null, notes: "n", id: 99, type: "doc" }, { id: job.id, now: "2026-01-02T00:00:00" });
      expect(merged).toMatchObject({ id: job.id, type: "job", company: "A", title: "T", notes: "n", created_at: "2026-01-01T00:00:00", updated_at: "2026-01-02T00:00:00" });
      expect("city" in merged).toBe(false);
      const replaced = await store.put("job", { company: "Z" }, { id: job.id, now: "2026-01-03T00:00:00", replace: true });
      expect(replaced.title).toBeUndefined();
      expect(replaced.company).toBe("Z");
    });

    it("put with an unknown id fails unless restoring; restore keeps the id and later ids skip it", async () => {
      const store = await makeStore();
      await expect(store.put("job", { company: "A" }, { id: 42, now: "2026-01-01T00:00:00" })).rejects.toThrow();
      const restored = await store.put("job", { company: "A" }, { id: 42, now: "2026-01-01T00:00:00", restore: true, createdAt: "2025-12-01T00:00:00" });
      expect(restored.id).toBe(42);
      expect(restored.created_at).toBe("2025-12-01T00:00:00");
      const next = await store.put("job", { company: "B" }, { now: "2026-01-01T00:00:00" });
      expect(next.id).toBeGreaterThan(42);
    });

    it("deleted ids are never handed out again", async () => {
      const store = await makeStore();
      const saved = await saveRecord(store, { type: "job", data: { company: "A" } }, ctx());
      await deleteRecord(store, { type: "job", id: saved.record.id }, ctx());
      const again = await saveRecord(store, { type: "job", data: { company: "B" } }, ctx());
      expect(again.record.id).not.toBe(saved.record.id);
    });

    it("transaction is all-or-nothing", async () => {
      const store = await makeStore();
      await expect(store.transaction(async () => {
        await store.put("job", { company: "A" }, { now: "2026-01-01T00:00:00" });
        await store.addChange({ at: "2026-01-01T00:00:00", actor: "你", summary: "x", type: "job", record_id: 1, before: null, after: {} });
        throw new Error("boom");
      })).rejects.toThrow("boom");
      expect(await store.all("job")).toEqual([]);
      expect(await store.changes(10)).toEqual([]);
      // the store still works after a rollback
      const result = await saveRecord(store, { type: "job", data: { company: "B" } }, ctx());
      expect(result.change_id).toBeTypeOf("number");
    });

    it("reads inside a transaction see its own writes", async () => {
      const store = await makeStore();
      await store.transaction(async () => {
        const job = await store.put("job", { company: "A" }, { now: "2026-01-01T00:00:00" });
        expect((await store.get("job", job.id))!.company).toBe("A");
        expect((await store.all("job")).length).toBe(1);
        await store.remove("job", job.id);
        expect(await store.get("job", job.id)).toBeNull();
        expect(await store.all("job")).toEqual([]);
      });
    });

    it("change log: order, limit, last, update", async () => {
      const store = await makeStore();
      const a = await store.addChange({ at: "t1", actor: "你", summary: "a", type: "job", record_id: 1, before: null, after: { company: "A" } });
      const b = await store.addChange({ at: "t2", actor: "Agent", summary: "b", type: "job", record_id: 1, before: { company: "A" }, after: { company: "B" } });
      expect(b).toBeGreaterThan(a);
      expect((await store.changes(10)).map((row) => row.id)).toEqual([b, a]);
      expect((await store.changes(1)).map((row) => row.id)).toEqual([b]);
      expect((await store.lastChange())!.id).toBe(b);
      await store.updateChange(a, { undone_at: "t3" });
      expect((await store.getChange(a))!.undone_at).toBe("t3");
      expect((await store.getChange(a))!.after).toEqual({ company: "A" });
      expect(await store.getChange(9999)).toBeNull();
    });

    it("core save / delete / undo round trip", async () => {
      const store = await makeStore();
      const saved = await saveRecord(store, { type: "job", data: { company: "A", title: "后端" } }, ctx());
      const event = await saveRecord(store, { type: "event", data: { title: "笔试", job_id: saved.record.id } }, ctx());
      expect(event.record.job_id).toBe(saved.record.id);
      const removed = await deleteRecord(store, { type: "job", id: saved.record.id }, ctx("你", "2026-11-15T10:01:00"));
      expect(await store.get("job", saved.record.id)).toBeNull();
      await undoChange(store, { change_id: removed.change_id }, ctx("你", "2026-11-15T10:02:00"));
      const back = await store.get("job", saved.record.id);
      expect(back).toMatchObject({ company: "A", title: "后端", status: "saved" });
      await expect(undoChange(store, { change_id: removed.change_id }, ctx())).rejects.toMatchObject({ code: "conflict" });
    });

    it("concurrent transactions do not interleave", async () => {
      const store = await makeStore();
      const results = await Promise.all(Array.from({ length: 8 }, (_, index) =>
        saveRecord(store, { type: "job", data: { company: `C${index}` } }, ctx())));
      const ids = new Set(results.map((result) => result.record.id));
      expect(ids.size).toBe(8);
      expect((await store.all("job")).length).toBe(8);
      expect((await store.changes(50)).length).toBe(8);
    });

    it("entries: rev grows on every write, deletes leave tombstones, re-create clears them", async () => {
      const store = await makeStore();
      expect(await store.entries()).toEqual([]);
      const start = await store.storeRev();
      const saved = await saveRecord(store, { type: "job", data: { company: "A" } }, ctx());
      const first = (await store.entries()).find((entry) => entry.id === saved.record.id)!;
      expect(first).toMatchObject({ type: "job", deleted: false, updated_at: saved.record.updated_at });
      expect(first.rev).toBeGreaterThan(start);
      await saveRecord(store, { type: "job", id: saved.record.id, data: { title: "T" } }, ctx("你", "2026-11-15T11:00:00"));
      const second = (await store.entries()).find((entry) => entry.id === saved.record.id)!;
      expect(second.rev).toBeGreaterThan(first.rev);
      expect(second.updated_at).toBe("2026-11-15T11:00:00");
      const removed = await deleteRecord(store, { type: "job", id: saved.record.id }, ctx());
      const tomb = (await store.entries()).find((entry) => entry.id === saved.record.id)!;
      expect(tomb.deleted).toBe(true);
      expect(tomb.rev).toBeGreaterThan(second.rev);
      expect(await store.storeRev()).toBeGreaterThanOrEqual(tomb.rev);
      await undoChange(store, { change_id: removed.change_id }, ctx());
      const back = (await store.entries()).filter((entry) => entry.id === saved.record.id);
      expect(back).toHaveLength(1);
      expect(back[0].deleted).toBe(false);
      expect(back[0].rev).toBeGreaterThan(tomb.rev);
    });

    it("exportState / replaceState round trip; replaced-away records become tombstones", async () => {
      const store = await makeStore();
      const job = await saveRecord(store, { type: "job", data: { company: "A" } }, ctx());
      await saveRecord(store, { type: "event", data: { title: "E", job_id: job.record.id } }, ctx());
      const state = await store.exportState();
      expect(state.records.map((record) => record.type)).toEqual(["job", "event"]);
      expect(state.changes).toHaveLength(2);
      expect(state.nextRecordId).toBeGreaterThan(Math.max(...state.records.map((record) => record.id)));

      const other = await makeStore();
      const extra = await saveRecord(other, { type: "doc", data: { kind: "note", title: "x" } }, ctx());
      await other.replaceState(state);
      const copied = await other.exportState();
      expect(copied.records).toEqual(state.records);
      expect(copied.changes).toEqual(state.changes);
      const entries = await other.entries();
      if (!state.records.some((record) => record.id === extra.record.id)) {
        expect(entries.find((entry) => entry.id === extra.record.id)?.deleted).toBe(true);
      }
      // the change log survives: undo works on the copy
      await undoChange(other, { change_id: state.changes[1].id }, ctx());
      expect(await other.all("event")).toEqual([]);
    });

    it("data packages: replace and merge (ids remapped, links kept, one profile)", async () => {
      const source = await makeStore();
      await saveRecord(source, { type: "profile", data: { name: "林" } }, ctx());
      const job = await saveRecord(source, { type: "job", data: { company: "A" } }, ctx());
      await saveRecord(source, { type: "event", data: { title: "面试", job_id: job.record.id } }, ctx());
      const pkg = parsePackage(JSON.stringify(await exportPackage(source)));

      const target = await makeStore();
      await saveRecord(target, { type: "profile", data: { name: "我" } }, ctx());
      const mine = await saveRecord(target, { type: "job", data: { company: "Mine" } }, ctx());
      const result = await importMerge(target, pkg);
      expect(result).toMatchObject({ records: 2, skipped_profile: true });
      const jobs = await target.all("job");
      expect(jobs.map((item) => item.company).sort()).toEqual(["A", "Mine"]);
      const imported = jobs.find((item) => item.company === "A")!;
      expect(imported.id).not.toBe(mine.record.id);
      const events = await target.all("event");
      expect(events).toHaveLength(1);
      expect(events[0].job_id).toBe(imported.id);
      expect((await target.first("profile"))!.name).toBe("我");
      // imported change rows point at the remapped ids, so undo still works
      const change = (await target.changes(50)).find((row) => row.summary.includes("面试"))!;
      expect(change.record_id).toBe(events[0].id);
      expect(change.after?.job_id).toBe(imported.id);

      await importReplace(target, pkg);
      expect((await target.first("profile"))!.name).toBe("林");
      expect((await target.all("job")).map((item) => item.company)).toEqual(["A"]);
    });
  });
}
