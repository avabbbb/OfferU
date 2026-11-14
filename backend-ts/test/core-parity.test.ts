// Contract tests: TS core save/get/list/search/overview against Python
// app/core/tools.py + store.py behaviour (expected values read from the
// Python source and backend/tests/test_core_tools.py).
import { afterEach, describe, expect, it } from "vitest";

import {
  checkStyle,
  jobUrlKey,
  mergeAutoTags,
  mergeSavedJob,
  nowIso,
  overview,
  saveRecord,
  todayIso,
} from "@offeru/core";

import { callTool } from "../src/tools";
import { SqliteCoreStore } from "../src/store";

let store: SqliteCoreStore | null = null;
afterEach(() => {
  store?.close();
  store = null;
});

function open(): SqliteCoreStore {
  store = new SqliteCoreStore(":memory:");
  return store;
}

const tool = (name: string, args: unknown, actor = "你"): Promise<any> => callTool(name, args, store!, actor);

describe("save validation (Python _check)", () => {
  it("rejects bad doc.style / questions / pending_asks with Python wording", async () => {
    open();
    await expect(tool("save", { type: "doc", data: { kind: "resume", style: { size: 3 } } })).rejects.toThrow("doc.style 没有 size；可用：template, font, bodySize, lineHeight, sectionGap, itemGap, margin, accent, photo, logo");
    await expect(tool("save", { type: "doc", data: { kind: "resume", style: { lineHeight: 3 } } })).rejects.toThrow("doc.style.lineHeight 要在 1.0–2.0 之间");
    await expect(tool("save", { type: "doc", data: { kind: "resume", style: { bodySize: 20 } } })).rejects.toThrow("doc.style.bodySize 要在 8–14 之间");
    await expect(tool("save", { type: "doc", data: { kind: "resume", style: { margin: { top: 1 } } } })).rejects.toThrow("doc.style.margin.top 要在 3–30 之间");
    await expect(tool("save", { type: "doc", data: { kind: "resume", style: { accent: "red" } } })).rejects.toThrow("#RRGGBB");
    await expect(tool("save", { type: "doc", data: { kind: "resume", style: { logo: "../x.png" } } })).rejects.toThrow("文件名");
    await expect(tool("save", { type: "doc", data: { kind: "resume", template: "fancy" } })).rejects.toThrow("doc.template 只能是 single, compact, photo");
    await expect(tool("save", { type: "doc", data: { kind: "review", questions: [{ q: "x" }] } })).rejects.toThrow("doc.questions[0] 只能有 question, answer, reflection, reaction");
    await expect(tool("save", { type: "doc", data: { kind: "review", questions: [{ question: 1 }] } })).rejects.toThrow("doc.questions[0] 的值要是字符串");
    await expect(tool("save", { type: "doc", data: { kind: "resume", pending_asks: [{}, {}, {}, {}] } })).rejects.toThrow("doc.pending_asks 要是数组，最多 3 项");
    expect(() => checkStyle({ template: "kami", font: "kai", margin: { top: 10, left: 3 }, photo: true, accent: "#112233" })).not.toThrow();
    const ok = await tool("save", { type: "doc", data: { kind: "review", questions: [{ question: "q", answer: "a" }], pending_asks: [{ old: "o", why: "w", question: "q" }] } });
    expect(ok.record.questions).toHaveLength(1);
  });

  it("checks job auto_tags / tags_muted and memory said_at / source / mode", async () => {
    open();
    await expect(tool("save", { type: "job", data: { title: "x", auto_tags: [" a"] } })).rejects.toThrow("job.tags 的每个标签");
    await expect(tool("save", { type: "job", data: { title: "x", tags_muted: [""] } })).rejects.toThrow("job.tags_muted 要是非空字符串数组，最多 100 个");
    await expect(tool("save", { type: "memory", data: { title: "x", said_at: "2026/1/1" } })).rejects.toThrow("memory.said_at 是 YYYY-MM-DD");
    await expect(tool("save", { type: "memory", data: { title: "x", source: "web" } })).rejects.toThrow("memory.source 只能是 user, resume, agent");
    await expect(tool("save", { type: "memory", data: { kind: "education", title: "x", mode: "实习" } })).rejects.toThrow("memory.mode 只能是 全日制/非全日制");
    await expect(tool("save", { type: "memory", data: { title: "x", mode: "随便" } })).rejects.toThrow("memory.mode 只能是 全职/实习/兼职/全日制/非全日制");
    await expect(tool("save", { type: "event", data: { title: "x", at: "2026-13-01" } })).rejects.toThrow("event.at");
    const event = await tool("save", { type: "event", data: { title: "x", at: "2026-11-30T14:00" } });
    expect(event.record.at).toBe("2026-11-30T14:00");
  });

  it("updating a missing id is not_found, not a 500", async () => {
    open();
    await expect(tool("save", { type: "job", id: 99, data: { title: "x" } })).rejects.toMatchObject({ code: "not_found", message: "job #99 不存在" });
  });
});

