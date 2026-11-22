import { describe, expect, it, vi } from "vitest";

vi.mock("localforage", () => {
  const instance = () => {
    const items = new Map<string, unknown>();
    return {
      getItem: async (key: string) => (items.has(key) ? JSON.parse(JSON.stringify(items.get(key))) : null),
      setItem: async (key: string, value: unknown) => { items.set(key, JSON.parse(JSON.stringify(value))); return value; },
    };
  };
  return { default: { createInstance: instance } };
});

import { BrowserDemoStore } from "./store";
import type { DemoState } from "./seed";

const empty = (): DemoState => ({ version: 1, records: [], changes: [], nextRecordId: 1, nextChangeId: 1 } as unknown as DemoState);
const now = "2026-11-23T00:00:00+08:00";

describe("BrowserDemoStore.transaction", () => {
  it("an independent write that arrives while another transaction awaits is not lost in its rollback", async () => {
    const store = new BrowserDemoStore(empty, "tx-isolation");
    await store.ready();
    let release!: () => void;
    let entered!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    const inside = new Promise<void>((resolve) => { entered = resolve; });
    const a = store.transaction(async () => {
      await store.put("job", { title: "A" }, { now });
      entered();
      await paused;
      throw new Error("A fails");
    });
    await inside; // A is open and awaiting: B is a separate request, not a nested call
    const b = store.transaction(async () => store.put("job", { title: "B" }, { now }));
    release();
    await expect(a).rejects.toThrow("A fails");
    const created = await b;
    expect(await store.get("job", created.id)).toMatchObject({ title: "B" });
    expect((await store.all("job")).map((job) => job.title)).toEqual(["B"]);
  });
});
