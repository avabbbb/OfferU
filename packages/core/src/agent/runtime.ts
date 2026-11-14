// Assemble an AgentHost from plain dependencies — the one entry point for
// every runtime: the Node companion (SQLite rows), the browser (IndexedDB
// rows, user's own key) and tests (memory rows, fake LLM). Port of
// backend/app/core/agent.py (loop_tools / execute / system_prompt) wired the
// way services/embedded_agent_host.py wires it.
//
// Agent writes go through the same core operations as the user's, with
// actor = AGENT_ACTOR, so the user-only guards apply (the Agent cannot
// confirm a memory or move a job status backwards) and every write lands in
// the change log, undoable.

import { nowIso, todayIso } from "../labels";
import type { LlmClient, ToolSpec } from "../llm";
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
import { CoreError, type CoreContext, type CoreStore, type Json } from "../types";
import { AgentHost, type PreparedAttachments, type ResolvedLlm, type RunOptions } from "./host";
import type { AgentTool } from "./loop";
import { AGENT_ACTOR, agentSystemPrompt, type MemoryArm } from "./prompt";
import { AgentConversations, AgentRunState, type AgentRunStore } from "./run-state";
import { coreToolSpecs } from "./tool-specs";
import { bindAgentTools } from "./tools";

/** Record tools every runtime has (core/tools.py TOOLS that need no network / files / model). */
export const AGENT_RECORD_TOOLS = ["overview", "search", "list", "get", "save", "delete", "undo", "changes"] as const;

export function agentContext(actor = AGENT_ACTOR): CoreContext {
  return { actor, now: nowIso(), today: todayIso() };
}

/** tools.call for the record tools; unknown names are "unsupported". */
export async function callRecordTool(store: CoreStore, name: string, args: Json, ctx: CoreContext): Promise<unknown> {
  switch (name) {
    case "overview": return overview(store, ctx);
    case "search": return searchRecords(store, args);
    case "list": return listRecords(store, args);
    case "get": return getRecord(store, args);
    case "save": return saveRecord(store, args, ctx);
    case "delete": return deleteRecord(store, args, ctx);
    case "undo": return undoChange(store, args, ctx);
    case "changes": return changesView(store, typeof args.limit === "number" ? args.limit : 20);
    default: throw new CoreError(`没有工具 ${name}`, "unsupported");
  }
}

export interface AgentRuntimeDeps {
  store: CoreStore;
  runs: AgentRunStore;
  /**
   * The model for one run (per-run llm_config_id / reasoning are in options).
   * null = no model configured → the run fails with a "configure a model" error.
   */
  llm(options: RunOptions): ResolvedLlm | LlmClient | null | Promise<ResolvedLlm | LlmClient | null>;
  /** More tools from other domains (fetch_page, tailor_resume...), already bound. */
  extraTools?: () => AgentTool[];
  prepareAttachments?: (message: string, ids: string[]) => Promise<PreparedAttachments>;
  maxConcurrentRuns?: number;
  memoryArm?: MemoryArm;
  now?: () => string;
}

function isResolved(value: ResolvedLlm | LlmClient): value is ResolvedLlm {
  return Boolean((value as ResolvedLlm).client && (value as ResolvedLlm).metadata);
}

export function createAgentRuntime(deps: AgentRuntimeDeps): AgentHost {
  const state = new AgentRunState(deps.runs, deps.now);
  const conversations = new AgentConversations(deps.runs, deps.now);
  const recordSpecs: ToolSpec[] = coreToolSpecs(AGENT_RECORD_TOOLS);
  return new AgentHost({
    state,
    conversations,
    async resolveLlm(options) {
      const picked = await deps.llm(options);
      if (!picked) throw new CoreError("没配模型：请先在设置里填写模型 API Key", "unsupported");
      if (isResolved(picked)) return picked;
      return { client: picked, metadata: { provider: picked.provider || "custom", model: picked.model || "", source: "active_config" } };
    },
    tools() {
      const record = bindAgentTools(recordSpecs, (name, args) => callRecordTool(deps.store, name, args, agentContext()));
      const extra = deps.extraTools?.() ?? [];
      const names = new Set(record.map((tool) => tool.name));
      return [...record, ...extra.filter((tool) => !names.has(tool.name))];
    },
    systemPrompt: ({ maxSteps }) => agentSystemPrompt(deps.store, agentContext(), { maxSteps, memoryArm: deps.memoryArm }),
    prepareAttachments: deps.prepareAttachments,
    maxConcurrentRuns: deps.maxConcurrentRuns,
  });
}

