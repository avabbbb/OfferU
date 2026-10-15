import { agentActionsApi, request, type AgentActionDecisionResponse, type AgentActionRecord } from "@/lib/api";

export type FreshResetProposal = {
  actionId: string;
  summary: string;
};

function toProposal(action: AgentActionRecord): FreshResetProposal {
  return { actionId: action.id, summary: action.summary || "清空本地 OfferU 职业数据" };
}

export const freshResetApi = {
  createProposal: async (): Promise<FreshResetProposal> => {
    const result = await request<{ executed?: boolean; pending_action?: AgentActionRecord }>(
      "/api/agent/data/fresh-reset/proposal", { method: "POST" },
    );
    if (result.executed !== false || !result.pending_action?.id) {
      throw new Error("OfferU 没能把全清放进待确认列表。");
    }
    return toProposal(result.pending_action);
  },
  pendingProposal: async (): Promise<FreshResetProposal | null> => {
    const { items } = await agentActionsApi.list({ status: "pending" });
    const pending = items.find((item) => item.operation === "reset_local_business_data");
    return pending ? toProposal(pending) : null;
  },
  approve: (proposal: FreshResetProposal): Promise<AgentActionDecisionResponse> =>
    agentActionsApi.decide(proposal.actionId, "confirm"),
  reject: (proposal: FreshResetProposal): Promise<AgentActionDecisionResponse> =>
    agentActionsApi.decide(proposal.actionId, "reject"),
};
