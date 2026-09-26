import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CareerTask } from "@/lib/hooks";
import { InterviewLifecycleCard } from "./InterviewLifecycleCard";

const { submitInterviewDebrief } = vi.hoisted(() => ({ submitInterviewDebrief: vi.fn() }));

vi.mock("@/lib/hooks", () => ({ submitInterviewDebrief }));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));

function task(overrides: Partial<CareerTask> = {}): CareerTask {
  return {
    task_id: "career-task-interview-1",
    task_type: "career_director",
    source: "automation",
    target_type: "interview",
    target_id: "51",
    runtime_provider: "codex",
    status: "completed",
    input: { event_type: "INTERVIEW_COMPLETED", calendar_event_id: 51, job_id: 42 },
    progress: {},
    error_id: "",
    error: "",
    retryable: false,
    attempt_count: 1,
    max_attempts: 2,
    result_ref: "",
    result: {
      briefing: {
        situation_summary: "这场面试刚结束，趁记忆还清楚先记录几个关键信息。",
        questions: [
          { question: "对方实际问了什么？", why_needed: "帮助识别重复考察重点。" },
          { question: "哪个回答最需要加强？" },
        ],
        interview_lifecycle: { mode: "debrief", calendar_event_id: 51 },
      },
    },
    created_at: null,
    started_at: null,
    finished_at: null,
    ...overrides,
  };
}

describe("InterviewLifecycleCard", () => {
  beforeEach(() => submitInterviewDebrief.mockReset().mockResolvedValue({ status: "dispatched" }));

  it("shows model-generated debrief questions and submits the owner's answers", async () => {
    const user = userEvent.setup();
    const onSubmitted = vi.fn();
    render(<InterviewLifecycleCard task={task()} onSubmitted={onSubmitted} />);

    expect(screen.getByText("花几分钟回顾这场面试")).toBeInTheDocument();
    expect(screen.getByText("对方实际问了什么？")).toBeInTheDocument();
    expect(screen.getByText("帮助识别重复考察重点。")).toBeInTheDocument();

    const answer = screen.getAllByRole("textbox")[0];
    await user.type(answer, "他们问了如何验证一次上线效果。");
    await user.click(screen.getByRole("button", { name: "整理复盘学习" }));

    await waitFor(() => expect(submitInterviewDebrief).toHaveBeenCalledWith(51, [
      "他们问了如何验证一次上线效果。",
      "",
    ]));
    expect(onSubmitted).toHaveBeenCalledOnce();
    expect(screen.getByText("已提交，OfferU 正在整理学习候选。")).toBeInTheDocument();
  });

  it("shows preparation priorities and why they matter now", () => {
    render(<InterviewLifecycleCard task={task({
      input: { event_type: "INTERVIEW_INVITATION_DETECTED", calendar_event_id: 51, job_id: 42 },
      result: {
        briefing: {
          interview_lifecycle: {
            mode: "prepare",
            calendar_event_id: 51,
            summary: "明天下午有一场产品经理面试。",
            focus_areas: ["讲清楚项目决策过程"],
            practice_questions: ["请介绍你如何处理优先级冲突。"],
          },
          actions: [{
            objective: "练习项目复盘",
            why_now: "面试明天下午开始。",
            expected_outcome: "更清楚地说明决策和结果。",
          }],
        },
      },
    })} />);

    expect(screen.getByText("OfferU 为这场面试准备了什么")).toBeInTheDocument();
    expect(screen.getByText("为什么现在：面试明天下午开始。")).toBeInTheDocument();
    expect(screen.getByText("请介绍你如何处理优先级冲突。")).toBeInTheDocument();
  });
});
