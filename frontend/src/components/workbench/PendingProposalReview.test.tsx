import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { listPending, decide } = vi.hoisted(() => ({
  listPending: vi.fn(),
  decide: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  bridgeProposalApi: {
    listPending,
    decide,
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

describe("PendingProposalReview", () => {
  beforeEach(() => {
    listPending.mockReset();
    decide.mockReset();
  });

  it("shows detached CLI proposals and submits the exact action decision", async () => {
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

    await user.click(await screen.findByRole("button", { name: /待你确认 2 项/ }));
    expect(screen.getByText("整理并推进这个岗位")).toBeInTheDocument();
    expect(screen.getByText("更新岗位状态")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "批准：triage_job" }));
    await waitFor(() => {
      expect(decide).toHaveBeenNthCalledWith(1, "cli-run-42", "triage_job:1", true);
    });
    expect(await screen.findByText("打开岗位工作区")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "拒绝：set_current_view" }));
    await waitFor(() => {
      expect(decide).toHaveBeenNthCalledWith(2, "cli-run-42", "set_current_view:1", false);
    });
    await waitFor(() => expect(listPending).toHaveBeenCalledTimes(3));
    expect(screen.queryByText("整理并推进这个岗位")).not.toBeInTheDocument();
  });

  it("keeps a proposal visible and reports a failed decision", async () => {
    listPending.mockResolvedValue({ total: 1, items: [pendingRun] });
    decide.mockRejectedValue(new Error("审批请求被拒绝"));

    render(<PendingProposalReview />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /待你确认 2 项/ }));
    await user.click(screen.getByRole("button", { name: "批准：triage_job" }));

    expect(await screen.findByText("审批请求被拒绝")).toBeInTheDocument();
    expect(screen.getByText("更新岗位状态")).toBeInTheDocument();
  });
});