describe("job identity and merge (Python job_url_key / merge_saved_job)", () => {
  it("keys BOSS by job_detail id and XHS by note id", () => {
    expect(jobUrlKey("https://www.zhipin.com/job_detail/abc123~.html?lid=1&securityId=2")).toBe("boss:abc123~");
    expect(jobUrlKey("https://www.xiaohongshu.com/explore/65ab12?xsec_token=z")).toBe("xhs:65ab12");
    expect(jobUrlKey("https://www.example.com/jobs/1/?utm_source=x&b=2&a=1")).toBe("example.com/jobs/1?a=1&b=2");
  });

  it("re-saving the same posting with identical tags is a no-op", async () => {
    open();
    const first = await tool("save", { type: "job", data: { title: "后端", url: "https://www.zhipin.com/job_detail/x1.html?lid=1", tags: ["后端"] } });
    const again = await tool("save", { type: "job", data: { title: "后端", url: "https://zhipin.com/job_detail/x1.html?lid=9", tags: ["后端"] } });
    expect(again).toMatchObject({ existed: true, change_id: null });
    expect(again.record.id).toBe(first.record.id);
    expect(mergeSavedJob({ status: "applied", jd: "短" }, { status: "saved", jd: "更长的 JD", city: "北京" })).toEqual({ jd: "更长的 JD", city: "北京" });
  });

  it("merge_auto_tags keeps user tags and respects muted", () => {
    expect(mergeAutoTags({ tags: ["我的", "旧自动"], auto_tags: ["旧自动"], tags_muted: ["实习"] }, ["实习", "北京", "我的", "北京"]))
      .toEqual({ tags: ["我的", "北京"], auto_tags: ["北京"] });
    expect(mergeAutoTags(null, [])).toEqual({ tags: null, auto_tags: null });
  });
});

describe("memory provenance", () => {
  it("from_resume memories are source=resume, confirmed", async () => {
    const s = open();
    const saved = await saveRecord(s, { type: "memory", data: { title: "实习" } }, { actor: "agent", now: nowIso(), today: todayIso() }, { fromResume: true });
    expect(saved.record).toMatchObject({ source: "resume", confirmed: true });
  });
});

describe("list / search / overview", () => {
  it("brief drops resume and messages like Python _brief", async () => {
    open();
    await tool("save", { type: "doc", data: { kind: "note", title: "n", resume: { x: 1 }, messages: [1], body: "b".repeat(200) } });
    const listed = await tool("list", { type: "doc" });
    expect(listed.items[0].resume).toBeUndefined();
    expect(listed.items[0].messages).toBeUndefined();
    expect(listed.items[0].body).toHaveLength(161);
    const full = await tool("list", { type: "doc", full: true });
    expect(full.items[0].resume).toEqual({ x: 1 });
  });

  it("search with types=[] searches everything; blank query returns nothing", async () => {
    open();
    await tool("save", { type: "memory", data: { title: "字节实习" } });
    expect((await tool("search", { query: "字节", types: [] })).items).toHaveLength(1);
    expect((await tool("search", { query: "   " })).items).toEqual([]);
  });

  it("overview counts today's mail changes", async () => {
    const s = open();
    const job = await tool("save", { type: "job", data: { company: "A", title: "B" } });
    await tool("save", { type: "job", id: job.record.id, data: { status: "applied" } }, "邮箱");
    const view = await overview(s, { actor: "你", now: nowIso(), today: todayIso() });
    expect(view.mail.today_changes).toBe(1);
    expect(view.mail.last_change_at).toMatch(/^\d{4}-/);
  });
});
