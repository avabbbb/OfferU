// /api/agent/context, /api/agent/runtime/connections and the Python-only background
// surfaces (career tasks, career artifacts, automation, hosted executor sessions,
// conformance, capability plugins) on the TS backend.
//
// Python served the background surfaces from its SQLAlchemy workspace (djm.db) through the
// Operation Registry (ops.py), which the TS rewrite drops by decision (see
// docs/route-coverage.md). The records store has no career tasks, automation events,
// artifacts or hosted executor sessions, so reads answer the same shapes empty and writes
// answer 404 (that id does not exist) or 501 (that capability is gone), never a fake success.

import { CoreError } from "./types";

// ---- current view (Python get_current_view / set_current_view / clear_current_view) ----

export type CurrentView = {
  scope: string;
  route: string;
  title: string;
  entity_type: string;
  entity_id: string;
  selection: Record<string, unknown>;
  filters: Record<string, unknown>;
  context: Record<string, unknown>;
  version: number;
  updated_by: string;
  updated_at: string | null;
};

const text = (value: unknown, limit: number): string => (value === null || value === undefined ? "" : String(value)).slice(0, limit);
const plain = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {});

function emptyView(scope: string): CurrentView {
  return { scope, route: "", title: "", entity_type: "", entity_id: "", selection: {}, filters: {}, context: {}, version: 0, updated_by: "", updated_at: null };
}

/**
 * What page the user is on, for the Agent's context. Process memory (Python kept a row in
 * djm.db): it is UI state that the next page change overwrites anyway.
 */
export class CurrentViewState {
  private readonly views = new Map<string, CurrentView>();

  get(scope = "default"): Record<string, unknown> {
    const key = (scope || "default").trim() || "default";
    return { ok: true, outputs: this.views.get(key) ?? emptyView(key), errors: [] };
  }

  set(body: unknown, now: string): Record<string, unknown> {
    const raw = plain(body);
    const scope = text(raw.scope, 80).trim() || "default";
    const previous = this.views.get(scope);
    const view: CurrentView = {
      scope,
      route: text(raw.route, 300),
      title: text(raw.title, 300),
      entity_type: text(raw.entity_type, 80),
      entity_id: text(raw.entity_id, 120),
      selection: plain(raw.selection),
      filters: plain(raw.filters),
      context: plain(raw.context),
      version: (previous?.version ?? 0) + 1,
      updated_by: text(raw.updated_by || "ui", 80),
      updated_at: now,
    };
    this.views.set(scope, view);
    return { ok: true, outputs: view, errors: [] };
  }

  clear(scope = "default"): Record<string, unknown> {
    const key = (scope || "default").trim() || "default";
    const existed = this.views.delete(key);
    return { ok: true, outputs: { scope: key, cleared: existed }, errors: [] };
  }
}

// ---- local Agent connections (projection of the companion's Agent board) ----

export const CONNECT_PROMPT = "请打开 OfferU 桌面版，在「设置 → 使用我的 Agent」里连接本机装的 Agent（Codex、Claude Code 等）。"
  + "不要启动源码环境、猜测目录、修改账号/凭据/代理或自行确认业务写操作。";

function connectionStatus(row: Record<string, unknown>): string {
  if (!row.executable_found) return "missing";
  switch (String(row.skill_status || "")) {
    case "INSTALLED": return row.connected ? "ready" : "check_required";
    case "OUTDATED": return "outdated";
    case "NOT_INSTALLED": return "integration_missing";
    case "NOT_SUPPORTED": return "incompatible";
    default: return "failed";
  }
}

/** Board row (core agent-board boardRow) → the AgentConnection shape the settings panel reads. */
export function connectionFromBoardRow(row: Record<string, unknown>, now: string): Record<string, unknown> {
  const status = connectionStatus(row);
  const lastCheck = plain(row.last_check);
  const notChecked = "not_checked";
  return {
    id: String(row.id ?? ""),
    name: String(row.display_name ?? row.id ?? ""),
    installed: Boolean(row.executable_found),
    compatible: status !== "incompatible",
    version: "",
    status,
    authenticated: null,
    connection_verified: status === "ready",
    integration_status: String(row.skill_status || "").toLowerCase(),
    skill_status: String(row.skill_status || "ERROR"),
    skill_version: "",
    skill_hash: "",
    expected_skill_version: "",
    expected_skill_hash: "",
    can_install_skill: Boolean(row.executable_found) && status !== "incompatible",
    can_live_verify_skill: false,
    auth_mode: "",
    checked_at: typeof lastCheck.at === "string" ? lastCheck.at : null,
    detected_at: now,
    last_error: String(row.error ?? ""),
    provider_checked_at: null,
    docs_url: String(row.docs_url ?? ""),
    can_verify_login: false,
    live_model_verified: false,
    native_auth_state: notChecked,
    live_model_state: notChecked,
    structured_output_state: notChecked,
    streaming_state: notChecked,
    resume_state: notChecked,
    cancel_state: notChecked,
    cwd_isolation_state: notChecked,
    web_search_state: notChecked,
    routing_eval_state: notChecked,
    conformance_checked_at: null,
    transport: "mcp",
    skill_path: String(row.skill_path ?? ""),
    mcp_status: "UNKNOWN",
  };
}

/** GET /api/agent/runtime/connections; `rows` = the board's agents (empty off the companion). */
export function connectionsSnapshot(rows: Array<Record<string, unknown>>, now: string): Record<string, unknown> {
  const items = rows.filter((row) => !row.hidden).map((row) => connectionFromBoardRow(row, now));
  const ready = items.find((item) => item.status === "ready" || item.installed);
  return {
    items,
    checked_at: now,
    connect_prompt: CONNECT_PROMPT,
    beginner_provider_ids: [],
    recommended_provider_id: ready ? String(ready.id) : null,
  };
}

// ---- surfaces that only existed on the Python workspace ----

export const BACKGROUND_TASKS_GONE = "后台职业任务（Career Director）只在旧的 Python 后端里有，新后端不再提供；请直接在对话里让 Agent 做";
export const AUTOMATION_GONE = "自动化收件箱只在旧的 Python 后端里有，新后端不再提供";
export const HOSTED_SESSIONS_GONE = "托管执行器会话只在旧的 Python 后端里有，新后端不再提供";
export const PLUGINS_GONE = "能力插件只在旧的 Python 后端里有，新后端不再提供";
export const CONFORMANCE_GONE = "本机 Agent 一致性检查只在旧的 Python 后端里有；新后端在「使用我的 Agent」里检查连接";

export const notFound = (what: string): never => {
  throw new CoreError(`${what} 不存在`, "not_found");
};
export const unsupported = (message: string): never => {
  throw new CoreError(message, "unsupported");
};

export function emptyCareerTasks(): Record<string, unknown> {
  return { tasks: [], items: [], total: 0 };
}
export function emptyCareerArtifacts(): Record<string, unknown> {
  return { items: [], total: 0 };
}
export function emptyAutomation(kind: "events" | "inbox" | "rules"): Record<string, unknown> {
  return { items: [], total: 0, kind };
}
export function emptyHostedSessions(): Record<string, unknown> {
  return { items: [] };
}
export function emptyPlugins(): Record<string, unknown> {
  return { items: [], plugins: [], capabilities: [] };
}
export function emptyConformance(): Record<string, unknown> {
  return { providers: [], items: [], checked_at: null, message: CONFORMANCE_GONE };
}
