import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { CONSENT_VERSION, DEFAULT_SCORING_SKILL, llmFactory, type SettingsHost } from "@offeru/core";

import { createApp } from "../src/app";
import { NodeMailService, type ImapOpener } from "../src/mail-node";
import { registerCompanionRoutes } from "../src/routes/companion";
import { registerEmailCompanion } from "../src/routes/companion/email";
import { createAppServer } from "../src/server";
import { nodeSettings } from "../src/settings-node";
import { SqliteCoreStore } from "../src/store";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

type Call = { url: string; init?: RequestInit };

/** Fake provider: /chat/completions answers from `replies` in order, /models lists two. */
function fakeProvider(replies: string[] = []) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    if (url.endsWith("/models")) {
      return new Response(JSON.stringify({ data: [{ id: "m-b", owned_by: "x" }, { id: "m-a", display_name: "A" }] }), { status: 200 });
    }
    if (url.endsWith("/audio/transcriptions")) return new Response(JSON.stringify({ text: " 你好 面试官 " }), { status: 200 });
    const body = JSON.parse(String(init?.body ?? "{}")) as { max_tokens?: number; max_completion_tokens?: number };
    const content = body.max_tokens === 5 ? "hi" : replies.shift() ?? "";
    return new Response(JSON.stringify({ model: "deepseek-v4-flash", choices: [{ message: { content } }] }), { status: 200 });
  };
  return { calls, fetch: fetchImpl };
}

function setup(replies: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "offeru-ic-"));
  const store = new SqliteCoreStore(":memory:");
  cleanups.push(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const provider = fakeProvider(replies);
  const settings: SettingsHost = { ...nodeSettings(dir, { fetch: provider.fetch as typeof fetch }), resolveHost: async () => ["93.184.216.34"] };
  const app = createApp({ store, runtime: "node", storage: "sqlite", settings, llm: llmFactory(settings) });
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await app.request(path, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as any };
  };
  return { dir, store, settings, provider, app, call };
}

const DEEPSEEK = {
  llm_api_configs: [{ provider_id: "deepseek", service_name: "DeepSeek", base_url: "https://api.deepseek.com", api_key: "sk-real-secret-123456", model: "deepseek-v4-flash", is_active: true }],
};

