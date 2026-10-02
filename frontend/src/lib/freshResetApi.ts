import {
  agentRuntimeApi,
  request,
  type AgentRunRecord,
  type AgentConfirmationResponse,
} from "@/lib/api";

export type FreshResetProposal = {
  runId: string;
  actionId: string;
  summary: string;
};

type FreshResetProposalResponse = {
  executed: boolean;
  requires_confirmation: boolean;
  proposal?: {
    run_id: string;
    action_id: string;
    operation: string;
    status: string;
  };
};

function pendingResetInRun(run: AgentRunRecord): FreshResetProposal | null {
  if (run.status !== "waiting_confirmation") return null;
  const step = run.steps.find(
    (item) => item.tool === "reset_local_business_data" && item.status === "waiting_confirmation",
  );
  return step
    ? { runId: run.id, actionId: step.id, summary: step.summary || "清空本地 OfferU 职业数据" }
    : null;
}

export const freshResetApi = {
  createProposal: async (): Promise<FreshResetProposal> => {
    const result = await request<FreshResetProposalResponse>(
      "/api/agent/data/fresh-reset/proposal",
      { method: "POST" },
    );
    const proposal = result.proposal;
    if (!result.requires_confirmation || !proposal?.run_id || !proposal.action_id) {
      throw new Error("OfferU 未能保存待批准的清理提案。");
    }
    return {
      runId: proposal.run_id,
      actionId: proposal.action_id,
      summary: "清空本地 OfferU 职业数据",
    };
  },
  pendingProposal: async (): Promise<FreshResetProposal | null> => {
    const { runs } = await agentRuntimeApi.runs({ limit: 100 });
    return runs.map(pendingResetInRun).find((proposal) => proposal !== null) || null;
  },
  approve: (proposal: FreshResetProposal): Promise<AgentConfirmationResponse> =>
    agentRuntimeApi.confirm(proposal.runId, proposal.actionId),
  reject: (proposal: FreshResetProposal): Promise<AgentConfirmationResponse> =>
    agentRuntimeApi.reject(proposal.runId, proposal.actionId),
};
