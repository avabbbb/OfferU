import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockForJob } = vi.hoisted(() => ({
  mockForJob: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  roleBenchmarkApi: {
    forJob: mockForJob,
  },
}));

import { JobWorkspaceOverview } from "./JobWorkspaceOverview";

describe("JobWorkspaceOverview", () => {
  beforeEach(() => {
    mockForJob.mockReset();
    mockForJob.mockResolvedValue({
      found: true,
      run_id: "benchmark-1",
      status: "completed",
      valid_sample_count: 42,
      company_count: 18,
      sample_sufficient: true,
      signals: [
        { capability_id: "sql", evidence_gap: { status: "supported" } },
        { capability_id: "roadmap", evidence_gap: { status: "supported" } },
        { capability_id: "pricing", evidence_gap: { status: "missing" } },
      ],
    });
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
  });

  it("用现有 workspace 数据投影六个面板和 evidence counts", async () => {
    render(
      <JobWorkspaceOverview
        jobId={7}
        snapshotValue="岗位已保存"
        snapshotDescription="Northwind · Remote"
        roleTaskStatus="completed"
        materialStatus="ready"
        materialChangeCount={4}
        materialFactGateStatus="passed"
        interviewTaskCount={1}
        interviewActive={false}
        interviewNeedsReview
        timelineStage="面试中"
        timelineEventCount={2}
        timelineNextAction="准备下一轮面试"
      />,
    );

    expect(screen.getByText("Snapshot")).toBeInTheDocument();
    expect(screen.getByText("Role Intelligence")).toBeInTheDocument();
    expect(screen.getByText("Evidence Map")).toBeInTheDocument();
    expect(screen.getByText("Materials")).toBeInTheDocument();
    expect(screen.getByText("Interview")).toBeInTheDocument();
    expect(screen.getByText("Timeline")).toBeInTheDocument();

    await waitFor(() => expect(screen.getByText("42 个参考岗位")).toBeInTheDocument());
    expect(screen.getByText("2 proven")).toBeInTheDocument();
    expect(screen.getByText("1 gaps")).toBeInTheDocument();
    expect(screen.getByText("4 条候选修改")).toBeInTheDocument();
  });

  it("点击面板滚动到已有 section anchor", async () => {
    const target = document.createElement("div");
    target.id = "materials";
    document.body.appendChild(target);

    render(
      <JobWorkspaceOverview
        jobId={7}
        snapshotValue="岗位已保存"
        snapshotDescription="Northwind"
        materialStatus="ready"
        materialChangeCount={2}
        interviewTaskCount={0}
        interviewActive={false}
        interviewNeedsReview={false}
        timelineEventCount={0}
      />,
    );

    await userEvent.setup().click(screen.getByRole("button", { name: "打开 Materials" }));
    expect(target.scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });

    target.remove();
  });
});
