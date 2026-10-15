import { invoke, isTauri } from "@tauri-apps/api/core";

export type AgentActionDecision = "confirm" | "reject" | "undo";

/**
 * Confirm / reject a queued irreversible Agent action, or undo a done one.
 * Only the desktop shell holds the approval capability; a browser tab cannot.
 */
export function decideAgentActionInDesktop<T = unknown>(
  actionId: string,
  decision: AgentActionDecision,
): Promise<T> {
  if (!isTauri()) {
    return Promise.reject(new Error("请在 OfferU 桌面应用中处理这一步"));
  }
  return invoke<T>("decide_agent_action", { actionId, decision });
}
