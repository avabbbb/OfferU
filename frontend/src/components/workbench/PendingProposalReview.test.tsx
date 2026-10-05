import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { listPending, decide, listPlans, getPlan, decideGroup } = vi.hoisted(() => ({
  listPending: vi.fn(),
  decide: vi.fn(),
  listPlans: vi.fn(),
  getPlan: vi.fn(),
  decideGroup: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  bridgeProposalApi: {
    listPending,
    decide,
  },
  agentPlansApi: {
    list: listPlans,
    get: getPlan,
    decideGroup,
  },
}));

import { PendingProposalReview } from "./PendingProposalReview";

const firstAction = {
  actionId: "triage_job:1",
  operation: "triage_job",
  args: { job_id: 42, status: "saved" },
  summary: "更新岗位状态",
};
const secondAction = {
  actionId: "set_current_view:1",
  operation: "set_current_view",
  args: { scope: "job", route: "/jobs/42" },
  summary: "打开岗位工作区",
};
const pendingRun = {
  runId: "cli-run-42",
  goal: "整理并推进这个岗位",
  steps: [firstAction, secondAction],
  createdAt: "2026-09-24T01:00:00Z",
};

const resumePlan = {
  id: `plan_${"1".repeat(32)}`,
  run_id: `run_${"2".repeat(32)}`,
  revision: 1,
  status: "sealed",
  digest: "a".repeat(64),
  title: "为 AI 产品经理岗位准备简历",
  groups: [{
    id: `group_${"3".repeat(32)}`,
    title: "产品经历调整",
    rationale: "突出与目标岗位直接相关的产品证据。",
    summary: "更新一条产品经历，共一个批量审核 Operation。",
    affected_entities: [
      { kind: "resume", id: 1 },
      { kind: "job", id: 42 },
      { kind: "profile", title: "Candidate profile" },
      {},
    ],
    risk: "protected",
    digest: "b".repeat(64),
    status: "pending",
    nodes: [{
      id: `node_${"4".repeat(32)}`,
      operation: "review_resume_proposal_items",
      summary: "采用已审核的简历修改",
      status: "pending",
      redactedArgs: { change_ids: ["change-1"] },
      display: {
        changes: [{
          summary: "产品经历",
          before: "负责需求调研",
          after: "根据用户访谈整理产品需求",
          evidence: "简历中的用户访谈项目记录",
          rationale: "把已有证据写得更具体。",
        }],
      },
    }],
  }],
  continuations: [],
};

const completedDecision = {
  ok: true,
  receipts: [{
    id: `receipt_${"5".repeat(32)}`,
    node_id: `node_${"4".repeat(32)}`,
    status: "completed",
    effect_state: "committed",
    audit_ref: "audit-1",
  }],
  continuation: {
    id: `continuation_${"6".repeat(32)}`,
    group_id: `group_${"3".repeat(32)}`,
    run_id: `run_${"2".repeat(32)}`,
    status: "delivered",
    receiver: "ui_result_projection",
    receipt_ids: [`receipt_${"5".repeat(32)}`],
  },
  run_status: "running",
};

