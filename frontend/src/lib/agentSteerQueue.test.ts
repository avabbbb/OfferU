import { describe, expect, it } from "vitest";
import {
  QUEUE_MAX_ITEMS, QUEUE_STORAGE_KEY, composerKeyIntent, enqueue, enqueueFront, loadQueue, nextArmed, queuedFor,
  rebindConversation, removeQueued, saveQueue,
} from "./agentSteerQueue";

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  };
}

describe("composerKeyIntent", () => {
  const idle = { busy: false, hasText: true };
  const busy = { busy: true, hasText: true };
  it("Enter sends when idle and steers while a run is going", () => {
    expect(composerKeyIntent({ key: "Enter" }, idle)).toBe("send");
    expect(composerKeyIntent({ key: "Enter" }, busy)).toBe("steer");
    expect(composerKeyIntent({ key: "Enter", shiftKey: true }, busy)).toBeNull();
    expect(composerKeyIntent({ key: "Enter", isComposing: true }, busy)).toBeNull();
  });
  it("Tab queues only while busy with text (otherwise keeps normal focus behaviour)", () => {
    expect(composerKeyIntent({ key: "Tab" }, busy)).toBe("queue");
    expect(composerKeyIntent({ key: "Tab" }, idle)).toBeNull();
    expect(composerKeyIntent({ key: "Tab" }, { busy: true, hasText: false })).toBeNull();
    expect(composerKeyIntent({ key: "Tab", shiftKey: true }, busy)).toBeNull();
    expect(composerKeyIntent({ key: "Tab", ctrlKey: true }, busy)).toBeNull();
  });
});

describe("queue operations", () => {
  it("enqueues in order, trims, drops empty, caps length", () => {
    let items = enqueue([], "  第一条 ", "c1", 1);
    items = enqueue(items, "   ", "c1", 2);
    items = enqueue(items, "第二条", "c1", 3);
    expect(items.map((item) => item.text)).toEqual(["第一条", "第二条"]);
    expect(items.every((item) => item.armed)).toBe(true);
    let many = items;
    for (let i = 0; i < QUEUE_MAX_ITEMS + 5; i += 1) many = enqueue(many, `m${i}`, "c1", i);
    expect(many).toHaveLength(QUEUE_MAX_ITEMS);
    expect(many.at(-1)?.text).toBe(`m${QUEUE_MAX_ITEMS + 4}`);
  });
  it("puts a failed steer back at the front", () => {
    const items = enqueue([], "后面的", "c1", 1);
    expect(enqueueFront(items, "没送到的插话", "c1", 2).map((item) => item.text)).toEqual(["没送到的插话", "后面的"]);
  });
  it("scopes to the conversation and picks the next armed one", () => {
    let items = enqueue([], "别的对话", "c2", 1);
    items = enqueue(items, "这个对话", "c1", 2);
    expect(queuedFor(items, "c1").map((item) => item.text)).toEqual(["这个对话"]);
    expect(nextArmed(items, "c1")?.text).toBe("这个对话");
    expect(nextArmed(items, "c3")).toBeNull();
    expect(removeQueued(items, items[0].id).map((item) => item.text)).toEqual(["这个对话"]);
  });
  it("rebinds new-conversation items once the conversation is saved", () => {
    const items = enqueue(enqueue([], "新对话里排的", null, 1), "别处", "c9", 2);
    const rebound = rebindConversation(items, null, "c1");
    expect(queuedFor(rebound, "c1").map((item) => item.text)).toEqual(["新对话里排的"]);
    expect(queuedFor(rebound, "c9")).toHaveLength(1);
  });
});

describe("persistence", () => {
  it("round-trips through storage, but restored items are not armed", () => {
    const storage = memoryStorage();
    const items = enqueue(enqueue([], "一", "c1", 1), "二", null, 2);
    saveQueue(storage, items);
    expect(storage.data.get(QUEUE_STORAGE_KEY)).not.toContain("armed");
    const restored = loadQueue(storage);
    expect(restored.map((item) => [item.text, item.conversationId, item.armed])).toEqual([["一", "c1", false], ["二", null, false]]);
    expect(nextArmed(restored, "c1")).toBeNull();
    saveQueue(storage, []);
    expect(storage.data.has(QUEUE_STORAGE_KEY)).toBe(false);
  });
  it("survives junk and missing storage", () => {
    const storage = memoryStorage();
    storage.setItem(QUEUE_STORAGE_KEY, "{not json");
    expect(loadQueue(storage)).toEqual([]);
    storage.setItem(QUEUE_STORAGE_KEY, JSON.stringify([{ id: 1, text: "x" }, { id: "ok", text: " 好 " }, null, { id: "e", text: "" }]));
    expect(loadQueue(storage).map((item) => item.text)).toEqual(["好"]);
    expect(loadQueue(null)).toEqual([]);
    expect(() => saveQueue({ getItem: () => null, setItem: () => { throw new Error("quota"); }, removeItem: () => {} }, enqueue([], "x", null))).not.toThrow();
  });
});
