import { describe, expect, it } from "vitest";

import { saveRecord, saveRecordInTx } from "@offeru/core";

import { SqliteCoreStore } from "../src/store";

const ctx = { actor: "你", now: "2026-11-23T00:00:00+08:00", today: "2026-11-23" };

describe("SqliteCoreStore.transaction", () => {
  it("never nests: an inner transaction fails loudly instead of joining", async () => {
    const store = new SqliteCoreStore(":memory:");
    await expect(store.transaction(() => saveRecord(store, { type: "job", data: { title: "x" } }, ctx))).rejects.toThrow(/嵌套/);
    expect(await store.all("job")).toEqual([]);
  });

  it("composite writes use saveRecordInTx and commit together", async () => {
    const store = new SqliteCoreStore(":memory:");
    await store.transaction(async () => {
      await saveRecordInTx(store, { type: "job", data: { title: "a" } }, ctx);
      await saveRecordInTx(store, { type: "job", data: { title: "b" } }, ctx);
    });
    expect((await store.all("job")).length).toBe(2);
  });

  it("an independent caller queues and survives the other's rollback", async () => {
    const store = new SqliteCoreStore(":memory:");
    let release!: () => void;
    let entered!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    const inside = new Promise<void>((resolve) => { entered = resolve; });
    const a = store.transaction(async () => {
      await saveRecordInTx(store, { type: "job", data: { title: "A" } }, ctx);
      entered();
      await paused;
      throw new Error("A fails");
    });
    await inside;
    const b = saveRecord(store, { type: "job", data: { title: "B" } }, ctx);
    release();
    await expect(a).rejects.toThrow("A fails");
    await b;
    expect((await store.all("job")).map((job) => job.title)).toEqual(["B"]);
  });
});
