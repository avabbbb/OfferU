// Contract tests for the shared tool surface (Python app/core/tools.py, main.py /api/tools,
// mcp_server.py, entry.py `offeru tool`): same tool list, same results, same guards.

import { execFile } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { enrichJobs, TOOL_SPECS, type LlmChatOptions, type LlmClient, type LlmMessage } from "@offeru/core";

import { createApp, type AppDeps } from "../src/app";
import { createMcpServer } from "../src/mcp";
import { createLocalFiles, fnmatchRegex } from "../src/routes/companion/files";
import { SqliteCoreStore } from "../src/store";
import { callTool, toolDeps } from "../src/tools";

const here = dirname(fileURLToPath(import.meta.url));
const PYTHON_TOOL_ORDER = [
  "overview", "search", "list", "get", "save", "delete", "undo", "changes", "read_file", "find_files", "web_search",
  "export_resume_pdf", "fetch_page", "email_sync", "tailor_resume", "split_resume", "add_job", "evaluate_jobs",
  "apply_answer", "draft_email", "reconcile_memory",
];

type Seen = { messages: LlmMessage[]; options?: LlmChatOptions };
function fakeLlm(reply: (messages: LlmMessage[]) => string | null, local = false, seen: Seen[] = []): LlmClient {
  return {
    local,
    async chat(messages, options) {
      seen.push({ messages, options });
      return reply(messages);
    },
  };
}

let store: SqliteCoreStore;
let tmp: string;
beforeEach(() => {
  store = new SqliteCoreStore(":memory:");
  tmp = mkdtempSync(join(tmpdir(), "offeru-tools-"));
});
afterEach(() => {
  store.close();
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.OFFERU_PDFTOTEXT;
});

function app(extra: Partial<AppDeps> = {}) {
  return createApp({ store, runtime: "node", storage: "sqlite", ...extra });
}