describe("/api/config (routes/config.py)", () => {
  it("masks keys, keeps them only in the 0600 data-dir file, and restores a masked echo", async () => {
    const { dir, call } = setup();
    const empty = await call("GET", "/api/config/");
    expect(empty.status).toBe(200);
    expect(empty.body).toMatchObject({ llm_api_configs: [], active_llm_config_id: "", vault_status: { available: true } });
    expect(empty.body.provider_presets.map((item: any) => item.id)).toEqual(["openai-compatible", "anthropic-compatible"]);

    const saved = await call("PUT", "/api/config/", DEEPSEEK);
    expect(saved.status).toBe(200);
    expect(saved.body.message).toBe("Config updated");
    const item = saved.body.config.llm_api_configs[0];
    expect(item.api_key).toBe("sk-r*************3456");
    expect(saved.body.config.deepseek_api_key).toBe("sk-r*************3456");
    expect(saved.body.config.active_llm_summary).toMatchObject({ provider_id: "deepseek", model: "deepseek-v4-flash", source: "active_config" });
    expect(JSON.stringify(saved.body)).not.toContain("sk-real-secret-123456");

    const file = join(dir, "llm-config.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).toContain("sk-real-secret-123456");

    // The page sends the masked key back with another change: the real key stays.
    const echoed = await call("PUT", "/api/config/", { llm_api_configs: [{ ...item, model: "deepseek-v4-pro" }], llm_timeout: 30 });
    expect(echoed.status).toBe(200);
    expect(JSON.parse(readFileSync(file, "utf8")).llm_api_configs[0]).toMatchObject({ api_key: "sk-real-secret-123456", model: "deepseek-v4-pro" });

    const invalid = await call("PUT", "/api/config/", { max_concurrent_agent_runs: 11 });
    expect(invalid.status).toBe(400);
  });

  it("test-llm: readable failure without a model, probe result with one", async () => {
    const { call, provider } = setup();
    expect((await call("POST", "/api/config/test-llm")).body).toEqual({
      success: false, provider: "", model: "", message: "还没有配置模型服务，请先在设置里添加一个。",
    });
    await call("PUT", "/api/config/", DEEPSEEK);
    const ok = await call("POST", "/api/config/test-llm");
    expect(ok.body).toEqual({ success: true, provider: "deepseek", model: "deepseek-v4-flash", message: "连接成功！模型 deepseek-v4-flash 可正常使用。" });
    expect(provider.calls.at(-1)!.url).toBe("https://api.deepseek.com/chat/completions");
    expect((provider.calls.at(-1)!.init!.headers as Record<string, string>).Authorization).toBe("Bearer sk-real-secret-123456");
  });

  it("fetch-models: SSRF guard, saved key for a masked echo, sorted list", async () => {
    const { call, provider } = setup();
    expect((await call("POST", "/api/config/fetch-models", { base_url: "http://127.0.0.1:11434/v1", api_key: "k" })).status).toBe(400);
    const saved = await call("PUT", "/api/config/", DEEPSEEK);
    const id = saved.body.config.llm_api_configs[0].id;
    const moved = await call("POST", "/api/config/fetch-models", { base_url: "https://other.example.com", api_key: "sk-r****", config_id: id });
    expect(moved).toMatchObject({ status: 400, body: { detail: "接口地址已更改，请重新填写密钥后获取模型。" } });
    const listed = await call("POST", "/api/config/fetch-models", { base_url: "https://api.deepseek.com/", api_key: "sk-r****", config_id: id });
    expect(listed.body).toEqual({
      success: true,
      models: [{ id: "m-a", name: "A", owned_by: "" }, { id: "m-b", name: "m-b", owned_by: "x" }],
      message: "获取到 2 个模型",
    });
    expect((provider.calls.at(-1)!.init!.headers as Record<string, string>).Authorization).toBe("Bearer sk-real-secret-123456");
    expect((await call("POST", "/api/config/fetch-models", { base_url: "https://x.example.com", api_key: "" })).body.detail).toBe("请填写 API Key 后获取模型。");
  });

  it("llm-providers/import fills the preset, activates, and returns the summary", async () => {
    const { call } = setup();
    const result = await call("POST", "/api/config/llm-providers/import", { provider_id: "deepseek", api_key: "sk-imported-abcdef", test: false });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      ok: true,
      errors: [],
      config: { provider_id: "deepseek", service_name: "DeepSeek", model: "deepseek-v4-flash", base_url: "https://api.deepseek.com", is_active: true },
      active_llm_summary: { provider_id: "deepseek", is_active: true },
      test_result: null,
    });
    expect(result.body.config.api_key).toBeUndefined();
    const bad = await call("POST", "/api/config/llm-providers/import", { api_key: "your-api-key" });
    expect(bad.body).toEqual({ ok: false, errors: ["API Key 不能为空，且不能是占位符。", "缺少 Base URL：请选择预设服务商或填写接口地址。", "缺少模型名称：请选择预设模型或填写模型名。"], config: null, test_result: null });
  });

  it("the stateless Worker has no settings: config is unsupported and no key can reach it", async () => {
    const store = new SqliteCoreStore(":memory:");
    cleanups.push(() => store.close());
    const worker = createApp({ store, runtime: "worker", storage: "none" });
    const response = await worker.request("/api/config/", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(DEEPSEEK) });
    expect(response.status).toBe(501);
    expect((await worker.request("/api/interviews/runtime")).status).toBe(501);
  });
});

describe("/api/consent and /api/connections", () => {
  it("platform-collect: status, stale version 409, agree, revoke", async () => {
    const { call, dir } = setup();
    expect((await call("GET", "/api/consent/platform-collect")).body).toMatchObject({ version: CONSENT_VERSION, agreed: false, agreed_version: null, agreed_at: null });
    expect((await call("POST", "/api/consent/platform-collect", { version: "2020-01-01" })).status).toBe(409);
    const agreed = await call("POST", "/api/consent/platform-collect", { version: CONSENT_VERSION });
    expect(agreed.body).toMatchObject({ agreed: true, agreed_version: CONSENT_VERSION });
    expect(agreed.body.agreed_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/);
    expect(JSON.parse(readFileSync(join(dir, "platform-consent.json"), "utf8")).version).toBe(CONSENT_VERSION);
    expect((await call("DELETE", "/api/consent/platform-collect")).body.agreed).toBe(false);
  });

  it("connections lists the two DB-backed sources like Python", async () => {
    const { call } = setup();
    expect((await call("GET", "/api/connections/")).body).toEqual({
      ok: true,
      connections: [
        { source_id: "manual", label: "Manual", description: "Jobs you add by hand / URL", experimental: false, status: "READY", connected: true, capabilities: ["job_discovery", "job_details"], last_sync: null },
        { source_id: "web", label: "Web", description: "Existing captured & scraped jobs", experimental: false, status: "READY", connected: true, capabilities: ["job_discovery", "job_details"], last_sync: null },
      ],
    });
  });
});

const QUESTIONS = JSON.stringify({ questions: [{ question: "讲一个你推动项目的例子", type: "behavioral", focus: "推动力", tips: "STAR" }] });
const EVALUATION = JSON.stringify({
  dimensions: Object.fromEntries(DEFAULT_SCORING_SKILL.dimensions.map((dimension) => [dimension.key, {
    score: 30, evidence: [], missing_evidence: true, not_applicable: false, strength: "", improvement: "补充可核对的结果",
  }])),
  strengths: [],
  improvements: ["补充数据"],
  suggestion: "说清楚你做了什么、结果如何",
});

