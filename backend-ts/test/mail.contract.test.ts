// The mail tool and 设置 › 邮箱 routes with an in-memory mailbox (no real IMAP / SMTP server):
// list / read shapes, draft → Drafts + email doc, the send gate (only the user sends), the
// read-only sandbox, credentials staying in the local file, and the web runtime answering 501.

import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AGENT_ACTOR,
  applySandbox,
  MAIL_READ_LIMIT,
  type AgentTool,
  type MailAccount,
  type MailClient,
  type MailDraftRef,
  type MailMessage,
  type MailSummary,
  type OutgoingMail,
} from "@offeru/core";

import { createApp, type AppDeps } from "../src/app";
import { nodeMail } from "../src/routes/companion/mail";
import type { MailTestResult } from "../src/routes/mail";
import { SqliteCoreStore } from "../src/store";
import { callTool, type ToolRuntime } from "../src/tools";

type Box = MailClient & {
  drafts: Array<{ mail: OutgoingMail; replace: MailDraftRef | null }>;
  sent: Array<{ mail: OutgoingMail; draft: MailDraftRef | null }>;
  lists: Array<{ sinceDays: number; cursor: string | null; max: number }>;
};

const INBOX: MailSummary[] = [
  { id: "12", from: "字节跳动招聘 <hr@bytedance.com>", subject: "【字节跳动】笔试邀请", date: "2026-11-25T02:00:00.000Z", preview: "请于 11 月 28 日前完成在线笔试", seen: false },
  { id: "11", from: "Moka <noreply@mokahr.com>", subject: "投递成功", date: "2026-11-24T02:00:00.000Z", preview: "你已成功投递 产品经理实习生", seen: true },
  { id: "10", from: "newsletter@example.com", subject: "Weekly", date: "2026-11-23T02:00:00.000Z", preview: "news", seen: true },
];

function fakeBox(message: Partial<MailMessage> = {}): Box {
  const box: Box = {
    address: "me@qq.com",
    drafts: [],
    sent: [],
    lists: [],
    async list(query) {
      box.lists.push(query);
      return { messages: INBOX.slice(0, query.max), cursor: "7:12" };
    },
    async read(id) {
      return { id, from: "hr@bytedance.com", to: ["me@qq.com"], cc: [], subject: "【字节跳动】笔试邀请", date: "2026-11-25T02:00:00.000Z", text: "", html: null, attachments: [], ...message };
    },
    async saveDraft(mail, replace) {
      box.drafts.push({ mail, replace });
      return { folder: "Drafts", message_id: `<draft-${box.drafts.length}@offeru>` };
    },
    async send(mail, draft) {
      box.sent.push({ mail, draft });
      return { message_id: "<sent-1@qq.com>", accepted: mail.to, rejected: [], draft_removed: Boolean(draft) };
    },
  };
  return box;
}

let store: SqliteCoreStore;
let tmp: string;
beforeEach(() => {
  store = new SqliteCoreStore(":memory:");
  tmp = mkdtempSync(join(tmpdir(), "offeru-mail-"));
});
afterEach(() => {
  store.close();
  rmSync(tmp, { recursive: true, force: true });
});

const runtime = (mail: ToolRuntime["mail"], extra: Partial<ToolRuntime> = {}): ToolRuntime => ({ store, mail, ...extra });
const mailCall = (rt: ToolRuntime, args: Record<string, unknown>, actor = "你") => callTool("mail", args, rt, actor) as Promise<Record<string, any>>;

async function job(data: Record<string, unknown> = {}) {
  return (await callTool("save", { type: "job", data: { company: "字节跳动", title: "产品经理实习生", jd: "简历投递至 hr@bytedance.com", ...data } }, store)) as { record: { id: number } };
}

