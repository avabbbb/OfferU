// 投递包：按岗位改简历 → 导出 PDF → 带附件的投递邮件草稿，走 HTTP 工具面和内置 Agent 两条路，
// 最后回读数据库和文件，确认三样东西挂在同一个岗位上。

import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { saveRecord, type ChatRequest, type LlmClient, type LlmStreamEvent, type PageRenderer, type ParsedToolCall } from "@offeru/core";

import { SqliteAgentRunStore } from "../src/agent-store";
import { createApp, type AppDeps } from "../src/app";
import { exportResumePdf } from "../src/routes/companion/resume";
import { SqliteCoreStore } from "../src/store";

const ctx = { actor: "你", now: "2026-11-23T00:00:00+08:00", today: "2026-11-23" };
const TAILORED = "# 张三\n\n## 教育\n- 复旦大学 统计学 本科\n\n## 实习\n- 某公司 数据分析实习：用 SQL 搭周报看板\n";
const REVIEW = JSON.stringify({ edits: [], notes: { 关键词: "SQL" }, asks: [] });

type Turn = { text?: string; calls?: Array<{ name: string; args: Record<string, unknown> }> };

/** Agent turns are scripted (completeStream); tailor's draft / review calls go through chat(). */
function fakeModel(turns: Turn[] = []): LlmClient & { chats: number } {
  const model = {
    provider: "fake",
    model: "fake-1",
    chats: 0,
    async chat(_messages: unknown, options?: { json?: boolean }) {
      model.chats += 1;
      return options?.json ? REVIEW : TAILORED;
    },
    async *completeStream(_request: ChatRequest): AsyncIterable<LlmStreamEvent> {
      const turn = turns.shift() ?? { text: "好了" };
      if (turn.text) yield { type: "text_delta", text: turn.text };
      const toolCalls: ParsedToolCall[] = (turn.calls || []).map((call, index) => ({ id: `call_${turns.length}_${index}`, name: call.name, arguments: JSON.stringify(call.args), args: call.args }));
      yield { type: "done", result: { provider: "fake", model: "fake-1", content: turn.text || "", reasoning: "", toolCalls, finishReason: toolCalls.length ? "tool_calls" : "stop", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, estimated: false } } };
    },
  };
  return model as LlmClient & { chats: number };
}

const renderer: PageRenderer = {
  pdf: async () => new TextEncoder().encode("%PDF-1.4 fake"),
  png: async () => new Uint8Array([137, 80]),
  pageCount: async () => 1,
};

let stores: SqliteCoreStore[] = [];
afterEach(() => { for (const store of stores) store.close(); stores = []; });

async function seeded(): Promise<{ store: SqliteCoreStore; jobId: number; masterId: number }> {
  const store = new SqliteCoreStore(":memory:");
  stores.push(store);
  await saveRecord(store, { type: "profile", data: { name: "张三", school: "复旦大学", major: "统计学", email: "z@x.cn" } }, ctx);
  await saveRecord(store, { type: "memory", data: { kind: "experience", title: "数据分析实习", body: "用 SQL 搭周报看板" } }, ctx);
  const master = await saveRecord(store, { type: "doc", data: { kind: "resume", title: "主简历", body: "# 张三\n\n## 教育\n- 复旦大学 统计学 本科\n" } }, ctx);
  const job = await saveRecord(store, { type: "job", data: { title: "数据分析实习", company: "飞书", jd: "要求 SQL。投递邮箱 hr@feishu.cn，邮件标题：姓名-学校-岗位" } }, ctx);
  return { store, jobId: job.record.id, masterId: master.record.id };
}

function appFor(store: SqliteCoreStore, llm: LlmClient, withPdf = true) {
  const dir = mkdtempSync(join(tmpdir(), "offeru-exports-"));
  const deps: AppDeps = {
    store, runtime: "node", storage: "sqlite", agentRuns: new SqliteAgentRunStore(store), llm: () => llm, renderer,
    exportResumePdf: withPdf ? (docId, name) => exportResumePdf({ store, renderer }, dir, docId, name) : undefined,
  };
  const app = createApp(deps);
  const post = async (path: string, body: unknown) => {
    const response = await app.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  };
  return { post, dir };
}