describe("/api/interviews (routes/interviews.py) with the configured model", () => {
  it("runtime → create → answer → get → list → restart → delete", async () => {
    const { call } = setup([QUESTIONS, EVALUATION]);
    expect((await call("GET", "/api/interviews/runtime")).status).toBe(501);
    await call("PUT", "/api/config/", DEEPSEEK);
    const runtime = await call("GET", "/api/interviews/runtime");
    expect(runtime.body.runtime).toMatchObject({ provider: "deepseek", model: "deepseek-v4-flash", is_local: false, consent_policy: "explicit_cloud_consent" });

    const refused = await call("POST", "/api/interviews/", { model_provider: "deepseek", data_consent: false, consented_data_categories: ["interview_configuration", "interview_transcript"], question_count: 1 });
    expect(refused).toMatchObject({ status: 400, body: { detail: "云端模型必须取得本次面试数据发送同意" } });
    const created = await call("POST", "/api/interviews/", {
      title: "模拟一面", model_provider: "deepseek", data_consent: true, consented_data_categories: ["interview_configuration", "interview_transcript"], question_count: 1,
    });
    expect(created.status).toBe(200);
    const id = created.body.id;
    expect(created.body).toMatchObject({ title: "模拟一面", status: "active" });

    const answered = await call("POST", `/api/interviews/${id}/messages`, { question_index: 0, content: "我在实习里推动了一个上线项目", model_provider: "deepseek" });
    expect(answered.status).toBe(200);

    const detail = await call("GET", `/api/interviews/${id}?detail=summary`);
    expect(detail.status).toBe(200);
    expect(Array.isArray((await call("GET", "/api/interviews/?limit=5")).body)).toBe(true);
    expect((await call("GET", "/api/interviews/?limit=0")).status).toBe(400);
    expect((await call("GET", "/api/interviews/scoring-skills")).body.items[0].skill_id).toBe("evidence-interview-score");
    expect((await call("POST", "/api/interviews/debriefs", { calendar_event_id: 1, answers: ["x"] })).status).toBe(501);
    expect((await call("DELETE", `/api/interviews/${id}`, { reason: "练完了" })).body).toEqual({ success: true, interview_id: id, memory_invalidation: null });
    expect((await call("GET", `/api/interviews/${id}`)).status).toBe(404);
  });

  it("reviews CRUD and audio transcription through the provider", async () => {
    const { call, app, provider } = setup();
    const created = await call("POST", "/api/interviews/reviews", { company: "飞书", role: "产品", round_label: "一面", questions: [{ question: "自我介绍", answer: "", reflection: "", reaction: "" }] });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ company: "飞书", role: "产品", round_label: "一面", outcome: "pending" });
    const id = created.body.id;
    const updated = await call("PUT", `/api/interviews/reviews/${id}`, { company: "飞书", role: "产品", outcome: "passed" });
    expect(updated.body.outcome).toBe("passed");
    expect((await call("GET", "/api/interviews/reviews")).body.items).toHaveLength(1);

    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(16)], { type: "audio/webm" }), "a.webm");
    expect((await app.request("/api/interviews/reviews/transcribe", { method: "POST", body: form })).status).toBe(501);
    await call("PUT", "/api/config/", DEEPSEEK);
    const bad = new FormData();
    bad.append("file", new Blob([new Uint8Array(4)]), "a.exe");
    expect((await app.request("/api/interviews/reviews/transcribe", { method: "POST", body: bad })).status).toBe(400);
    const again = new FormData();
    again.append("file", new Blob([new Uint8Array(16)], { type: "audio/webm" }), "a.webm");
    const transcribed = await app.request("/api/interviews/reviews/transcribe", { method: "POST", body: again });
    expect(await transcribed.json()).toEqual({ transcript: "你好 面试官" });
    expect(provider.calls.at(-1)!.url).toBe("https://api.deepseek.com/audio/transcriptions");

    expect((await call("DELETE", `/api/interviews/reviews/${id}`)).body).toEqual({ deleted: id });
  });

  it("question bank: collect, list experiences, extract via model, list questions", async () => {
    const { call } = setup([JSON.stringify({ rounds: [], questions: [{ question_text: "介绍一个项目", round_type: "department", category: "project", difficulty: 3 }] })]);
    const collected = await call("POST", "/api/interview/collect", { company: "字节", role: "后端", raw_text: "一面问了项目和算法题，二面聊系统设计" });
    expect(collected.status).toBe(200);
    expect((await call("GET", "/api/interview/experiences")).body[0]).toMatchObject({ company: "字节", role: "后端", questions_count: 0, source_platform: "manual" });
    await call("PUT", "/api/config/", DEEPSEEK);
    const extracted = await call("POST", "/api/interview/extract", { experience_id: collected.body.id });
    expect(extracted.body).toMatchObject({ experience_id: collected.body.id, questions_count: 1 });
    expect((await call("GET", "/api/interview/questions?company=字节")).body[0]).toMatchObject({ question_text: "介绍一个项目", category: "project", frequency: 1 });
    expect((await call("POST", "/api/interview/extract", { experience_id: 999 })).status).toBe(404);
  });
});

