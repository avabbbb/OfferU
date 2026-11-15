import { afterEach, describe, expect, it } from "vitest";

import { callTool } from "../src/tools";
import { SqliteCoreStore } from "../src/store";

let store: SqliteCoreStore | null = null;

afterEach(() => {
  store?.close();
  store = null;
});

async function tool(name: string, args: unknown, actor = "你"): Promise<any> {
  if (!store) throw new Error("store not open");
  return callTool(name, args, store, actor);
}

describe("Node SQLite core adapter", () => {
  it("runs the shared save/overview/undo path", async () => {
    store = new SqliteCoreStore(":memory:");
    const profile = await tool("save", { type: "profile", data: { name: "林沐" } }) as { record: { id: number } };
    expect(profile.record.id).toBe(1);

    const job = await tool("save", { type: "job", data: { company: "字节跳动", title: "后端实习" } }) as {
      record: { id: number; status: string; applied_at?: string };
      change_id: number;
    };
    expect(job.record.status).toBe("saved");

    const applied = await tool("save", { type: "job", id: job.record.id, data: { status: "applied" } }) as {
      record: { status: string; applied_at: string };
      change_id: number;
    };
    expect(applied.record.status).toBe("applied");
    expect(applied.record.applied_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    await tool("undo", { change_id: applied.change_id });
    const recovered = await tool("get", { type: "job", id: job.record.id }) as { record: { status: string; applied_at?: string } };
    expect(recovered.record.status).toBe("saved");
    expect(recovered.record.applied_at).toBeUndefined();

    const view = await tool("overview", {}) as { jobs: { applied: number }; next_step: { title: string } };
    expect(view.jobs.applied).toBe(0);
  });

  it("does not move a duplicate URL back to saved", async () => {
    store = new SqliteCoreStore(":memory:");
    const first = await tool("save", {
      type: "job",
      data: { company: "示例", title: "后端", url: "https://example.test/jobs/1?utm_source=x" },
    }) as { record: { id: number } };
    await tool("save", { type: "job", id: first.record.id, data: { status: "applied" } });
    const again = await tool("save", {
      type: "job",
      data: { url: "https://example.test/jobs/1", city: "杭州", status: "saved" },
    }) as { record: { id: number; status: string; city: string }; existed: boolean };
    expect(again.existed).toBe(true);
    expect(again.record.id).toBe(first.record.id);
    expect(again.record.status).toBe("applied");
    expect(again.record.city).toBe("杭州");
  });

  it("keeps agent writes behind user-only guards", async () => {
    store = new SqliteCoreStore(":memory:");
    const job = await tool("save", { type: "job", data: { company: "示例", title: "后端", status: "offer" } }, "你") as { record: { id: number } };
    await expect(tool("save", { type: "job", id: job.record.id, data: { status: "saved" } }, "Agent")).rejects.toThrow(/只有用户/);
    await expect(tool("save", { type: "memory", data: { kind: "skill", title: "x", confirmed: true } }, "Agent")).rejects.toThrow(/只有用户/);
  });

  it("rolls back the record when the change log write fails", async () => {
    store = new SqliteCoreStore(":memory:");
    const original = store.addChange.bind(store);
    store.addChange = async () => { throw new Error("disk full"); };
    await expect(tool("save", { type: "job", data: { company: "原子", title: "事务" } })).rejects.toThrow("disk full");
    store.addChange = original;
    expect(await store.all("job")).toEqual([]);
  });

  it("serializes concurrent writes without interleaving transactions", async () => {
    store = new SqliteCoreStore(":memory:");
    await Promise.all(Array.from({ length: 20 }, (_, i) => tool("save", { type: "job", data: { company: `公司${i}`, title: "并发" } })));
    expect((await store.all("job")).length).toBe(20);
    expect((await store.changes(100)).length).toBe(20);
  });

  it("tags errors with machine-readable codes", async () => {
    store = new SqliteCoreStore(":memory:");
    await expect(tool("get", { type: "job", id: 99 })).rejects.toMatchObject({ code: "not_found" });
    await expect(tool("save", { type: "job", data: { status: "maybe" } })).rejects.toMatchObject({ code: "invalid" });
  });
});
