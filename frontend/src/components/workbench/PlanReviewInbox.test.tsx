import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  decisionPlansPending: vi.fn(),
  decideDecisionGroup: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  agentRuntimeApi: {
    decisionPlansPending: api.decisionPlansPending,
    decideDecisionGroup: api.decideDecisionGroup,
  },
}));

import { PlanReviewInbox } from "./PlanReviewInbox";

const DIGEST = "a".repeat(64);
const GROUP_DIGEST = "b".repeat(64);

const node = (updates: Record<string, unknown> = {}) => ({
  node_id: "node_0123456789abcdef0123456789abcdef",
  sequence: 1,
  operation: "review_resume_proposal_items",
  args: { proposal_id: "prop_1", change_ids: ["c1"] },
  idempotency_key: "decision-node:node_1:abc",
  status: "pending",
  ...updates,
});

const group = (updates: Record<string, unknown> = {}) => ({
  group_id: "group_0123456789abcdef0123456789abcdef",
  plan_id: "plan_0123456789abcdef0123456789abcdef",
  sequence: 1,
  title: "更新项目经历措辞",
  summary: "将两段项目经历改为量化成果描述",
  risk_level: "L2",
  status: "pending",
  group_digest: GROUP_DIGEST,
  dependency_group_ids: [],
  reviewability: { status: "ready", reason_codes: [], counts_as_user_decision: true },
  interaction_state: "needs_user_review",
  display: {
    before: "负责内部工具开发",
    after: "主导内部工具开发，支撑 30 人团队",
    why: "目标岗位看重量化影响力",
    evidence: ["职位描述第 2 条", "简历第 3 节"],
  },
  nodes: [node()],
  ...updates,
});

const plan = (updates: Record<string, unknown> = {}) => ({
  plan_id: "plan_0123456789abcdef0123456789abcdef",
  run_id: "run_0123456789abcdef",
  revision: 1,
  title: "简历提案采纳计划",
  purpose: "把评审通过的修改落到简历工作区",
  status: "pending",
  plan_digest: DIGEST,
  groups: [group()],
  ...updates,
});

async function openInbox(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: /待审阅计划|计划审阅未同步|个计划进行中/ }));
}

