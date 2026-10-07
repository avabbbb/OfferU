import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { JobNextStepCard } from "./JobNextStepCard";

function renderCard(overrides: Partial<Parameters<typeof JobNextStepCard>[0]> = {}) {
  const props = {
    stage: "needs_research",
    loading: false,
    canRetryTask: false,
    hasResumeProposal: false,
    interviewFirst: false,
    jobId: 9,
    preparing: false,
    onRetryTask: vi.fn(),
    onPrepareDecision: vi.fn(),
    onManualDecision: vi.fn(),
    onOpenResumeWorkspace: vi.fn(),
    ...overrides,
  };
  render(<MemoryRouter><JobNextStepCard {...props} /></MemoryRouter>);
  return props;
}

describe("JobNextStepCard", () => {
  it("模型未配置时给出去设置的出口，而不是只能重试", () => {
    renderCard({ taskStatus: "failed", taskError: "LLM API Key 未配置（provider=deepseek）", canRetryTask: true });
    expect(screen.getByText("岗位情报没跑起来：缺少可用的 AI 配置")).toBeInTheDocument();
    expect(screen.getByText("去设置").closest("a")).toHaveAttribute("href", expect.stringContaining("/settings"));
    expect(screen.getByRole("button", { name: "不用 AI，我自己决定" })).toBeInTheDocument();
  });

  it("需要投前决定时可以生成建议，也可以自己决定", async () => {
    const props = renderCard({ stage: "needs_decision" });
    await userEvent.click(screen.getByRole("button", { name: "生成建议" }));
    await userEvent.click(screen.getByRole("button", { name: "不用 AI，我自己决定" }));
    expect(props.onPrepareDecision).toHaveBeenCalledTimes(1);
    expect(props.onManualDecision).toHaveBeenCalledTimes(1);
  });

  it("决定投递后直达这个岗位的简历定制", () => {
    renderCard({ stage: "ready_for_resume_proposal" });
    expect(screen.getByText("开始简历定制").closest("a")).toHaveAttribute("href", expect.stringContaining("/optimize?job_ids=9"));
  });

  it("人工决定后新调研到达时只提示重新评估，不覆盖当前决定", async () => {
    const props = renderCard({ stage: "ready_for_resume_proposal", researchRefreshAvailable: true });
    expect(screen.getByText("有新的岗位情报，要重新评估吗？")).toBeInTheDocument();
    expect(screen.getByText("继续用当前决定").closest("a")).toHaveAttribute("href", expect.stringContaining("/optimize?job_ids=9"));
    await userEvent.click(screen.getByRole("button", { name: "基于新情报重新评估" }));
    expect(props.onPrepareDecision).toHaveBeenCalledTimes(1);
  });

  it("面试阶段优先提示面试准备", () => {
    renderCard({ stage: "resume_proposal_ready", interviewFirst: true });
    expect(screen.getByText("准备面试")).toBeInTheDocument();
  });
});
