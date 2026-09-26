import { render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { CareerTask } from "@/lib/hooks";
import { ResumeReengagementCard } from "./ResumeReengagementCard";

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));

function task(overrides: Partial<CareerTask> = {}): CareerTask {
  return {
    task_id: "career-task-resume-1",
    task_type: "career_director",
    source: "automation",
    target_type: "resume",
    target_id: "7",
    runtime_provider: "codex",
    status: "completed",
    input: { event_type: "RESUME_UPDATED", resume_id: 7 },
    progress: {},
    error_id: "",
    error: "",
    retryable: false,
    attempt_count: 1,
    max_attempts: 2,
    result_ref: "",
    result: {
      briefing: {
        resume_update: {
          summary: "新版简历补充了可验证的项目结果。",
          added_evidence_summary: "新增已确认的业务影响数据。",
          candidates: [
            {
              job_id: 42,
              company: "星辰科技",
              role: "产品经理",
              worth_reengaging: true,
              why: "上次申请时尚未体现这项结果证据。",
              suggested_angle: "补充项目上线后的业务影响。",
              urgency: "soon",
            },
            {
              job_id: 43,
              company: "云杉科技",
              role: "产品负责人",
              worth_reengaging: false,
              why: "目前证据还不足以支持重新联系。",
              urgency: "soon",
            },
            {
              job_id: 44,
              company: "远山科技",
              role: "产品总监",
              worth_reengaging: true,
              why: "该机会明确拒绝。",
              urgency: "skip",
            },
          ],
        },
      },
    },
    created_at: null,
    started_at: null,
    finished_at: null,
    ...overrides,
  };
}

describe("ResumeReengagementCard", () => {
  it("shows only positive Registry-vetted candidates and links to the canonical job workspace", () => {
    render(<ResumeReengagementCard task={task()} />);

    expect(screen.getByTestId("resume-reengagement-card")).toBeInTheDocument();
    expect(screen.getByText("新版简历补充了可验证的项目结果。")).toBeInTheDocument();
    expect(screen.getByText(/新增已确认的业务影响数据/)).toBeInTheDocument();
    expect(screen.getByText(/上次申请时尚未体现这项结果证据/)).toBeInTheDocument();
    expect(screen.getByText(/补充项目上线后的业务影响/)).toBeInTheDocument();
    expect(screen.getByText("星辰科技 · 产品经理")).toBeInTheDocument();
    expect(screen.getByText("近期可考虑")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "查看岗位与申请进展" })).toHaveAttribute("href", "/jobs/42");
    expect(screen.queryByText("云杉科技 · 产品负责人")).not.toBeInTheDocument();
    expect(screen.queryByText("远山科技 · 产品总监")).not.toBeInTheDocument();
    expect(screen.getByText(/不会发送消息或联系招聘方/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /发送|联系/ })).not.toBeInTheDocument();
  });

  it("scopes the same candidate plan to the current Job Workspace", () => {
    render(<ResumeReengagementCard task={task()} jobId={42} />);

    const card = screen.getByTestId("resume-reengagement-card");
    expect(within(card).getByText("星辰科技 · 产品经理")).toBeInTheDocument();
    expect(within(card).queryByText("云杉科技 · 产品负责人")).not.toBeInTheDocument();
  });

  it("does not display a task from another trigger or a plan without positive candidates", () => {
    const { rerender } = render(<ResumeReengagementCard task={task({ input: { event_type: "DAILY_REVIEW" } })} />);
    expect(screen.queryByTestId("resume-reengagement-card")).not.toBeInTheDocument();

    rerender(<ResumeReengagementCard task={task({
      result: { briefing: { resume_update: { candidates: [{ job_id: 43, worth_reengaging: false, urgency: "skip" }] } } },
    })} />);
    expect(screen.queryByTestId("resume-reengagement-card")).not.toBeInTheDocument();

    rerender(<ResumeReengagementCard task={task({ status: "running" })} />);
    expect(screen.queryByTestId("resume-reengagement-card")).not.toBeInTheDocument();
  });
});