describe("mail tool (fake mailbox)", () => {
  it("list passes days / cursor, filters by query and returns the next cursor", async () => {
    const box = fakeBox();
    const all = await mailCall(runtime(() => box), { action: "list", days: 3, limit: 2 });
    expect(all).toMatchObject({ account: "me@qq.com", count: 2, cursor: "7:12" });
    expect(all.messages.map((m: MailSummary) => m.id)).toEqual(["12", "11"]);
    expect(box.lists[0]).toEqual({ sinceDays: 3, cursor: null, max: 2 });

    const invites = await mailCall(runtime(() => box), { action: "list", query: "字节 笔试", cursor: "7:9" });
    expect(invites.messages.map((m: MailSummary) => m.id)).toEqual(["12"]);
    // a query searches a wider window than limit, then cuts to limit
    expect(box.lists[1]).toEqual({ sinceDays: 7, cursor: "7:9", max: 200 });
  });

  it("read truncates the body to 6000 chars and extracts links from html and text", async () => {
    const long = "笔试链接：https://exam.bytedance.com/t/abc123 。" + "说明".repeat(4000);
    const box = fakeBox({ text: long, html: '<a href="https://exam.bytedance.com/t/abc123">进入</a><a href="https://jobs.bytedance.com/faq?a=1&amp;b=2">FAQ</a>' });
    const out = await mailCall(runtime(() => box), { action: "read", id: "12" });
    expect(out.text).toHaveLength(MAIL_READ_LIMIT);
    expect(out.truncated).toBe(true);
    expect(out.links).toEqual(["https://exam.bytedance.com/t/abc123", "https://jobs.bytedance.com/faq?a=1&b=2"]);

    const htmlOnly = await mailCall(runtime(() => fakeBox({ html: "<style>p{}</style><p>面试时间：11 月 30 日 14:00</p><p>腾讯会议 https://meeting.tencent.com/dm/xyz</p>" })), { action: "read", id: "12" });
    expect(htmlOnly.text).toBe("面试时间：11 月 30 日 14:00\n腾讯会议 https://meeting.tencent.com/dm/xyz");
    expect(htmlOnly.links).toEqual(["https://meeting.tencent.com/dm/xyz"]);
  });

  it("draft appends to Drafts and saves an email doc; drafting it again replaces the old draft", async () => {
    const box = fakeBox();
    const { record } = await job();
    const exported: number[] = [];
    const rt = runtime(() => box, { exportResumePdf: async (id) => { exported.push(id); return { path: `/tmp/exports/简历-${id}.pdf` }; } });
    const resume = (await callTool("save", { type: "doc", data: { kind: "resume", title: "主简历", body: "# 王小明" } }, store)) as { record: { id: number } };
    const first = await mailCall(rt, { action: "draft", job_id: record.id, to: "hr@bytedance.com", subject: "王小明-产品经理实习生", body: "您好", resume_id: resume.record.id }, AGENT_ACTOR);
    expect(first).toMatchObject({ job_id: record.id, draft: { folder: "Drafts", message_id: "<draft-1@offeru>" }, to: ["hr@bytedance.com"], attachments: [`简历-${resume.record.id}.pdf`] });
    expect(box.drafts[0]).toEqual({
      mail: { to: ["hr@bytedance.com"], cc: [], subject: "王小明-产品经理实习生", text: "您好", attachments: [{ path: `/tmp/exports/简历-${resume.record.id}.pdf` }] },
      replace: null,
    });
    expect(exported).toEqual([resume.record.id]);
    const doc = (await callTool("get", { type: "doc", id: first.doc_id }, store)) as { record: Record<string, unknown> };
    expect(doc.record).toMatchObject({ kind: "email", job_id: record.id, draft: { folder: "Drafts", message_id: "<draft-1@offeru>" } });
    expect(doc.record.sent_at).toBeUndefined();

    await mailCall(rt, { action: "draft", doc_id: first.doc_id, subject: "王小明-北大-产品经理实习生" }, AGENT_ACTOR);
    expect(box.drafts[1].replace).toEqual({ folder: "Drafts", message_id: "<draft-1@offeru>" });
    expect(box.drafts[1].mail.subject).toBe("王小明-北大-产品经理实习生");
  });

  it("draft refuses a message the server would reject", async () => {
    const rt = runtime(() => fakeBox());
    await expect(mailCall(rt, { action: "draft", to: "not-an-address", subject: "x", body: "" })).rejects.toThrow("收件人地址不对");
    await expect(mailCall(rt, { action: "draft", to: "hr@bytedance.com", subject: " ", body: "" })).rejects.toThrow("没有标题");
  });

  it("without a mailbox: unsupported on the web runtime, not_configured on desktop before connecting", async () => {
    await expect(mailCall({ store }, { action: "list" })).rejects.toMatchObject({ code: "unsupported" });
    await expect(mailCall(runtime(() => null), { action: "list" })).rejects.toMatchObject({ code: "not_configured" });
  });
});

