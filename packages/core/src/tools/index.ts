// The shared tool registry (Python backend/app/core/tools.py TOOLS + call).
// HTTP /api/tools and the CLI all list TOOL_SPECS and dispatch through
// callTool; a runtime adds what only it can do (local files, PDF export,
// ...) through `extra` handlers; mail IO comes in as ToolDeps.mail.

import {
  changesView,
  deleteRecord,
  getRecord,
  listRecords,
  overview,
  saveRecord,
  searchRecords,
  undoChange,
} from "../operations";
import { CoreError } from "../types";
import { applyAnswer, draftEmail, reconcileMemory, splitResume } from "./apply";
import { exportResumePdfTool, tailorResume } from "./resume";
import type { ToolDeps } from "./deps";
import { evaluateJobs } from "../research/evaluate";
import { addJob, enrichJobs } from "./jobs";
import { fetchPage, webSearch } from "./net";
import { exportData, importData } from "../data";
import { nowIso } from "../labels";
import { mailTool } from "../mail/tool";
import { validateArgs, type ToolSpec } from "./schema";
import { TOOL_SPECS } from "./specs";

/**
 * TS-only tools (no Python TOOLS counterpart): whole-store backup / restore.
 * `agent: false` keeps a tool off the Agent lists (restore replaces
 * every record, so only the user runs it, from settings / CLI / HTTP).
 */
export type ExtraToolSpec = ToolSpec & { agent: boolean };
export const TS_TOOL_SPECS: ExtraToolSpec[] = [
  {
    name: "export_data",
    description: "导出全部数据（档案、职业记忆、岗位、事项、文档和改动记录）为一个 JSON 备份，可用 import_data 原样恢复。",
    inputSchema: { additionalProperties: false, properties: {}, title: "ExportDataIn", type: "object" },
    agent: true,
  },
  {
    name: "import_data",
    description: "用 export_data 的备份替换全部数据（记录和改动 id 原样保留）。只能由用户本人操作。",
    inputSchema: {
      additionalProperties: false,
      properties: { snapshot: { description: "export_data 的完整输出", title: "Snapshot", type: "object" } },
      required: ["snapshot"],
      title: "ImportDataIn",
      type: "object",
    },
    agent: false,
  },
  {
    name: "mail",
    description: "用户自己的邮箱（只在桌面版，设置 › 邮箱 用授权码连上 QQ / 163 / Gmail 等）。action=list：收件箱最近 days 天（或上次返回的 cursor 之后）的邮件，返回 id、发件人、主题、时间、摘要，query 按发件人 / 主题 / 摘要筛；action=read：读一封（id），正文截到 6000 字，附带正文里的链接（笔试、面试链接）；action=draft：把邮件存进邮箱的草稿箱（不发送），doc_id 是 draft_email 写好的 email 文档，或者直接给 to / subject / body（可挂 job_id），resume_id 附简历 PDF，files 附本机文件；action=send：发出一份 email 文档（doc_id）——只有用户本人在界面上点「确认发送」才真的发，Agent 调用只会返回 status=needs_confirmation，什么都不发。list / read 只读。",
    inputSchema: {
      additionalProperties: false,
      properties: {
        action: { description: "list / read / draft / send", enum: ["list", "read", "draft", "send"], title: "Action", type: "string" },
        days: { default: 7, description: "list：看最近几天", maximum: 60, minimum: 1, title: "Days", type: "integer" },
        cursor: { anyOf: [{ type: "string" }, { type: "null" }], default: null, description: "list：上次返回的 cursor，只看之后的新邮件", title: "Cursor" },
        query: { anyOf: [{ type: "string" }, { type: "null" }], default: null, description: "list：关键词（发件人 / 主题 / 摘要），空格分开都要命中", title: "Query" },
        limit: { default: 20, description: "list：最多返回几封", maximum: 50, minimum: 1, title: "Limit", type: "integer" },
        id: { anyOf: [{ type: "string" }, { type: "null" }], default: null, description: "read：list 返回的邮件 id", title: "Id" },
        doc_id: { anyOf: [{ type: "integer" }, { type: "null" }], default: null, description: "draft / send：email 文档 id", title: "Doc Id" },
        to: { anyOf: [{ type: "string" }, { type: "null" }], default: null, description: "draft：收件人，多个用逗号分开", title: "To" },
        cc: { anyOf: [{ type: "string" }, { type: "null" }], default: null, description: "draft：抄送，多个用逗号分开", title: "Cc" },
        subject: { anyOf: [{ type: "string" }, { type: "null" }], default: null, description: "draft：标题", title: "Subject" },
        body: { anyOf: [{ type: "string" }, { type: "null" }], default: null, description: "draft：正文（纯文本）", title: "Body" },
        job_id: { anyOf: [{ type: "integer" }, { type: "null" }], default: null, description: "draft：新邮件挂到哪个岗位", title: "Job Id" },
        resume_id: { anyOf: [{ type: "integer" }, { type: "null" }], default: null, description: "draft：附哪份简历（导出 PDF）", title: "Resume Id" },
        files: { anyOf: [{ items: { type: "string" }, type: "array" }, { type: "null" }], default: null, description: "draft：附本机文件的绝对路径", title: "Files" },
      },
      required: ["action"],
      title: "MailIn",
      type: "object",
    },
    agent: true,
  },
];

