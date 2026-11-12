import { afterEach, describe, expect, it } from "vitest";

import { callTool } from "../src/tools";
import { SqliteCoreStore } from "../src/store";

let store: SqliteCoreStore | null = null;

afterEach(() => {
  store?.close();
  store = null;
});

function tool(name: string, args: unknown, actor = "你") {
  if (!store) throw new Error("store not open");
  return callTool(name, args, store, actor);
}

describe("Node SQLite core adapter", () => {
  it("runs the shared save/overview/undo path", () => {
    store = new SqliteCoreStore(":memory:");
    const profile = tool("save", { type: "profile", data: { name: "林沐" } }) as { record: { id: number } };
    expect(profile.record.id).toBe(1);

    const job = tool("save", { type: "job", data: { company: "字节跳动", title: "后端实习" } }) as {
      record: { id: number; status: string; applied_at?: string };
      change_id: number;
    };
    expect(job.record.status).toBe("saved");

    const applied = tool("save", { type: "job", id: job.record.id, data: { status: "applied" } }) as {
      record: { status: string; applied_at: string };
      change_id: number;
    };
    expect(applied.record.status).toBe("applied");
    expect(applied.record.applied_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    tool("undo", { change_id: applied.change_id });
    const recovered = tool("get", { type: "job", id: job.record.id }) as { record: { status: string; applied_at?: string } };
    expect(recovered.record.status).toBe("saved");
    expect(recovered.record.applied_at).toBeUndefined();

    const view = tool("overview", {}) as { jobs: { applied: number }; next_step: { title: string } };
    expect(view.jobs.applied).toBe(0);
  });

  it("does not move a duplicate URL back to saved", () => {
    store = new SqliteCoreStore(":memory:");
    const first = tool("save", {
      type: "job",
      data: { company: "示例", title: "后端", url: "https://example.test/jobs/1?utm_source=x" },
    }) as { record: { id: number } };
    tool("save", { type: "job", id: first.record.id, data: { status: "applied" } });
    const again = tool("save", {
      type: "job",
      data: { url: "https://example.test/jobs/1", city: "杭州", status: "saved" },
    }) as { record: { id: number; status: string; city: string }; existed: boolean };
    expect(again.existed).toBe(true);
    expect(again.record.id).toBe(first.record.id);
    expect(again.record.status).toBe("applied");
    expect(again.record.city).toBe("杭州");
  });

  it("keeps agent writes behind user-only guards", () => {
    store = new SqliteCoreStore(":memory:");
    const job = tool("save", { type: "job", data: { company: "示例", title: "后端", status: "offer" } }, "你") as { record: { id: number } };
    expect(() => tool("save", { type: "job", id: job.record.id, data: { status: "saved" } }, "Agent")).toThrow(/只有用户/);
    expect(() => tool("save", { type: "memory", data: { kind: "skill", title: "x", confirmed: true } }, "Agent")).toThrow(/只有用户/);
  });
});