describe("send gate", () => {
  async function drafted(box: Box) {
    const { record } = await job();
    const out = await mailCall(runtime(() => box), { action: "draft", job_id: record.id, to: "hr@bytedance.com", subject: "王小明-产品经理实习生", body: "您好" }, AGENT_ACTOR);
    return { jobId: record.id, docId: out.doc_id as number };
  }

  it("an Agent (or any non-user caller) gets needs_confirmation: nothing is sent or written", async () => {
    const box = fakeBox();
    const { docId } = await drafted(box);
    const before = await store.changes(100);
    for (const actor of [AGENT_ACTOR, "agent", "Claude Code"]) {
      const out = await mailCall(runtime(() => box), { action: "send", doc_id: docId }, actor);
      expect(out).toMatchObject({ status: "needs_confirmation", sent: false, doc_id: docId, to: ["hr@bytedance.com"] });
    }
    expect(box.sent).toEqual([]);
    expect(await store.changes(100)).toHaveLength(before.length);
  });

  it("the user's 确认发送 sends once, removes the draft, marks the doc sent and moves the job to 已投递", async () => {
    const box = fakeBox();
    const { jobId, docId } = await drafted(box);
    const out = await mailCall(runtime(() => box), { action: "send", doc_id: docId });
    expect(out).toMatchObject({ status: "sent", sent: true, message_id: "<sent-1@qq.com>", draft_removed: true, job_status: "applied" });
    expect(box.sent).toEqual([{ mail: expect.objectContaining({ to: ["hr@bytedance.com"], subject: "王小明-产品经理实习生" }), draft: { folder: "Drafts", message_id: "<draft-1@offeru>" } }]);
    const doc = (await callTool("get", { type: "doc", id: docId }, store)) as { record: Record<string, unknown> };
    expect(doc.record).toMatchObject({ message_id: "<sent-1@qq.com>" });
    expect(doc.record.draft).toBeUndefined();
    expect(typeof doc.record.sent_at).toBe("string");
    const saved = (await callTool("get", { type: "job", id: jobId }, store)) as { record: Record<string, unknown> };
    expect(saved.record).toMatchObject({ status: "applied" });
    await expect(mailCall(runtime(() => box), { action: "send", doc_id: docId })).rejects.toMatchObject({ code: "conflict" });
    expect(box.sent).toHaveLength(1);
  });

  it("read-only sandbox lets list / read through and blocks draft / send", async () => {
    const calls: string[] = [];
    const tool: AgentTool = {
      name: "mail", description: "mail", parameters: {},
      async execute(args) { calls.push(String(args.action)); return { text: "{}", isError: false }; },
    };
    const [guarded] = applySandbox([tool], "read_only");
    for (const action of ["list", "read", "draft", "send"]) {
      const result = await guarded.execute({ action }, { callId: action });
      expect(result.isError, action).toBe(action === "draft" || action === "send");
    }
    expect(calls).toEqual(["list", "read"]);
  });
});