async function post(target: ReturnType<typeof app>, name: string, body: unknown, actor?: string) {
  const response = await target.request(`/api/tools/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(actor ? { "x-offeru-actor": encodeURIComponent(actor) } : {}) },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, any> };
}

describe("tool registry (Python TOOLS)", () => {
  it("GET /api/tools lists the 21 Python tools as {name, description, input}", async () => {
    const listed = await (await app().request("/api/tools")).json() as { tools: Array<{ name: string; description: string; input: Record<string, unknown> }> };
    expect(listed.tools.map((tool) => tool.name)).toEqual(PYTHON_TOOL_ORDER);
    for (const tool of listed.tools) {
      expect(Object.keys(tool)).toEqual(["name", "description", "input"]);
      expect(tool.input).toEqual(TOOL_SPECS.find((spec) => spec.name === tool.name)!.inputSchema);
    }
    // pydantic extra="forbid" → additionalProperties false; defaults and bounds carried over.
    const evaluate = listed.tools.find((tool) => tool.name === "evaluate_jobs")!.input as any;
    expect(evaluate.additionalProperties).toBe(false);
    expect(evaluate.properties.limit).toMatchObject({ default: 3, minimum: 1, maximum: 20 });
  });

  it("validates args like pydantic and rejects unknown tools", async () => {
    const target = app();
    expect((await post(target, "list", { type: "job", bogus: 1 })).status).toBe(400);
    expect((await post(target, "list", { type: "job", limit: 0 })).status).toBe(400);
    const unknown = await post(target, "nope", {});
    expect(unknown.status).toBe(400);
    expect(unknown.body.detail).toContain("没有工具 nope，可用：overview, search");
  });

  it("decodes a percent-encoded x-offeru-actor (Python unquote)", async () => {
    const target = app();
    await post(target, "save", { type: "memory", data: { kind: "skill", title: "SQL" } }, "小助手");
    const changes = await post(target, "changes", {});
    expect(changes.body.items[0].actor).toBe("小助手");
    const memory = (await post(target, "list", { type: "memory" })).body.items[0];
    expect(memory).toMatchObject({ source: "agent", confirmed: false });
  });
});

describe("read_file / find_files (companion) match Python", () => {
  const parity = JSON.parse(readFileSync(join(here, "fixtures/local-files-parity.json"), "utf8")) as {
    tree: Record<string, [string | null, number]>;
    cases: Array<{ tool: string; args: Record<string, unknown>; result: { ok?: any; error?: string } }>;
  };

  function buildTree(root: string) {
    for (const [rel, [text, mtime]] of Object.entries(parity.tree)) {
      const path = join(root, rel);
      mkdirSync(dirname(path), { recursive: true });
      if (text === null) copyFileSync(join(here, "fixtures/resume.docx"), path);
      else writeFileSync(path, text, "utf8");
      utimesSync(path, mtime, mtime);
    }
  }

  const swap = (value: unknown, from: string, to: string): any =>
    JSON.parse(JSON.stringify(value).split(from.replace(/\\/g, "\\\\")).join(to));
  const dropModified = (value: any): any => {
    if (Array.isArray(value)) return value.map(dropModified);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([k]) => k !== "modified").map(([k, v]) => [k, dropModified(v)]));
    return value;
  };

  it("same text, listing, filters, order and errors on the fixture tree", async () => {
    const root = join(tmp, "tree");
    buildTree(root);
    const target = app({ companion: (() => { const files = createLocalFiles(join(tmp, "files")); return { handlers: files.handlers, readFile: files.readFile }; })() });
    for (const item of parity.cases) {
      const { status, body } = await post(target, item.tool, swap(item.args, "<ROOT>", root), "agent");
      if (item.result.error) {
        expect(status, JSON.stringify(item.args)).toBe(400);
        expect(swap(body.detail, root, "<ROOT>")).toBe(item.result.error);
      } else {
        expect(status, JSON.stringify(item.args)).toBe(200);
        expect(dropModified(swap(body, root, "<ROOT>")), JSON.stringify(item.args)).toEqual(item.result.ok);
        for (const entry of body.items ?? []) expect(entry.modified).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
      }
    }
  });

  it("a bare file name reads from the data dir's files/ (uploads)", async () => {
    const files = createLocalFiles(join(tmp, "files"));
    mkdirSync(join(tmp, "files"), { recursive: true });
    writeFileSync(join(tmp, "files", "up.txt"), "上传的简历");
    expect(await files.readFile("some/where/up.txt")).toEqual({ path: join(tmp, "files", "up.txt"), text: "上传的简历", truncated: false });
  });

  it("PDF without pdftotext is a clear unsupported error", async () => {
    process.env.OFFERU_PDFTOTEXT = join(tmp, "no-such-binary");
    writeFileSync(join(tmp, "a.pdf"), "%PDF-1.4");
    await expect(createLocalFiles(tmp).readFile(join(tmp, "a.pdf"))).rejects.toMatchObject({ code: "unsupported" });
  });

  it("fnmatch translation", () => {
    expect(fnmatchRegex("*简历*").test("老简历.docx")).toBe(true);
    expect(fnmatchRegex("a?.[!x]d").test("ab.md")).toBe(true);
    expect(fnmatchRegex("a?.[!m]d").test("ab.md")).toBe(false);
    expect(fnmatchRegex("*.md").test("x.mdx")).toBe(false);
  });

  it("browser / Worker runtime has no local files: unsupported (501), not a crash", async () => {
    const worker = createApp({ store, runtime: "worker", storage: "none" });
    for (const [name, args] of [["read_file", { path: "/etc/hosts" }], ["find_files", { dir: "/" }]] as const) {
      const { status, body } = await post(worker, name, args);
      expect(status).toBe(501);
      expect(body).toMatchObject({ code: "unsupported", detail: expect.stringContaining("本机伴侣") });
    }
    // split_resume from a path needs the companion too; from text it does not.
    const split = await post(createApp({ store, runtime: "worker", storage: "none", llm: () => fakeLlm(() => "{\"items\": []}") }), "split_resume", { path: "/x/cv.docx" });
    expect(split).toMatchObject({ status: 501, body: { code: "unsupported" } });
  });
});

describe("split_resume (Python test_resume_split)", () => {
  const RAW = "张三 电话 13812345678 邮箱 zs@example.com\n腾讯 产品实习生 2025.06-2025.09 负责 3 个需求";
  const reply = (messages: LlmMessage[]) => JSON.stringify({
    items: [
      { kind: "experience", title: "腾讯 · 产品实习生", body: messages[1].content, start: "2025-06", end: "2025-09", mode: "实习" },
      { kind: "hobby", title: "摄影", body: "" },
      { kind: "project", title: "", body: "" },
      { kind: "education", title: "某大学", body: "x", mode: "实习" },
    ],
  });

  it("desensitizes for a remote model, restores, and saves source=resume confirmed=true even for an agent", async () => {
    const seen: Seen[] = [];
    const target = app({ llm: () => fakeLlm(reply, false, seen) });
    const { status, body } = await post(target, "split_resume", { text: RAW }, "Codex");
    expect(status).toBe(200);
    expect(body.count).toBe(3);
    expect(body.change_ids).toHaveLength(3);
    expect(body.items.map((item: any) => [item.kind, item.title])).toEqual([["experience", "腾讯 · 产品实习生"], ["note", "摄影"], ["education", "某大学"]]);

    const sent = seen[0].messages[1].content;
    expect(sent).not.toContain("13812345678");
    expect(sent).not.toContain("zs@example.com");
    expect(sent).toMatch(/\[__PII_PHONE_1_[0-9a-f]{8}__\]/);
    expect(seen[0].options).toMatchObject({ temperature: 0.1, json: true, maxTokens: 6000 });

    const memories = (await post(target, "list", { type: "memory", full: true })).body.items;
    const experience = memories.find((m: any) => m.kind === "experience");
    expect(experience.body).toContain("13812345678");
    expect(experience.body).toContain("zs@example.com");
    expect(experience).toMatchObject({ mode: "实习", start: "2025-06", end: "2025-09" });
    expect(memories.find((m: any) => m.kind === "education").mode).toBeUndefined(); // 实习 is not an education mode
    for (const memory of memories) expect(memory).toMatchObject({ source: "resume", confirmed: true });
    expect((await post(target, "changes", {})).body.items[0].actor).toBe("Codex");

    for (const changeId of [...body.change_ids].reverse()) expect((await post(target, "undo", { change_id: changeId })).status).toBe(200);
    expect((await post(target, "list", { type: "memory" })).body.total).toBe(0);
  });

  it("an agent still cannot confirm a memory through save", async () => {
    const { status, body } = await post(app(), "save", { type: "memory", data: { title: "x", confirmed: true } }, "Codex");
    expect(status).toBe(403);
    expect(body.detail).toBe("只有用户能确认记忆：Agent 存的记忆是待确认，请用户在档案页点「确认」");
    const forged = await post(app(), "save", { type: "memory", data: { title: "x", source: "user" } }, "Codex");
    expect(forged.status).toBe(403);
  });

  it("a local model gets the original text", async () => {
    const seen: Seen[] = [];
    await post(app({ llm: () => fakeLlm(reply, true, seen) }), "split_resume", { text: RAW });
    expect(seen[0].messages[1].content).toBe(RAW);
  });

  it("reads a path through the companion (docx)", async () => {
    copyFileSync(join(here, "fixtures/resume.docx"), join(tmp, "cv.docx"));
    const files = createLocalFiles(join(tmp, "files"));
    const seen: Seen[] = [];
    const target = app({ llm: () => fakeLlm(reply, false, seen), companion: { handlers: files.handlers, readFile: files.readFile } });
    const { status } = await post(target, "split_resume", { path: join(tmp, "cv.docx") });
    expect(status).toBe(200);
    expect(seen[0].messages[1].content).toContain("腾讯 · 产品实习生 2025.06-2025.09");
    expect(seen[0].messages[1].content).not.toContain("13812345678");
  });

  it("no model / no text / unusable output leave the profile untouched", async () => {
    expect(await post(app(), "split_resume", { text: "腾讯 实习" })).toMatchObject({ status: 501, body: { detail: expect.stringContaining("没配模型") } });
    expect(await post(app({ llm: () => fakeLlm(reply) }), "split_resume", { text: "  " })).toMatchObject({ status: 400, body: { detail: "要给简历原文 text 或文件 path" } });
    expect(await post(app({ llm: () => fakeLlm(() => "不是 JSON") }), "split_resume", { text: RAW })).toMatchObject({ status: 400, body: { detail: "模型没返回可用的条目，档案没动" } });
    expect(await post(app({ llm: () => fakeLlm(() => "{\"items\": [{\"kind\": \"skill\"}]}") }), "split_resume", { text: RAW })).toMatchObject({ status: 400, body: { detail: "没从原文里拆出经历，档案没动" } });
    expect((await post(app(), "list", { type: "memory" })).body.total).toBe(0);
  });
});

describe("evaluate_jobs / enrich_jobs tools", () => {
  const EVAL = JSON.stringify({ breakdown: { hard: 20, core: 20, evidence: 10, industry: 10, expression: 5 }, reasons: ["a", "b", "c"], greeting: "你好", markdown: "# 结论\nx" });
  // Python job_intake output is flat; keywords not found in the source text are dropped (增长).
  const INTAKE = JSON.stringify({ city: "北京", keywords: ["SQL", "增长"], hire_type: "实习", responsibilities: ["做分析"] });
  const route = (messages: LlmMessage[]) => (messages[0].content.startsWith("你是岗位信息整理助手") ? INTAKE : EVAL);

  it("evaluate_jobs splits the posting first, then writes score + evaluation doc (Python evaluate_stream)", async () => {
    const target = app({ llm: () => fakeLlm(route) });
    const job = (await post(target, "save", { type: "job", data: { company: "飞书", title: "数据分析实习", jd: "负责数据分析，要求 SQL" } })).body.record;
    const { status, body } = await post(target, "evaluate_jobs", { ids: [job.id] }, "Codex");
    expect(status).toBe(200);
    expect(body).toMatchObject({ count: 1, failed: [], remaining: 0, items: [{ id: job.id, score: 65, reasons: ["a", "b", "c"], greeting: "你好" }] });
    expect(body.change_ids).toHaveLength(3); // posting + evaluation doc + score
    const got = (await post(target, "get", { type: "job", id: job.id })).body;
    expect(got.record.posting).toMatchObject({ keywords: ["SQL"], hire_type: "实习", responsibilities: ["做分析"] });
    expect(got.record.city).toBe("北京");
    expect(got.docs.map((doc: any) => doc.kind)).toEqual(["evaluation"]);
  });

  it("chunks with limit and reports remaining; no model is an error before any write", async () => {
    const target = app({ llm: () => fakeLlm(route) });
    for (const title of ["A", "B", "C"]) await post(target, "save", { type: "job", data: { company: "X", title, jd: "JD", posting: { keywords: ["k"] } } });
    expect((await post(target, "evaluate_jobs", { limit: 2 })).body).toMatchObject({ count: 2, remaining: 1 });
    expect((await post(target, "evaluate_jobs", {})).body).toMatchObject({ count: 1, remaining: 0 });
    const none = await post(app(), "evaluate_jobs", {});
    expect(none.status).toBe(400);
    expect(none.body.detail).toContain("没配模型");
  });

  it("enrichJobs (evaluate's pre-step; not a registered tool, like Python) fills posting and only empty top-level fields", async () => {
    const target = app({ llm: () => fakeLlm(route) });
    const job = (await post(target, "save", { type: "job", data: { company: "飞书", title: "数据分析实习", city: "上海", jd: "要 SQL 和增长经验" } })).body.record;
    const body = await enrichJobs(toolDeps({ store, llm: () => fakeLlm(route) }, "你"), null) as any;
    expect(body).toMatchObject({ count: 1, failed: [], items: [{ id: job.id, keywords: ["SQL", "增长"] }] });
    const record = (await post(target, "get", { type: "job", id: job.id })).body.record;
    expect(record.city).toBe("上海");
    expect(record.status).toBe("saved");
    await expect(enrichJobs(toolDeps({ store }, "你"), null)).rejects.toThrow("没配模型，没法拆 JD");
    expect((await post(target, "enrich_jobs", {})).status).toBe(400); // Python TOOLS has no enrich_jobs
  });
});

describe("MCP and CLI surfaces", () => {
  it("MCP lists Python's tools/schemas and the client name is the actor", async () => {
    const server = createMcpServer({ store });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "Claude Code", version: "0.0.0" });
    await client.connect(clientTransport);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual(PYTHON_TOOL_ORDER);
      expect(listed.tools[3].inputSchema).toEqual(TOOL_SPECS[3].inputSchema);
      const saved = await client.callTool({ name: "save", arguments: { type: "memory", data: { title: "SQL" } } }) as any;
      expect(JSON.parse(saved.content[0].text).record).toMatchObject({ source: "agent", confirmed: false });
      expect((await callTool("changes", {}, store)) as any).toMatchObject({ items: [{ actor: "Claude Code" }] });
      const refused = await client.callTool({ name: "read_file", arguments: { path: "/etc/hosts" } }) as any;
      expect(refused.isError).toBe(true);
      expect(refused.content[0].text).toMatch(/^错误：/);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("`offeru-ts tool` lists tools, runs as agent by default and prints {error} on failure", async () => {
    const run = (args: string[], env: Record<string, string> = {}) => new Promise<{ code: number; out: string }>((done) => {
      execFile(process.execPath, ["--import", "tsx", join(here, "../src/cli.ts"), ...args], {
        cwd: join(here, ".."), env: { ...process.env, OFFERU_DATA_DIR: tmp, OFFERU_DB_PATH: join(tmp, "offeru.db"), ...env },
      }, (error, stdout) => done({ code: error ? Number(error.code) : 0, out: stdout }));
    });
    const [listed, saved, failed] = await Promise.all([
      run(["tool"]),
      run(["tool", "save", "\uFEFF{\"type\":\"memory\",\"data\":{\"title\":\"SQL\"}}"]),
      run(["tool", "get", "{\"type\":\"job\",\"id\":9}"]),
    ]);
    expect(listed.out.split("\n")[0]).toBe(`overview: ${TOOL_SPECS[0].description}`);
    expect(JSON.parse(saved.out).record).toMatchObject({ source: "agent", confirmed: false });
    expect(failed).toEqual({ code: 1, out: "{\"error\":\"job #9 不存在\"}\n" });
  }, 60_000);
});