describe("companion mailbox (IMAP) and diagnostics", () => {
  const RAW = "Message-ID: <m1@x>\r\nSubject: =?UTF-8?B?6Z2i6K+V6YKA6K+3?=\r\nFrom: hr@feishu.cn\r\nDate: Mon, 9 Nov 2026 10:00:00 +0800\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n飞书 产品实习 面试邀请：11月20日 14:00\r\n";

  function fakeImap(password = "app-pass"): { opener: ImapOpener; searches: string[] } {
    const searches: string[] = [];
    const opener: ImapOpener = async () => ({
      login: async (_user: string, pass: string) => { if (pass !== password) throw new (await import("../src/imap")).ImapError("LOGIN failed"); },
      examineInbox: async () => ({ uidvalidity: 7, uidnext: 3 }),
      uidSearch: async (criteria: string) => { searches.push(criteria); return criteria.startsWith("UID") ? [] : [2]; },
      fetchRaw: async () => new TextEncoder().encode(RAW),
      logout: async () => undefined,
    });
    return { opener, searches };
  }

  it("connects without echoing the password, stores it 0600, syncs and writes back", async () => {
    const { dir, store, app, call } = setup([JSON.stringify({ stage: "interview_1", company: "飞书", job_title: "产品实习", confidence: 0.9, interview_time: "2026-11-20T14:00", evidence_span: "面试邀请" })]);
    const { opener, searches } = fakeImap();
    registerEmailCompanion(app, new NodeMailService(dir, opener));
    await call("PUT", "/api/config/", DEEPSEEK);
    await app.request("/api/tools/save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "job", data: { company: "飞书", title: "产品实习", status: "applied" } }) });
    const post = (path: string, body: unknown) => app.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

    expect((await post("/api/email/imap-connect", { user: "me@qq.com", password: "wrong" })).status).toBe(400);
    const connected = await post("/api/email/imap-connect", { user: "me@qq.com", password: "app-pass" });
    const account = await connected.json() as any;
    expect(account).toMatchObject({ provider: "imap", email_address: "me@qq.com", host: "imap.qq.com", port: 993, status: "active", scopes: ["imap:read"] });
    expect(JSON.stringify(account)).not.toContain("app-pass");
    expect(statSync(join(dir, "mail-accounts.json")).mode & 0o777).toBe(0o600);

    const status = await (await app.request("/api/email/status")).json() as any;
    expect(status).toMatchObject({ connected: true, imap_connected: true, imap_host: "imap.qq.com", imap_user: "me@qq.com", gmail_connected: false });

    const synced = await (await post("/api/email/sync", {})).json() as any;
    expect(synced).toMatchObject({ accounts: 1, found: 1, new: 1, failed_accounts: 0 });
    expect(searches[0]).toMatch(/^SINCE \d\d-[A-Z][a-z]{2}-\d{4}$/);
    expect((await store.changes(10)).map((row) => row.actor)).toContain("邮箱");

    // Second sync is incremental from the saved UID cursor.
    await post("/api/email/sync", {});
    expect(searches[1]).toBe("UID 3:*");
    const runs = await (await app.request("/api/email/sync-runs?limit=5")).json() as any;
    expect(runs.items[0]).toMatchObject({ provider: "imap", status: "completed" });
    expect(JSON.stringify(runs)).not.toContain("app-pass");
  });

  it("runtime identity is loopback-only", async () => {
    const store = new SqliteCoreStore(":memory:");
    cleanups.push(() => store.close());
    const app = createApp({ store, runtime: "node", storage: "sqlite" });
    registerCompanionRoutes(app);
    expect((await app.request("/api/diagnostics/runtime-identity")).status).toBe(403);

    const server: Server = createAppServer(store, { settings: null });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    cleanups.push(() => server.close());
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const identity = await (await fetch(`http://127.0.0.1:${address.port}/api/diagnostics/runtime-identity`)).json() as any;
    expect(identity).toMatchObject({ version: "0.1.0", build_timestamp: null, source_fingerprint: null, build_source: "source" });
    expect(Object.keys(identity).sort()).toEqual(["build_source", "build_timestamp", "commit", "data_root", "dirty", "runtime_instance_id", "runtime_type", "source_fingerprint", "version"]);
  });
});
