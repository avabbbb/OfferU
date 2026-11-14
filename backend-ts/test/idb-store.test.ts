import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";

import { saveRecord, type PortableState } from "@offeru/core";
import { IdbCoreStore } from "@offeru/core/idb";

let n = 0;
const fresh = () => `idb-${Date.now()}-${n++}`;
const ctx = { actor: "你", now: "2026-11-15T10:00:00", today: "2026-11-15" };

const legacy: PortableState = {
  version: 1,
  nextRecordId: 10,
  nextChangeId: 3,
  records: [
    { id: 1, type: "job", job_id: null, created_at: "2026-01-01T00:00:00", updated_at: "2026-01-01T00:00:00", company: "Old", status: "saved" },
    { id: 4, type: "event", job_id: 1, created_at: "2026-01-01T00:00:00", updated_at: "2026-01-01T00:00:00", title: "E" },
  ],
  changes: [
    { id: 2, at: "2026-01-01T00:00:00", actor: "你", summary: "新建岗位「Old」", type: "job", record_id: 1, before: null, after: { company: "Old" }, undone_at: null },
  ],
};

describe("IdbCoreStore (browser specifics)", () => {
  it("two tabs writing at once both land (optimistic retry on meta.rev)", async () => {
    const name = fresh();
    const tabA = new IdbCoreStore({ name });
    const tabB = new IdbCoreStore({ name });
    await Promise.all([tabA.ready(), tabB.ready()]);
    const results = await Promise.all([
      ...Array.from({ length: 5 }, (_, i) => saveRecord(tabA, { type: "job", data: { company: `A${i}` } }, ctx)),
      ...Array.from({ length: 5 }, (_, i) => saveRecord(tabB, { type: "job", data: { company: `B${i}` } }, ctx)),
    ]);
    expect(new Set(results.map((r) => r.record.id)).size).toBe(10);
    expect((await tabA.all("job")).length).toBe(10);
    expect(new Set((await tabB.changes(50)).map((row) => row.id)).size).toBe(10);
  });

  it("migrates old data once, keeping ids, and never seeds over it", async () => {
    const name = fresh();
    let migrations = 0;
    let seeds = 0;
    const open = () => new IdbCoreStore({
      name,
      migrate: async () => { migrations += 1; return legacy; },
      seed: () => { seeds += 1; return null; },
    });
    const store = open();
    expect(await store.origin()).toBe("migrated");
    expect((await store.get("job", 1))!.company).toBe("Old");
    expect((await store.all("event", 1)).length).toBe(1);
    expect((await store.lastChange())!.id).toBe(2);
    const next = await saveRecord(store, { type: "job", data: { company: "New" } }, ctx);
    expect(next.record.id).toBe(10);
    expect(next.change_id).toBe(3);
    store.close();
    const again = open();
    await again.ready();
    expect(migrations).toBe(1);
    expect(seeds).toBe(0);
    expect((await again.all("job")).length).toBe(2);
  });

  it("seeds only an empty first open", async () => {
    const name = fresh();
    const store = new IdbCoreStore({ name, migrate: async () => null, seed: () => legacy });
    expect(await store.origin()).toBe("seed");
    expect((await store.all("job")).length).toBe(1);
    const empty = new IdbCoreStore({ name: fresh() });
    expect(await empty.origin()).toBe("empty");
  });

  it("returned records are copies (mutating them does not touch the store)", async () => {
    const store = new IdbCoreStore({ name: fresh() });
    const saved = await saveRecord(store, { type: "job", data: { company: "A", tags: ["x"] } }, ctx);
    (saved.record.tags as string[]).push("y");
    expect((await store.get("job", saved.record.id))!.tags).toEqual(["x"]);
  });

  it("settings are local key/value and not part of exported state", async () => {
    const store = new IdbCoreStore({ name: fresh() });
    await store.setSetting("llm", { base_url: "https://x", api_key: "k" });
    expect(await store.getSetting("llm")).toEqual({ base_url: "https://x", api_key: "k" });
    expect(JSON.stringify(await store.exportState())).not.toContain("api_key");
    await store.deleteSetting("llm");
    expect(await store.getSetting("llm")).toBeNull();
  });

  it("onCommit fires with the new rev", async () => {
    const revs: number[] = [];
    const store = new IdbCoreStore({ name: fresh(), onCommit: (rev) => revs.push(rev) });
    await saveRecord(store, { type: "job", data: { company: "A" } }, ctx);
    await store.replaceState(legacy);
    expect(revs).toEqual([1, 2]);
    expect(await store.storeRev()).toBe(2);
  });
});