describe("PlanReviewInbox", () => {
  beforeEach(() => {
    api.decisionPlansPending.mockReset();
    api.decideDecisionGroup.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("renders semantic groups without raw operation names by default", async () => {
    api.decisionPlansPending.mockResolvedValue({ plans: [plan()] });
    render(<PlanReviewInbox />);
    const user = userEvent.setup();
    await openInbox(user);

    expect(screen.getByText("简历提案采纳计划")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "决策分组：更新项目经历措辞" })).toBeInTheDocument();
    expect(screen.getByText("把评审通过的修改落到简历工作区")).toBeInTheDocument();
    // Before/After/Why/evidence from display_json
    expect(screen.getByText("负责内部工具开发")).toBeInTheDocument();
    expect(screen.getByText("主导内部工具开发，支撑 30 人团队")).toBeInTheDocument();
    expect(screen.getByText("目标岗位看重量化影响力")).toBeInTheDocument();
    expect(screen.getByText("职位描述第 2 条")).toBeInTheDocument();
    // Raw Registry operation names are not part of the default view.
    expect(screen.queryByText(/review_resume_proposal_items/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "批准：更新项目经历措辞" })).toBeInTheDocument();
  });

  it("sends plan and group digests with a client decision_id on approve", async () => {
    api.decisionPlansPending.mockResolvedValue({ plans: [plan()] });
    api.decideDecisionGroup.mockResolvedValue({
      ok: true,
      plan: plan({ status: "executing" }),
      group: group({ status: "approved" }),
      receipts: [{ node_id: "node_0123456789abcdef0123456789abcdef", status: "completed", effect_state: "committed" }],
    });
    render(<PlanReviewInbox />);
    const user = userEvent.setup();
    await openInbox(user);

    await user.click(screen.getByRole("button", { name: "批准：更新项目经历措辞" }));

    await waitFor(() => expect(api.decideDecisionGroup).toHaveBeenCalledTimes(1));
    const [runId, groupId, body] = api.decideDecisionGroup.mock.calls[0];
    expect(runId).toBe("run_0123456789abcdef");
    expect(groupId).toBe("group_0123456789abcdef0123456789abcdef");
    expect(body).toMatchObject({
      plan_id: "plan_0123456789abcdef0123456789abcdef",
      plan_digest: DIGEST,
      group_digest: GROUP_DIGEST,
      decision: "approve",
    });
    expect(body.decision_id).toMatch(/^[0-9a-f-]{36}$/);
    // Receipt effects are surfaced in the outcome notice.
    expect(await screen.findByText(/已生效 1 项/)).toBeInTheDocument();
  });

  it("rejects a group and keeps dependent groups visibly blocked", async () => {
    const dependent = group({
      group_id: "group_fedcba9876543210fedcba9876543210",
      sequence: 2,
      title: "更新求职信模板",
      status: "blocked",
      dependency_group_ids: ["group_0123456789abcdef0123456789abcdef"],
      group_digest: "c".repeat(64),
    });
    api.decisionPlansPending.mockResolvedValueOnce({ plans: [plan()] })
      .mockResolvedValue({ plans: [plan({ groups: [group({ status: "rejected" }), dependent] })] });
    api.decideDecisionGroup.mockResolvedValue({
      ok: true,
      plan: plan({ groups: [group({ status: "rejected" }), dependent] }),
    });
    render(<PlanReviewInbox />);
    const user = userEvent.setup();
    await openInbox(user);

    await user.click(screen.getByRole("button", { name: "拒绝：更新项目经历措辞" }));

    await waitFor(() => expect(api.decideDecisionGroup).toHaveBeenCalledTimes(1));
    expect(api.decideDecisionGroup.mock.calls[0][2].decision).toBe("reject");
    // 依赖分组显示阻塞说明，且不再提供批准按钮。
    expect(await screen.findByText(/因前置分组被拒绝或未完成而阻塞/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "批准：更新求职信模板" })).not.toBeInTheDocument();
  });

  it("shows adjust feedback and submits it with the rejection", async () => {
    api.decisionPlansPending.mockResolvedValue({ plans: [plan()] });
    api.decideDecisionGroup.mockResolvedValue({
      ok: true,
      plan: plan({ groups: [group({ status: "rejected" })] }),
    });
    render(<PlanReviewInbox />);
    const user = userEvent.setup();
    await openInbox(user);

    await user.click(screen.getByRole("button", { name: "调整建议：更新项目经历措辞" }));
    await user.type(
      screen.getByLabelText("调整意见：更新项目经历措辞"),
      "保留原始量化数字",
    );
    await user.click(screen.getByRole("button", { name: "提交调整：更新项目经历措辞" }));

    await waitFor(() => expect(api.decideDecisionGroup).toHaveBeenCalledTimes(1));
    expect(api.decideDecisionGroup.mock.calls[0][2].decision).toBe("reject");
    expect(await screen.findByText(/调整意见已随拒绝记录/)).toBeInTheDocument();
  });

  it("surfaces a desktop refusal error instead of approving from a browser surface", async () => {
    api.decisionPlansPending.mockResolvedValue({ plans: [plan()] });
    api.decideDecisionGroup.mockRejectedValue(new Error("请在 OfferU 桌面应用中确认 Agent 提案"));
    render(<PlanReviewInbox />);
    const user = userEvent.setup();
    await openInbox(user);

    await user.click(screen.getByRole("button", { name: "批准：更新项目经历措辞" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("桌面应用");
    expect(screen.getByRole("region", { name: "决策分组：更新项目经历措辞" })).toBeInTheDocument();
  });

  it("keeps stale and needs-reconciliation states visible", async () => {
    api.decisionPlansPending.mockResolvedValue({
      plans: [
        plan({
          status: "needs_reconciliation",
          groups: [
            group({ status: "stale" }),
            group({
              group_id: "group_fedcba9876543210fedcba9876543210",
              sequence: 2,
              title: "刷新岗位匹配摘要",
              status: "failed",
              group_digest: "d".repeat(64),
            }),
          ],
        }),
      ],
    });
    render(<PlanReviewInbox />);
    const user = userEvent.setup();
    await openInbox(user);

    expect(await screen.findByText("需要对账")).toBeInTheDocument();
    expect(screen.getByText(/不会自动重放/)).toBeInTheDocument();
    expect(screen.getByText(/需重新生成提案后再决定/)).toBeInTheDocument();
    expect(screen.getByText("执行失败")).toBeInTheDocument();
    // 非 pending 分组没有批准按钮。
    expect(screen.queryByRole("button", { name: /^批准：/ })).not.toBeInTheDocument();
  });

  it("hides itself when no plans exist and nothing failed", async () => {
    api.decisionPlansPending.mockResolvedValue({ plans: [] });
    const { container } = render(<PlanReviewInbox />);
    await waitFor(() => expect(api.decisionPlansPending).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
