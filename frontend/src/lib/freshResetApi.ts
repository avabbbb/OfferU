import { agentRuntimeApi, request, type AgentProposalPlan, type AgentPlanDecisionResponse } from "@/lib/api";
import { decidePlanGroupInDesktop } from "@/lib/desktop-proposal-decision";

export type FreshResetProposal = {
  runId: string;
  actionId: string;
  planId: string;
  groupId: string;
  planDigest: string;
  groupDigest: string;
  summary: string;
};

function pendingReset(plan: AgentProposalPlan): FreshResetProposal | null {
  if (plan.status === "replaced" || plan.groups.length !== 1) return null;
  const group = plan.groups[0];
  if (group.status !== "pending" || group.nodes.length !== 1) return null;
  const node = group.nodes[0];
  if (node.operation !== "reset_local_business_data") return null;
  return {
    runId: plan.run_id, actionId: node.id, planId: plan.id, groupId: group.id,
    planDigest: plan.digest, groupDigest: group.digest,
    summary: node.summary || "清空本地 OfferU 职业数据",
  };
}

function decide(proposal: FreshResetProposal, approve: boolean): Promise<AgentPlanDecisionResponse> {
  return decidePlanGroupInDesktop(proposal.planId, proposal.groupId, {
    approve, planDigest: proposal.planDigest, groupDigest: proposal.groupDigest,
    decisionId: `decision_${proposal.groupId.replace(/^group_/, "")}`,
  });
}

export const freshResetApi = {
  createProposal: async (): Promise<FreshResetProposal> => {
    const result = await request<{ executed: boolean; requires_confirmation: boolean; plan?: AgentProposalPlan }>(
      "/api/agent/data/fresh-reset/proposal", { method: "POST" },
    );
    const pending = result.plan ? pendingReset(result.plan) : null;
    if (result.executed || !result.requires_confirmation || !pending) {
      throw new Error("OfferU 未能保存独立的 v2 全清审核计划。");
    }
    return pending;
  },
  pendingProposal: async (): Promise<FreshResetProposal | null> => {
    const { runs } = await agentRuntimeApi.runs({ limit: 100 });
    return runs.filter((run) => !["cancelled", "failed", "completed"].includes(run.status))
      .flatMap((run) => (run.proposal_plans || []).map(pendingReset)).find(Boolean) || null;
  },
  approve: (proposal: FreshResetProposal) => decide(proposal, true),
  reject: (proposal: FreshResetProposal) => decide(proposal, false),
};
