// The shared tool registry (Python backend/app/core/tools.py TOOLS + call).
// HTTP /api/tools, MCP and the CLI all list TOOL_SPECS and dispatch through
// callTool; a runtime adds what only it can do (local files, PDF export,
// mail sync) through `extra` handlers.

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
import type { ToolDeps } from "./deps";
import { evaluateJobs } from "../research/evaluate";
import { addJob, enrichJobs } from "./jobs";
import { fetchPage, webSearch } from "./net";
import { validateArgs, type ToolSpec } from "./schema";
import { TOOL_SPECS } from "./specs";

export type { ToolDeps } from "./deps";
export type { JsonSchema, ToolSpec } from "./schema";
export { validateArgs } from "./schema";
export { MCP_INSTRUCTIONS, TOOL_SPECS } from "./specs";
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
  add_job: (a, d) => addJob(d, String(a.text)),
  evaluate_jobs: (a, d) => evaluateJobs(d.store, d.llm, a, {
    signal: d.signal,
    enrich: (bare) => enrichChanges(d, bare),
    context: () => d.ctx,
  }),
  apply_answer: (a, d) => applyAnswer(d, a.job_id as number, String(a.question)),
  draft_email: (a, d) => draftEmail(d, a.job_id as number, a.resume_id as number | null | undefined),
  reconcile_memory: (_, d) => reconcileMemory(d),
};

/** Who owns the tools core does not implement, for the "unsupported" message. */
const OWNER: Record<string, string> = {
  read_file: "本机伴侣（读本机文件）",
  find_files: "本机伴侣（读本机文件）",
  export_resume_pdf: "简历模块（PDF 导出）",
  tailor_resume: "简历模块（按岗位改写）",
  email_sync: "邮箱模块",
};

export const TOOL_NAMES = TOOL_SPECS.map((spec) => spec.name);

export function toolSpec(name: string): ToolSpec | undefined {
  return TOOL_SPECS.find((spec) => spec.name === name);
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