// ---- Agent writes as an "actions" timeline (GET /api/agent/runtime/actions) ----

export interface AgentActionView {
  id: string;
  run_id: string;
  operation: string;
  args: Json;
  summary: string;
  status: "done" | "undone";
  result: Json;
  undoable: boolean;
  delivered: boolean;
  created_at: string;
  decided_at: string | null;
}

/** "chg_<id>" ↔ change id. */
export function actionChangeId(actionId: string): number {
  const match = /^chg_(\d+)$/.exec(String(actionId || ""));
  if (!match) throw new CoreError(`Agent action ${actionId} 不存在`, "not_found");
  return Number(match[1]);
}

/**
 * The core Agent writes directly (undoable) instead of queueing actions, so
 * the timeline is the change log rows written by the Agent actor. Nothing is
 * ever "pending": confirm/reject have nothing to act on.
 */
export async function agentActions(store: CoreStore, filter: { status?: string; limit?: number } = {}): Promise<AgentActionView[]> {
  const limit = Math.max(1, Math.min(Number(filter.limit) || 100, 200));
  const status = String(filter.status || "");
  if (status && status !== "done" && status !== "undone") return [];
  const rows = (await store.changes(Math.min(1000, limit * 5))).filter((row) => row.actor === AGENT_ACTOR);
  const items = rows.map((row): AgentActionView => {
    const operation = row.after === null ? "delete" : "save";
    return {
      id: `chg_${row.id}`,
      run_id: "",
      operation,
      args: { type: row.type, id: row.record_id },
      summary: row.summary,
      status: row.undone_at ? "undone" : "done",
      result: { change_id: row.id, created: row.before === null, deleted: row.after === null },
      undoable: !row.undone_at,
      delivered: true,
      created_at: row.at,
      decided_at: row.undone_at,
    };
  });
  return items.filter((item) => !status || item.status === status).slice(0, limit);
}

/** action_gate.undo_preview: would undoing overwrite a later change to the same record? */
export async function agentActionUndoPreview(store: CoreStore, actionId: string): Promise<{ changed_after: boolean; message: string }> {
  const changeId = actionChangeId(actionId);
  const row = await store.getChange(changeId);
  if (!row || row.actor !== AGENT_ACTOR) throw new CoreError(`Agent action ${actionId} 不存在`, "not_found");
  if (row.undone_at) throw new CoreError("这条改动已经撤销过了", "conflict");
  const later = (await store.changes(1000)).filter((item) => item.id > changeId && item.type === row.type && item.record_id === row.record_id && !item.undone_at);
  return later.length
    ? { changed_after: true, message: `这条记录之后又被改过 ${later.length} 次；需要先撤销更新的改动。` }
    : { changed_after: false, message: "" };
}

/** Undo one Agent write as the user (undo is the user's own action). */
export async function undoAgentAction(store: CoreStore, actionId: string, ctx: CoreContext): Promise<{ ok: boolean; action: AgentActionView | null; result?: Json; errors?: string[] }> {
  const changeId = actionChangeId(actionId);
  const row = await store.getChange(changeId);
  if (!row || row.actor !== AGENT_ACTOR) throw new CoreError(`Agent action ${actionId} 不存在`, "not_found");
  const result = await undoChange(store, { change_id: changeId }, ctx);
  const action = (await agentActions(store, { limit: 200 })).find((item) => item.id === actionId) ?? null;
  return { ok: true, action, result: result as unknown as Json };
}