describe("PendingProposalReview", () => {
  beforeEach(() => {
    listPending.mockReset();
    decide.mockReset();
    listPlans.mockReset().mockResolvedValue({ total: 0, items: [] });
    getPlan.mockReset();
    decideGroup.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps at most one pending refresh in flight", async () => {
    vi.useFakeTimers();
    let resolve!: (value: { items: typeof pendingRun[] }) => void;
    listPending.mockImplementation(() => new Promise((done) => { resolve = done; }));
    render(<PendingProposalReview />);
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    expect(listPending).toHaveBeenCalledTimes(1);
    await act(async () => { resolve({ items: [pendingRun] }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(listPending).toHaveBeenCalledTimes(2);
  });

  it("pauses polling in a hidden window and refreshes when visible", async () => {
    vi.useFakeTimers();
    listPending.mockResolvedValue({ items: [pendingRun] });
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    render(<PendingProposalReview />);
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    expect(listPending).toHaveBeenCalledTimes(1);
    visibility.mockReturnValue("visible");
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(listPending).toHaveBeenCalledTimes(2);
  });

  it("shows legacy proposals only in the compatibility section and submits the exact action decision", async () => {
    listPending
      .mockResolvedValueOnce({ total: 1, items: [pendingRun] })
      .mockResolvedValueOnce({
        total: 1,
        items: [{ ...pendingRun, steps: [secondAction] }],
      })
      .mockResolvedValueOnce({ total: 0, items: [] });
    decide
      .mockResolvedValueOnce({ approved: true, completed: true })
      .mockResolvedValueOnce({ approved: false, status: "rejected" });

    render(<PendingProposalReview />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: /旧版兼容请求 2 项/ }));
    await user.click(screen.getByText(/旧版兼容请求与历史记录/));
    expect(screen.getByText("整理并推进这个岗位")).toBeInTheDocument();
    expect(screen.getByText("更新岗位状态")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "执行旧动作：triage_job" }));
    await waitFor(() => {
      expect(decide).toHaveBeenNthCalledWith(1, "cli-run-42", "triage_job:1", true);
    });
    expect(await screen.findByText("打开岗位工作区")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "拒绝旧动作：set_current_view" }));
    await waitFor(() => {
      expect(decide).toHaveBeenNthCalledWith(2, "cli-run-42", "set_current_view:1", false);
    });
    await waitFor(() => expect(listPending).toHaveBeenCalledTimes(3));
    expect(screen.queryByText("整理并推进这个岗位")).not.toBeInTheDocument();
  });

  it("separates non-executable legacy history from current approval counts", async () => {
    listPending.mockResolvedValue({ total: 1, items: [pendingRun], unavailable: [{ ...pendingRun, runId: "old-pi", reason: "旧 Pi 会话不能重放" }] });
    render(<PendingProposalReview />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /旧版兼容请求 2 项/ }));
    await user.click(screen.getByText(/旧版兼容请求与历史记录/));
    expect(screen.getByText("已停止执行的历史请求")).toBeInTheDocument();
    expect(screen.getByText("旧 Pi 会话不能重放")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^执行旧动作：/ })).toHaveLength(2);
    expect(decide).not.toHaveBeenCalled();
  });

  it("keeps a proposal visible and reports a failed decision", async () => {
    listPending.mockResolvedValue({ total: 1, items: [pendingRun] });
    decide.mockRejectedValue(new Error("审批请求被拒绝"));

    render(<PendingProposalReview />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /旧版兼容请求 2 项/ }));
    await user.click(screen.getByText(/旧版兼容请求与历史记录/));
    await user.click(screen.getByRole("button", { name: "执行旧动作：triage_job" }));

    expect(await screen.findByText("审批请求被拒绝")).toBeInTheDocument();
    expect(screen.getByText("更新岗位状态")).toBeInTheDocument();
  });

  it("renders the sealed plan diff and approves the entire semantic group once", async () => {
    listPlans.mockResolvedValue({ total: 1, items: [resumePlan] });
    getPlan.mockResolvedValue(resumePlan);
    decideGroup.mockResolvedValue(completedDecision);

    render(<PendingProposalReview />);
    const user = userEvent.setup();

    expect(await screen.findByText("为 AI 产品经理岗位准备简历")).toBeInTheDocument();
    expect(screen.getByText("负责需求调研")).toBeInTheDocument();
    expect(screen.getByText("根据用户访谈整理产品需求")).toBeInTheDocument();
    expect(screen.getByText("简历中的用户访谈项目记录")).toBeInTheDocument();
    expect(screen.getByText("把已有证据写得更具体。")).toBeInTheDocument();
    expect(screen.getByText("影响范围：简历 1、岗位 42、档案 · Candidate profile")).toBeInTheDocument();
    expect(screen.getByText("需要审核")).toBeInTheDocument();
    expect(screen.queryByText("protected")).not.toBeInTheDocument();
    expect(screen.queryByText(/\[object Object\]/)).not.toBeInTheDocument();
    expect(screen.queryByText(/change_ids/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "批准整组：产品经历调整" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: /^批准：/ })).not.toBeInTheDocument();

    await user.click(screen.getByText("操作细节"));
    expect(await screen.findByText(/change_ids/)).toBeInTheDocument();
    await user.click(screen.getByText("操作细节"));
    await waitFor(() => expect(screen.queryByText(/change_ids/)).not.toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "批准整组：产品经历调整" }));
    await waitFor(() => expect(decideGroup).toHaveBeenCalledTimes(1));
    expect(decideGroup).toHaveBeenCalledWith(
      resumePlan.id,
      resumePlan.groups[0].id,
      expect.objectContaining({
        approve: true,
        plan_digest: resumePlan.digest,
        group_digest: resumePlan.groups[0].digest,
        decision_id: expect.stringMatching(/^decision_[0-9a-f]{32}$/),
      }),
    );
    expect(await screen.findByText(/已批准“产品经历调整”整组改动/)).toBeInTheDocument();
    expect(screen.getByText(/已提交|已完成/)).toBeInTheDocument();
    expect(screen.getByText(/结果已存回原任务（未自动恢复 Agent 推理）/)).toBeInTheDocument();
    expect(screen.queryByText(/同一 Run 已收到回执/)).not.toBeInTheDocument();
  });

  it("folds completed, rejected and replaced groups to their result summary", async () => {
    const terminalGroups: typeof resumePlan.groups = ["completed", "rejected", "replaced"].map((status, index) => ({
      ...resumePlan.groups[0],
      id: `group_${String(index + 5).repeat(32)}`,
      title: `${status} 改动组`,
      status,
      nodes: [{
        ...resumePlan.groups[0].nodes[0],
        id: `node_${String(index + 5).repeat(32)}`,
        status,
        receipt: {
          id: `receipt_${String(index + 5).repeat(32)}`,
          status,
          effect_state: status === "completed" ? "committed" : "no_effect",
        },
      }],
    }));
    terminalGroups.push({
      ...resumePlan.groups[0],
      id: `group_${"8".repeat(32)}`,
      title: "被替代计划中的待审核组",
      status: "pending",
    });
    const terminalPlan = { ...resumePlan, status: "replaced", groups: terminalGroups };
    listPending.mockResolvedValue({ total: 0, items: [] });
    listPlans.mockResolvedValue({ total: 1, items: [terminalPlan] });
    getPlan.mockResolvedValue(terminalPlan);
    const user = userEvent.setup();
    render(<PendingProposalReview />);

    await user.click(await screen.findByRole("button", { name: "计划记录 1 项" }));
    for (const group of terminalGroups) {
      const title = screen.getByText(group.title);
      expect(title.closest("details")).not.toBeNull();
      expect((title.closest("details") as HTMLDetailsElement).open).toBe(false);
    }
    expect(screen.getByText(/结果：已完成 · 已提交/)).toBeInTheDocument();
    expect(screen.getByText("被替代计划中的待审核组").closest("details")).toHaveTextContent("已被新组替代");
    expect(screen.queryByRole("button", { name: /^批准整组：/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^拒绝整组：/ })).not.toBeInTheDocument();

    await user.click(screen.getByText("completed 改动组"));
    await waitFor(() => {
      expect((screen.getByText("completed 改动组").closest("details") as HTMLDetailsElement).open).toBe(true);
    });
    const expanded = screen.getByText("completed 改动组").closest("details")!;
    expect(expanded).toHaveTextContent("负责需求调研");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("opens the refreshed remaining groups and submits their newly displayed digests", async () => {
    const successor = {
      ...resumePlan, id: `plan_${"7".repeat(32)}`, revision: 2, digest: "c".repeat(64),
      refresh_from: { plan_id: resumePlan.id, group_ids: [resumePlan.groups[0].id], completed_receipt_ids: [completedDecision.receipts[0].id] },
      groups: [{
        ...resumePlan.groups[0],
        id: `group_${"8".repeat(32)}`,
        title: "新版项目经历",
        digest: "d".repeat(64),
        nodes: [{
          ...resumePlan.groups[0].nodes[0],
          id: `node_${"9".repeat(32)}`,
          display: { changes: [{
            summary: "按最新简历内容重算",
            before: "旧快照证据",
            after: "更新快照证据",
            evidence: "最新简历内容",
            rationale: "新摘要绑定当前简历版本",
          }] },
        }],
      }],
    };
    const historical = { ...resumePlan, status: "completed", groups: [{ ...resumePlan.groups[0], status: "completed" }] };
    listPending.mockResolvedValue({ items: [] });
    listPlans.mockResolvedValueOnce({ items: [resumePlan] }).mockResolvedValue({ items: [historical, successor] });
    getPlan.mockImplementation(async (id: string) => id === successor.id ? successor : resumePlan);
    decideGroup.mockResolvedValueOnce({ ...completedDecision, plan: { ...resumePlan, status: "replaced" }, successor_plan_id: successor.id, successor_plan: successor }).mockResolvedValue(completedDecision);
    const user = userEvent.setup();
    render(<PendingProposalReview />);
    await user.click(await screen.findByRole("button", { name: "批准整组：产品经历调整" }));
    await screen.findByRole("button", { name: "批准整组：新版项目经历" });
    expect(decideGroup).toHaveBeenCalledTimes(1);
    expect(screen.getByText("旧快照证据")).toBeInTheDocument();
    expect(screen.getByText("更新快照证据")).toBeInTheDocument();
    expect(screen.queryByText("负责需求调研")).not.toBeInTheDocument();
    expect(screen.getByText(/剩余未执行组已更新为新版本/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "批准整组：新版项目经历" }));
    await waitFor(() => expect(decideGroup).toHaveBeenCalledTimes(2));
    expect(decideGroup).toHaveBeenLastCalledWith(successor.id, successor.groups[0].id,
      expect.objectContaining({ plan_digest: successor.digest, group_digest: successor.groups[0].digest }));
  });

  it("keeps a selected successor visible when an older plan poll returns late", async () => {
    const successor = {
      ...resumePlan,
      title: "新版项目经历",
      id: `plan_${"6".repeat(32)}`,
      revision: 2,
      digest: "c".repeat(64),
      groups: [{
        ...resumePlan.groups[0],
        id: `group_${"8".repeat(32)}`,
        title: "新版项目经历",
        digest: "d".repeat(64),
        nodes: [{
          ...resumePlan.groups[0].nodes[0],
          id: `node_${"9".repeat(32)}`,
          display: { changes: [{
            before: "过期的改前内容",
            after: "当前的改后内容",
            evidence: "当前简历证据",
            rationale: "绑定刷新后的来源",
          }] },
        }],
      }],
    };
    let resolveStaleList!: (value: { items: typeof resumePlan[] }) => void;
    listPending.mockResolvedValue({ items: [] });
    listPlans
      .mockResolvedValueOnce({ items: [resumePlan] })
      .mockImplementationOnce(() => new Promise((resolve) => { resolveStaleList = resolve; }))
      .mockResolvedValue({ items: [resumePlan, successor] });
    getPlan.mockImplementation(async (planId: string) => planId === successor.id ? successor : resumePlan);
    decideGroup.mockResolvedValueOnce({ ...completedDecision, plan: { ...resumePlan, status: "replaced" }, successor_plan_id: successor.id, successor_plan: successor })
      .mockResolvedValue(completedDecision);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const user = userEvent.setup();
    render(<PendingProposalReview />);

    await screen.findByRole("button", { name: "批准整组：产品经历调整" });
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(listPlans).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole("button", { name: "批准整组：产品经历调整" }));

    expect(await screen.findByText("当前简历证据")).toBeInTheDocument();
    expect(screen.getByText("过期的改前内容")).toBeInTheDocument();
    expect(screen.queryByText("负责需求调研")).not.toBeInTheDocument();
    await act(async () => { resolveStaleList({ items: [resumePlan] }); });
    await waitFor(() => expect(screen.getByText("当前简历证据")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /新版项目经历 · 待审核/ })).toHaveAttribute("aria-pressed", "true");

    await user.click(screen.getByRole("button", { name: "批准整组：新版项目经历" }));
    await waitFor(() => expect(decideGroup).toHaveBeenCalledTimes(2));
    expect(decideGroup).toHaveBeenLastCalledWith(successor.id, successor.groups[0].id,
      expect.objectContaining({ plan_digest: successor.digest, group_digest: successor.groups[0].digest }));
  });

  it("keeps stale, paused, partial and reconciliation results visible without approving again", async () => {
    const recoverablePlan = {
      ...resumePlan,
      status: "needs_reconciliation",
      groups: [{
        ...resumePlan.groups[0],
        status: "needs_reconciliation",
        nodes: [{
          ...resumePlan.groups[0].nodes[0],
          status: "uncertain",
          receipt: {
            id: `receipt_${"7".repeat(32)}`,
            node_id: `node_${"4".repeat(32)}`,
            status: "needs_reconciliation",
            effect_state: "partial",
            audit_ref: "audit-partial",
          },
        }],
      }],
      continuations: [{
        id: `continuation_${"8".repeat(32)}`,
        group_id: `group_${"3".repeat(32)}`,
        run_id: `run_${"2".repeat(32)}`,
        status: "failed",
        receiver: "ui_result_projection",
        error: "Run 暂未接收回执",
      }],
    };
    listPlans.mockResolvedValue({ total: 1, items: [recoverablePlan] });
    getPlan.mockResolvedValue(recoverablePlan);

    render(<PendingProposalReview />);

    const groupHeading = await screen.findByRole("heading", { name: "产品经历调整" });
    const group = groupHeading.closest("section");
    expect(group).not.toBeNull();
    expect(within(group as HTMLElement).getByText(/执行回执：.*部分完成/)).toBeInTheDocument();
    expect(within(group as HTMLElement).getByText(/原任务回执投影失败，可重试：Run 暂未接收回执/)).toBeInTheDocument();
    expect(within(group as HTMLElement).queryByRole("button", { name: /^批准整组：/ })).not.toBeInTheDocument();
    expect(decideGroup).not.toHaveBeenCalled();
  });

  it("shows paused and stale groups as read-only states", async () => {
    const pausedPlan = {
      ...resumePlan,
      id: `plan_${"9".repeat(32)}`,
      status: "paused",
      title: "暂停中的计划",
      groups: [{ ...resumePlan.groups[0], id: `group_${"8".repeat(32)}`, status: "paused" }],
    };
    const stalePlan = {
      ...resumePlan,
      id: `plan_${"7".repeat(32)}`,
      title: "来源变化的计划",
      groups: [{ ...resumePlan.groups[0], id: `group_${"6".repeat(32)}`, status: "stale" }],
    };
    listPlans.mockResolvedValue({ total: 2, items: [pausedPlan, stalePlan] });
    getPlan.mockImplementation(async (planId: string) => planId === pausedPlan.id ? pausedPlan : stalePlan);

    render(<PendingProposalReview />);
    const user = userEvent.setup();

    expect(await screen.findByText("暂停中的计划")).toBeInTheDocument();
    expect(screen.getByText("已暂停")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^批准整组：/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /来源变化的计划/ }));
    expect(await screen.findByText("内容已变化，请重新审核")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^批准整组：/ })).not.toBeInTheDocument();
    expect(decideGroup).not.toHaveBeenCalled();
  });

  it("suppresses old action approval when the same run has a new plan", async () => {
    listPlans.mockResolvedValue({ total: 1, items: [resumePlan] });
    getPlan.mockResolvedValue(resumePlan);
    listPending.mockResolvedValue({ total: 1, items: [{ ...pendingRun, runId: resumePlan.run_id }] });

    render(<PendingProposalReview />);

    await screen.findByText("为 AI 产品经理岗位准备简历");
    expect(screen.getByText(/兼容请求已由新计划接管/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^执行旧动作：/ })).not.toBeInTheDocument();
    expect(decide).not.toHaveBeenCalled();
  });

  it("opens the requested plan when AgentPanel signals the target Run and Plan", async () => {
    getPlan.mockResolvedValue(resumePlan);
    render(<PendingProposalReview />);

    window.dispatchEvent(new CustomEvent("offeru-open-plan-review", {
      detail: { run_id: resumePlan.run_id, plan_id: resumePlan.id },
    }));

    expect(await screen.findByText("为 AI 产品经理岗位准备简历")).toBeInTheDocument();
    expect(getPlan).toHaveBeenCalledWith(resumePlan.id);
    expect(screen.getByRole("button", { name: "关闭计划审核" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "批准整组：产品经历调整" })).toBeEnabled();
  });
});
