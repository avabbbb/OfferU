import { invoke, isTauri } from "@tauri-apps/api/core";
import type {
  AgentConfirmationResponse,
  AgentProposalDecisionResponse,
} from "./api";

function invokeFromDesktop<T>(command: string, args: Record<string, unknown>): Promise<T> {
  if (!isTauri()) {
    return Promise.reject(new Error("请在 OfferU 桌面应用中确认 Agent 提案"));
  }
  return invoke<T>(command, args);
}

export function decideProposalInDesktop(
  runId: string,
  actionId: string,
  approve: boolean,
): Promise<AgentProposalDecisionResponse> {
  return invokeFromDesktop<AgentProposalDecisionResponse>("decide_agent_proposal", {
    runId,
    actionId,
    approve,
  });
}

export function decideAgentRuntimeActionInDesktop(
  runId: string,
  actionId: string,
  approve: boolean,
): Promise<AgentConfirmationResponse> {
  return invokeFromDesktop<AgentConfirmationResponse>(
    "decide_agent_runtime_action",
    { runId, actionId, approve },
  );
}
