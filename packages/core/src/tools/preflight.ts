// Structured tool errors + preflight for the built-in Agent.
//
// The model used to read "ERROR: <message>" text. Now every failed call comes
// back as {ok:false, error:{code, message, retryable, suggestedAction}} so it
// can tell "fix the arguments", "look the id up first", "retry later" and
// "tell the user" apart. Preflight runs cheap store reads before a tool runs
// (does the job / record / change exist, is it the right kind) and answers
// with a fix suggestion instead of letting the tool fail half-way. JSON
// Schema validation stays where it was (callCoreTool → validateArgs).
//
// HTTP / MCP / CLI keep their existing error shapes; only the Agent binding
// uses this.

import { isCoreError, type CoreStore, type RecordType } from "../types";
import { sequenceRatio } from "./difflib";
import { validateArgs, type ToolSpec } from "./schema";

export type ToolErrorCode =
  | "invalid_args"
  | "invalid"
  | "not_found"
  | "conflict"
  | "forbidden"
  | "unsupported"
  | "unknown_tool"
  | "upstream_unavailable"
  | "aborted"
  | "internal";

export interface ToolError {
  code: ToolErrorCode;
  message: string;
  retryable: boolean;
  suggestedAction: string;
}

export interface ToolFailure {
  ok: false;
  error: ToolError;
}

const DEFAULT_ACTION: Record<ToolErrorCode, string> = {
  invalid_args: "按 tool_manual(names=[\"{tool}\"]) 里的参数说明改参数，再调一次。",
  invalid: "按报错改参数或数据再调一次；改不了就照实告诉用户缺什么。",
  not_found: "先用 search 或 list 找到正确的 id，再调一次；不要猜 id。",
  conflict: "先 get 最新记录看现状，再决定要不要改；不要重复写同一件事。",
  forbidden: "这一步只能由用户本人做：告诉用户在哪里操作，不要换个方式绕过。",
  unsupported: "这个运行环境做不了这一步：照实告诉用户，给出可行的替代做法。",
  unknown_tool: "用 tool_manual() 看可用工具。",
  upstream_unavailable: "外部服务暂时不可用：稍后重试一次；仍失败就照实告诉用户，已做的改动不要重复做。",
  aborted: "用户已中止这次运行，不要继续调用工具。",
  internal: "照实告诉用户这一步失败了和失败原因，不要假装完成。",
};

export function toolFailure(code: ToolErrorCode, message: string, options: { tool?: string; suggestedAction?: string; retryable?: boolean } = {}): ToolFailure {
  const action = options.suggestedAction ?? DEFAULT_ACTION[code].replace("{tool}", options.tool ?? "");
  return { ok: false, error: { code, message, retryable: options.retryable ?? code === "upstream_unavailable", suggestedAction: action } };
}

export function isToolFailure(value: unknown): value is ToolFailure {
  return Boolean(value) && typeof value === "object" && (value as ToolFailure).ok === false
    && typeof (value as ToolFailure).error?.code === "string";
}

const UPSTREAM = /\b(408|429|50[0-4])\b|timed? ?out|timeout|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|fetch failed|network|socket hang up|rate.?limit|overloaded|超时|限流|网络/i;

/** Map any thrown value from a tool to a structured failure. */
export function classifyToolError(cause: unknown, tool = ""): ToolFailure {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (cause instanceof Error && cause.name === "AbortError") return toolFailure("aborted", message || "已中止", { tool });
  if (isCoreError(cause)) {
    if (cause.code === "invalid" && /^参数 /.test(message)) return toolFailure("invalid_args", message, { tool });
    return toolFailure(cause.code, message, { tool });
  }
  if (UPSTREAM.test(message)) return toolFailure("upstream_unavailable", message, { tool });
  if (cause instanceof TypeError || cause instanceof RangeError) return toolFailure("invalid", message, { tool });
  return toolFailure("internal", message, { tool });
}

/** The closest tool name (difflib ratio, like Python get_close_matches cutoff 0.6). */
export function closestTool(name: string, names: readonly string[]): string | null {
  let best: string | null = null;
  let score = 0.6;
  for (const candidate of names) {
    const ratio = sequenceRatio(name, candidate);
    if (ratio > score) {
      best = candidate;
      score = ratio;
    }
  }
  return best;
}

