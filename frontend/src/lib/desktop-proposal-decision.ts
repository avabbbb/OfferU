import { invoke, isTauri } from "@tauri-apps/api/core";

import { resolveApiBase } from "./apiBase";
import { liteToken } from "./liteSession";

export type AgentActionDecision = "confirm" | "reject" | "undo";

/**
 * Confirm / reject a queued irreversible Agent action, or undo a done one.
 * Only the desktop shell or a workbench paired by `offeru start` holds the
 * approval capability; an Agent calling the API directly cannot.
 */
export async function decideAgentActionInDesktop<T = unknown>(
  actionId: string,
  decision: AgentActionDecision,
): Promise<T> {
  if (isTauri()) return invoke<T>("decide_agent_action", { actionId, decision });
  const token = liteToken();
  if (!token) throw new Error("请用 offeru start 打开的工作台处理这一步");
  const res = await fetch(
    `${resolveApiBase()}/api/agent/runtime/actions/${encodeURIComponent(actionId)}/${decision}`,
    { method: "POST", headers: { Authorization: `Bearer ${token}` }, redirect: "error" },
  );
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(res.status === 403 ? "工作台授权已失效，请重新运行 offeru start" : payload?.detail || `操作失败：${res.status}`);
  }
  return payload as T;
}