describe("delivery pack over /api/tools", () => {
  it("tailor_resume → export_resume_pdf → draft_email: one job, a real attachment, ready=true", async () => {
    const { store, jobId, masterId } = await seeded();
    const { post } = appFor(store, fakeModel());

    const tailored = await post("/api/tools/tailor_resume", { job_id: jobId });
    expect(tailored.status).toBe(200);
    expect(tailored.body).toMatchObject({ job_id: jobId, base_id: masterId, change_id: expect.any(Number), pages: 1, asks: [] });
    const resumeId = tailored.body.doc_id as number;
    expect(resumeId).not.toBe(masterId);
    expect(await store.get("doc", resumeId)).toMatchObject({ kind: "resume", job_id: jobId, body: expect.stringContaining("周报看板") });
    expect((await store.get("doc", masterId))?.job_id ?? null).toBeNull(); // 主简历不动

    const pdf = await post("/api/tools/export_resume_pdf", { id: resumeId });
    expect(pdf.body).toMatchObject({ doc_id: resumeId, job_id: jobId });
    expect(readFileSync(pdf.body.path, "utf8")).toContain("%PDF");

    const mail = await post("/api/tools/draft_email", { job_id: jobId, resume_id: resumeId });
    expect(mail.body).toMatchObject({ to: "hr@feishu.cn", job_id: jobId, resume_id: resumeId, ready: true, missing: [], attach_error: null, subject: "张三-复旦大学-数据分析实习" });
    expect(mail.body.body).toContain("简历见附件");
    expect(existsSync(mail.body.attachment)).toBe(true);
    expect(await store.get("doc", mail.body.doc_id)).toMatchObject({ kind: "email", job_id: jobId, resume_id: resumeId, attachment: mail.body.attachment });
  });

  it("without a PDF exporter the draft does not claim an attachment and says what is missing", async () => {
    const { store, jobId } = await seeded();
    const { post } = appFor(store, fakeModel(), false);
    expect((await post("/api/tools/export_resume_pdf", { id: 1 })).status).toBe(404);
    const resumes = (await store.all("doc")).filter((doc) => doc.kind === "resume");
    expect((await post("/api/tools/export_resume_pdf", { id: resumes[0].id })).status).toBe(501);
    const mail = await post("/api/tools/draft_email", { job_id: jobId });
    expect(mail.body).toMatchObject({ attachment: null, ready: false, missing: [expect.stringMatching(/^附件：/)] });
    expect(mail.body.body).not.toContain("附件");
  });

  it("two tailor runs for different jobs from the same master resume both land", async () => {
    const { store, jobId } = await seeded();
    const other = await saveRecord(store, { type: "job", data: { title: "BI 实习", jd: "要求 SQL 和看板" } }, ctx);
    const { post } = appFor(store, fakeModel());
    const [a, b] = await Promise.all([post("/api/tools/tailor_resume", { job_id: jobId }), post("/api/tools/tailor_resume", { job_id: other.record.id })]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(new Set([a.body.job_id, b.body.job_id])).toEqual(new Set([jobId, other.record.id]));
  });
});

describe("delivery pack through the built-in Agent", () => {
  it("one sentence → tailored resume, PDF and email draft on the same job", async () => {
    const { store, jobId } = await seeded();
    const model = fakeModel([
      { calls: [{ name: "tailor_resume", args: { job_id: jobId } }] },
      { calls: [{ name: "draft_email", args: { job_id: jobId } }] },
      { text: "简历改好了，投递邮件草稿也写好了，附件已带上。" },
    ]);
    const { post } = appFor(store, model);
    const run = await post("/api/agent/runtime/runs", { message: "按这个岗位改简历并准备投递邮件" });
    expect(run.status).toBe(200);
    const docs = await store.all("doc", jobId);
    const resume = docs.find((doc) => doc.kind === "resume");
    const email = docs.find((doc) => doc.kind === "email");
    expect(resume).toBeTruthy();
    expect(email).toMatchObject({ resume_id: resume!.id });
    expect(email!.missing ?? null).toBeNull();
    expect(existsSync(String(email!.attachment))).toBe(true);
    const actors = (await store.changes(10)).map((row) => row.actor);
    expect(actors.filter((actor) => actor !== "你").length).toBeGreaterThanOrEqual(2);
  });
});

describe("tailor_resume optimistic check", () => {
  it("a JD edited while the model writes is not overwritten by a draft built on the old JD", async () => {
    const { store, jobId } = await seeded();
    const { runTailor } = await import("@offeru/core");
    const master = (await store.all("doc")).find((doc) => doc.kind === "resume")!;
    const events = [];
    for await (const event of runTailor({
      store,
      llm: fakeModel(),
      stream: async function* () {
        yield "# 张三\n\n";
        await saveRecord(store, { type: "job", id: jobId, data: { jd: "改成要 Python。投递邮箱 hr@feishu.cn" } }, ctx);
        yield "## 教育\n- 复旦大学\n";
      },
      deadlineMs: 5000,
    }, master.id, jobId)) events.push(event);
    expect(events.at(-1)).toMatchObject({ type: "error", conflict: true, draft: expect.stringContaining("复旦大学") });
    expect((await store.all("doc", jobId)).filter((doc) => doc.kind === "resume")).toHaveLength(0);
  });
});