/** The ported tools (TOOL_SPECS), then the TS-only ones: what HTTP /api/tools and the CLI list. */
export const ALL_TOOL_SPECS: ToolSpec[] = [...TOOL_SPECS, ...TS_TOOL_SPECS.map(({ agent: _agent, ...spec }) => spec)];
/** What agents (built-in Agent, external Agents via the CLI) see. */
export const AGENT_TOOL_SPECS: ToolSpec[] = [...TOOL_SPECS, ...TS_TOOL_SPECS.filter((spec) => spec.agent).map(({ agent: _agent, ...spec }) => spec)];

export type { ToolDeps } from "./deps";
export type { JsonSchema, ToolSpec } from "./schema";
export { validateArgs } from "./schema";
export * from "./catalog";
export * from "./preflight";
export { TOOL_INSTRUCTIONS, TOOL_SPECS } from "./specs";
export { cleanHtml, cleanText, guard as guardPosting, guardCounts, guardWarning, unescapeHtml } from "./posting-guard";
export type { GuardCounts, GuardFindings } from "./posting-guard";
export { createSearchClient, fetchPage, webSearch, NO_SEARCH, PASTE_ONLY_DOMAINS, RESTRICTED_DOMAINS } from "./net";
export type { FetchPageResult, HttpFetch, SearchClient, SearchKeys, SearchResult } from "./net";
export { autoTags, extractIntake, guessIntake, hireFromUrl, normalizeIntake, postingOf } from "./job-intake";
export { findViaApi, parseWant, splitName } from "./job-sources";
export { addJob, enrichJobs } from "./jobs";
export { APPLY_PROMPT, applyAnswer, attachmentName, draftEmail, mailSubject, reconcileMemory, splitResume } from "./apply";
export { reconcileScan } from "./reconcile";
export type { Finding } from "./reconcile";
export { extractResumeItems, normalizeSplitItem, SPLIT_PROMPT } from "./resume-split";
export { sequenceRatio } from "./difflib";

type Args = Record<string, unknown>;
export type ToolHandler = (args: Args, deps: ToolDeps) => Promise<unknown>;

const num = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined);

/** evaluate's best-effort pre-step: split job.posting for jobs that have none (Python enrich_jobs). */
export async function enrichChanges(deps: ToolDeps, jobIds: number[]): Promise<number[]> {
  const result = await enrichJobs(deps, jobIds);
  return (result.change_ids as number[]).filter(Boolean);
}

/** Tools whose whole implementation is runtime-agnostic and lives in core. */
export const CORE_HANDLERS: Record<string, ToolHandler> = {
  overview: (_, d) => overview(d.store, d.ctx),
  search: (a, d) => searchRecords(d.store, a),
  list: (a, d) => listRecords(d.store, a),
  get: (a, d) => getRecord(d.store, a),
  save: (a, d) => saveRecord(d.store, a, d.ctx),
  delete: (a, d) => deleteRecord(d.store, a, d.ctx),
  undo: (a, d) => undoChange(d.store, a, d.ctx),
  changes: (a, d) => changesView(d.store, num(a.limit) ?? 20),
  web_search: (a, d) => webSearch(d.search, String(a.query), num(a.limit) ?? 8),
  fetch_page: (a, d) => fetchPage(d.fetch, String(a.url)),
  split_resume: (a, d) => splitResume(d, a.text as string | null | undefined, a.path as string | null | undefined),
  add_job: (a, d) => addJob(d, String(a.text), a.source_url as string | null | undefined),
  evaluate_jobs: (a, d) => evaluateJobs(d.store, d.llm, a, {
    signal: d.signal,
    enrich: (bare) => enrichChanges(d, bare),
    context: () => d.ctx,
  }),
  apply_answer: (a, d) => applyAnswer(d, a.job_id as number, String(a.question)),
  draft_email: (a, d) => draftEmail(d, a.job_id as number, a.resume_id as number | null | undefined),
  tailor_resume: (a, d) => tailorResume(d, a),
  export_resume_pdf: (a, d) => exportResumePdfTool(d, a),
  reconcile_memory: (_, d) => reconcileMemory(d),
  export_data: (_, d) => exportData(d.store, nowIso()),
  import_data: (a, d) => importData(d.store, a.snapshot, d.ctx),
  mail: (a, d) => mailTool(a, d),
};

/** Who owns the tools core does not implement, for the "unsupported" message. */
const OWNER: Record<string, string> = {
  read_file: "本机伴侣（读本机文件）",
  find_files: "本机伴侣（读本机文件）",
};

export const TOOL_NAMES = ALL_TOOL_SPECS.map((spec) => spec.name);

export function toolSpec(name: string): ToolSpec | undefined {
  return ALL_TOOL_SPECS.find((spec) => spec.name === name);
}

/**
 * Validate args against the Python-identical schema, then run the tool.
 * Unknown name → invalid (Python: "没有工具 …"); a known tool this runtime
 * cannot run → unsupported.
 */
export async function callCoreTool(name: string, rawArgs: unknown, deps: ToolDeps, extra: Record<string, ToolHandler> = {}): Promise<unknown> {
  const spec = toolSpec(name);
  if (!spec) throw new CoreError(`没有工具 ${name}，可用：${TOOL_NAMES.join(", ")}`);
  const args = validateArgs(spec.inputSchema, rawArgs ?? {});
  const handler = extra[name] ?? CORE_HANDLERS[name];
  if (!handler) throw new CoreError(`这个运行环境不支持工具「${name}」，它属于${OWNER[name] ?? "其他模块"}`, "unsupported");
  return handler(args, deps);
}
