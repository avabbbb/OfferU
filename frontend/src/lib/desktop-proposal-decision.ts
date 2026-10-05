import { invoke, isTauri } from "@tauri-apps/api/core";
import type {
  AgentConfirmationResponse,
  AgentPlanDecisionResponse,
  AgentProposalDecisionResponse,
} from "./api";
import type {
  DecisionGroupDecisionBody,
  DecisionGroupDecisionResult,
} from "./decisionPlans";

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

export function decidePlanGroupInDesktop(
  planId: string,
  groupId: string,
  decision: {
    approve: boolean;
    planDigest: string;
    groupDigest: string;
    decisionId: string;
  },
): Promise<AgentPlanDecisionResponse> {
  return invokeFromDesktop<AgentPlanDecisionResponse>("decide_agent_plan_group", {
    planId,
    groupId,
    ...decision,
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

/**
 * Plan Review v2: group-level approval/rejection. The Tauri command
 * `decide_agent_decision_group` holds the desktop approval capability and
 * re-validates run/group IDs plus digests natively; a browser surface can
 * never reach the approval route without it.
 */
export function decideAgentDecisionGroupInDesktop(
  runId: string,
  groupId: string,
  body: DecisionGroupDecisionBody,
): Promise<DecisionGroupDecisionResult> {
  return invokeFromDesktop<DecisionGroupDecisionResult>(
    "decide_agent_decision_group",
    { runId, groupId, body },
  );
}
