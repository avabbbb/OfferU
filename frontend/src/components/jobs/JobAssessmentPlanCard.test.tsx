import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CareerTask } from "@/lib/hooks";
import { JobAssessmentPlanCard } from "./JobAssessmentPlanCard";

function task(overrides: Partial<CareerTask>): CareerTask {
  return {
    task_id: "career-task-job-1",
    task_type: "career_director",
    source: "automation",
    target_type: "job",
    target_id: "42",
    runtime_provider: "codex",
    status: "completed",
    input: { event_type: "JOB_SAVED", job_id: 42 },
    progress: {},
    error_id: "",
    error: "",
    retryable: false,
    attempt_count: 1,
    max_attempts: 2,
    result_ref: "",
    result: {
      briefing: {
        situation_summary: "该岗位值得继续评估，但需要核实业务影响证据。",
        job_assessment: {
          fit: "plausible_match",
          fit_rationale: "已有项目经验部分对应岗位要求。",
          application_priority: "normal",
          evidence_alignment: [{
            requirement: "产品项目经验",
            evidence_ref: "profile-section:3",
            match: "strong",
            rationale: "项目职责与岗位范围相符。",
          }],
          evidence_gaps: [{
            requirement: "可验证的业务影响",
            why_missing: "当前材料没有量化结果。",
            evidence_to_seek: "核对是否有经确认的结果指标。",
          }],
          role_intelligence: { relevance: "useful", rationale: "市场样本可补充岗位定位。" },
          resume_prep: { relevance: "needed", rationale: "应先突出已验证的项目证据。" },
          interview_prep: { relevance: "not_now", rationale: "还没有面试安排。" },
          recommended_operations: ["prepare_resume_optimization"],
        },
      },
    },
    created_at: null,
    started_at: null,
    finished_at: null,
    ...overrides,
  };
}

describe("JobAssessmentPlanCard", () => {
  it("shows why the role matters, evidence gaps, and preparation recommendations", () => {
    render(<JobAssessmentPlanCard task={task({})} />);

    expect(screen.getByTestId("job-assessment-plan")).toBeInTheDocument();
    expect(screen.getByText("该岗位值得继续评估，但需要核实业务影响证据。")).toBeInTheDocument();
    expect(screen.getByText("可验证的业务影响")).toBeInTheDocument();
    expect(screen.getByText(/下一步：核对是否有经确认的结果指标/)).toBeInTheDocument();
    expect(screen.getByText(/建议继续：简历准备/)).toBeInTheDocument();
    expect(screen.getByText("评估已完成")).toBeInTheDocument();
    expect(screen.queryByText("已准备，可查看")).not.toBeInTheDocument();
  });

  it("makes a running assessment visible without inventing a result", () => {
    render(<JobAssessmentPlanCard task={task({ status: "running", result: {} })} />);

    expect(screen.getByText("正在分析")).toBeInTheDocument();
    expect(screen.getByText(/不会自动修改个人资料或投递状态/)).toBeInTheDocument();
    expect(screen.queryByText("匹配较强")).not.toBeInTheDocument();
  });

  it("shows a retry control only for retryable failed tasks", () => {
    const onRetry = vi.fn();
    render(<JobAssessmentPlanCard task={task({ status: "failed", error: "Provider unavailable", retryable: true })} onRetry={onRetry} />);

    expect(screen.getByRole("alert")).toHaveTextContent("Provider unavailable");
    expect(screen.getByRole("button", { name: "重试评估" })).toBeInTheDocument();
  });

  it("offers a user-clicked Role Intelligence action only when recommended", () => {
    const onStartRoleIntelligence = vi.fn();
    render(<JobAssessmentPlanCard task={task({
      result: {
        briefing: {
          situation_summary: "岗位需要市场样本校准。",
          job_assessment: {
            role_intelligence: { relevance: "useful", rationale: "市场样本可补充判断。" },
            recommended_operations: ["build_role_benchmark"],
          },
        },
      },
    })} onStartRoleIntelligence={onStartRoleIntelligence} />);

    const startButton = screen.getByRole("button", { name: "开始岗位情报" });
    expect(screen.getByText(/只有你点击后才会开始/)).toBeInTheDocument();
    fireEvent.click(startButton);
    expect(onStartRoleIntelligence).toHaveBeenCalledOnce();
  });
});