describe("设置 › 邮箱 over HTTP", () => {
  const ACCOUNT_FORM = { provider: "163", address: "me@163.com", password: "ABCD EFGH IJKL MNOP" };

  const allGood: MailTestResult = { ok: true, imap: { ok: true, error: null }, smtp: { ok: true, error: null } };
  function desktop(box: Box, verify = async (): Promise<MailTestResult> => allGood) {
    const connected: MailAccount[] = [];
    const mail = nodeMail(join(tmp, "offeru-mail.json"), (account) => { connected.push(account); return box; }, verify);
    return { app: createApp({ store, runtime: "node", storage: "sqlite", mail } satisfies AppDeps), connected };
  }

  async function call(app: ReturnType<typeof createApp>, method: string, path: string, body?: unknown, actor?: string) {
    const response = await app.request(path, {
      method,
      headers: { "Content-Type": "application/json", ...(actor ? { "x-offeru-actor": encodeURIComponent(actor) } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as Record<string, any> };
  }

  it("connect → read invites → draft → Agent send waits → user confirms → disconnect", async () => {
    const box = fakeBox();
    const { app, connected } = desktop(box);
    expect((await call(app, "GET", "/api/mail/status")).body).toMatchObject({ connected: false, account: null });

    const configured = await call(app, "POST", "/api/mail/configure", ACCOUNT_FORM);
    expect(configured.status).toBe(200);
    expect(configured.body.account).toEqual({ provider: "163", address: "me@163.com", imap: { host: "imap.163.com", port: 993, secure: true }, smtp: { host: "smtp.163.com", port: 465, secure: true } });
    expect(JSON.stringify(configured.body)).not.toContain("ABCD");
    // the 授权码 lives only in the 0600 file, spaces removed
    const file = join(tmp, "offeru-mail.json");
    expect(JSON.parse(readFileSync(file, "utf8")).password).toBe("ABCDEFGHIJKLMNOP");
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);

    const listed = await call(app, "POST", "/api/tools/mail", { action: "list", query: "笔试" }, AGENT_ACTOR);
    expect(listed.body.messages.map((m: MailSummary) => m.id)).toEqual(["12"]);
    expect(connected[0]).toMatchObject({ address: "me@163.com", password: "ABCDEFGHIJKLMNOP" });

    const { record } = await job();
    const draft = await call(app, "POST", "/api/tools/mail", { action: "draft", job_id: record.id, to: "hr@bytedance.com", subject: "王小明-产品经理实习生", body: "您好" }, AGENT_ACTOR);
    expect(draft.status).toBe(200);
    const pending = await call(app, "POST", "/api/tools/mail", { action: "send", doc_id: draft.body.doc_id }, AGENT_ACTOR);
    expect(pending.body.status).toBe("needs_confirmation");
    expect(box.sent).toHaveLength(0);
    const sent = await call(app, "POST", "/api/tools/mail", { action: "send", doc_id: draft.body.doc_id });
    expect(sent.body).toMatchObject({ status: "sent", job_status: "applied" });
    expect(box.sent).toHaveLength(1);

    // nothing about the account reaches the database or the change log
    const dump = JSON.stringify(await store.changes(1000)) + JSON.stringify(await store.all("doc"));
    expect(dump).not.toContain("ABCDEFGHIJKLMNOP");

    const cleared = await call(app, "POST", "/api/mail/configure", { clear: true });
    expect(cleared.body).toMatchObject({ connected: false, account: null });
    expect((await call(app, "POST", "/api/tools/mail", { action: "list" })).status).toBe(501);
  });

  it("a failed login is not saved and says which side failed", async () => {
    const { app } = desktop(fakeBox(), async () => ({ ok: false, imap: { ok: false, error: "IMAP 登录被拒：邮箱地址或授权码不对" }, smtp: { ok: true, error: null } }));
    const out = await call(app, "POST", "/api/mail/configure", ACCOUNT_FORM);
    expect(out).toMatchObject({ status: 400, body: { code: "invalid", detail: "IMAP 登录被拒：邮箱地址或授权码不对" } });
    expect((await call(app, "GET", "/api/mail/status")).body.connected).toBe(false);
    const tested = await call(app, "POST", "/api/mail/test", ACCOUNT_FORM);
    expect(tested.body).toMatchObject({ ok: false, imap: { ok: false }, smtp: { ok: true } });
  });

  it("the web runtime has no mailbox: routes answer 501 unsupported", async () => {
    const web = createApp({ store, runtime: "browser", storage: "indexeddb" });
    for (const [method, path] of [["GET", "/api/mail/status"], ["POST", "/api/mail/configure"], ["POST", "/api/mail/test"]] as const) {
      const out = await call(web, method, path, method === "POST" ? ACCOUNT_FORM : undefined);
      expect(out.status, path).toBe(501);
      expect(out.body.code).toBe("unsupported");
    }
    expect((await call(web, "POST", "/api/tools/mail", { action: "list" })).body.code).toBe("unsupported");
  });
});