export function unknownToolFailure(name: string, names: readonly string[]): ToolFailure {
  const near = closestTool(name, names);
  return toolFailure("unknown_tool", `没有工具 ${name}`, {
    suggestedAction: near ? `你是不是想用 ${near}？可用工具见 tool_manual()。` : DEFAULT_ACTION.unknown_tool,
  });
}

type Args = Record<string, unknown>;
const RECORD_TYPES: RecordType[] = ["profile", "memory", "job", "event", "doc"];
const isId = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value);

async function missingRecord(store: CoreStore, type: RecordType, id: number, tool: string, field: string): Promise<ToolFailure | null> {
  if (await store.get(type, id)) return null;
  const recent = [...await store.all(type)].sort((a, b) => b.id - a.id).slice(0, 5)
    .map((record) => `#${record.id} ${[record.company, record.title].filter(Boolean).join(" ").slice(0, 24)}`.trim());
  return toolFailure("not_found", `${field}=${id}：没有这条 ${type}`, {
    tool,
    suggestedAction: `先用 search 或 list(type="${type}") 找到正确的 id 再调 ${tool}。` + (recent.length ? `最近的 ${type}：${recent.join("；")}` : `现在还没有 ${type}。`),
  });
}

/**
 * Cheap checks before a tool runs. Returns a failure with a fix suggestion, or
 * null to go ahead. Schema validation happens first so the semantic checks
 * read well-typed args.
 */
export async function preflightTool(spec: ToolSpec, rawArgs: unknown, store: CoreStore): Promise<ToolFailure | null> {
  let args: Args;
  try {
    args = validateArgs(spec.inputSchema, rawArgs ?? {});
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return toolFailure("invalid_args", message, { tool: spec.name });
  }
  const name = spec.name;
  const type = RECORD_TYPES.includes(args.type as RecordType) ? args.type as RecordType : null;

  if ((name === "get" || name === "delete" || name === "save") && type && type !== "profile" && isId(args.id)) {
    const missing = await missingRecord(store, type, args.id, name, "id");
    if (missing) return missing;
  }
  if (name === "save" && type && (type === "event" || type === "doc")) {
    const data = (args.data ?? {}) as Args;
    if (isId(data.job_id)) {
      const missing = await missingRecord(store, "job", data.job_id, name, "data.job_id");
      if (missing) return missing;
    }
  }
  if ((name === "apply_answer" || name === "draft_email" || name === "tailor_resume") && isId(args.job_id)) {
    const missing = await missingRecord(store, "job", args.job_id, name, "job_id");
    if (missing) return missing;
  }
  if (name === "evaluate_jobs" && Array.isArray(args.ids)) {
    for (const id of args.ids) {
      if (!isId(id)) continue;
      const missing = await missingRecord(store, "job", id, name, "ids");
      if (missing) return missing;
    }
  }
  if ((name === "tailor_resume" || name === "export_resume_pdf") && isId(args.id)) {
    const doc = await store.get("doc", args.id);
    if (!doc) return missingRecord(store, "doc", args.id, name, "id");
    if (doc.kind !== "resume") {
      return toolFailure("invalid", `doc #${args.id} 是 ${String(doc.kind)}，不是简历`, {
        tool: name,
        suggestedAction: `传一份 kind=resume 的文档 id：先 list(type="doc", kind="resume") 找。`,
      });
    }
  }
  if (name === "draft_email" && isId(args.resume_id)) {
    const doc = await store.get("doc", args.resume_id);
    if (!doc || doc.kind !== "resume") return toolFailure("not_found", `resume_id=${args.resume_id} 不是一份简历`, { tool: name, suggestedAction: `不传 resume_id 用岗位的定制简历，或先 list(type="doc", kind="resume") 找。` });
  }
  if (name === "undo" && isId(args.change_id)) {
    const change = await store.getChange(args.change_id);
    if (!change) return toolFailure("not_found", `没有改动 #${args.change_id}`, { tool: name, suggestedAction: "先调 changes 看最近改动的 id。" });
    if (change.undone_at) return toolFailure("conflict", `改动 #${args.change_id} 已经撤销过了`, { tool: name, suggestedAction: "不用再撤销；调 changes 确认现状。" });
  }
  return null;
}
