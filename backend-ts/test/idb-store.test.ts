import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";

import { saveRecord, type PortableState } from "@offeru/core";
import { IdbCoreStore, IdbFileStore } from "@offeru/core/idb";

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

  it("files: bytes + mime round trip, bare names only", async () => {
    const store = new IdbCoreStore({ name: fresh() });
    const files = new IdbFileStore(store);
    await files.write("../photo.png", new Uint8Array([1, 2, 3]));
    expect(await files.read("photo.png")).toEqual({ bytes: new Uint8Array([1, 2, 3]), type: "image/png" });
    expect(await files.read("a/b/photo.png")).toEqual({ bytes: new Uint8Array([1, 2, 3]), type: "image/png" });
    expect(await files.read("nope.png")).toBeNull();
    await expect(files.write("..", new Uint8Array())).rejects.toThrow();
    expect(await files.list()).toEqual(["photo.png"]);
    expect(JSON.stringify(await store.exportState())).not.toContain("photo.png");
  });

  it("upgrades a v1 database in place (adds files, keeps records)", async () => {
    const name = fresh();
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open(name, 1);
      open.onupgradeneeded = () => {
        const db = open.result;
        db.createObjectStore("records", { keyPath: "id" }).createIndex("type", "type");
        db.createObjectStore("tombstones", { keyPath: "id" });
        db.createObjectStore("changes", { keyPath: "id" });
        db.createObjectStore("meta");
        db.createObjectStore("settings");
      };
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction(["records", "meta"], "readwrite");
        tx.objectStore("records").put({ id: 3, type: "job", job_id: null, created_at: "t", updated_at: "t", rev: 1, data: { company: "V1" } });
        tx.objectStore("meta").put({ rev: 1, nextRecordId: 4, nextChangeId: 1, origin: "empty" }, "state");
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
    });
    const store = new IdbCoreStore({ name });
    expect((await store.get("job", 3))!.company).toBe("V1");
    await new IdbFileStore(store).write("x.txt", new Uint8Array([9]));
    expect((await new IdbFileStore(store).read("x.txt"))!.type).toContain("text/plain");
  });
});
