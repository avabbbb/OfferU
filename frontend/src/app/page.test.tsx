import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockUseJobs,
  mockUseNotifications,
  mockUseCalendarEvents,
  mockUseAutomationInbox,
  mockUseCareerTasks,
  mockUseJobStats,
  mockUseJobTrend,
  mockUseProgressBoard,
  mockUseProgressCandidates,
  mockMutateNotifications,
  mockTriggerDailyCareerReview,
  mockDismissAutomationInboxItem,
  mockGetCareerArtifact,
} = vi.hoisted(() => ({
  mockUseJobs: vi.fn(),
  mockUseNotifications: vi.fn(),
  mockUseCalendarEvents: vi.fn(),
  mockUseAutomationInbox: vi.fn(),
  mockUseCareerTasks: vi.fn(),
  mockUseJobStats: vi.fn(),
  mockUseJobTrend: vi.fn(),
  mockUseProgressBoard: vi.fn(),
  mockUseProgressCandidates: vi.fn(),
  mockMutateNotifications: vi.fn(),
  mockTriggerDailyCareerReview: vi.fn(),
  mockDismissAutomationInboxItem: vi.fn(),
  mockGetCareerArtifact: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/api")>(),
  getCareerArtifact: mockGetCareerArtifact,
}));

vi.mock("../lib/hooks", () => ({
  useJobs: mockUseJobs,
  useNotifications: mockUseNotifications,
  useCalendarEvents: mockUseCalendarEvents,
  useAutomationInbox: mockUseAutomationInbox,
  useCareerTasks: mockUseCareerTasks,
  useJobStats: mockUseJobStats,
  useJobTrend: mockUseJobTrend,
  useProgressBoard: mockUseProgressBoard,
  useProgressCandidates: mockUseProgressCandidates,
  controlCareerTask: vi.fn(),
  triggerDailyCareerReview: mockTriggerDailyCareerReview,
  dismissAutomationInboxItem: mockDismissAutomationInboxItem,
}));

vi.mock("../lib/workbench", () => ({
  useWorkbench: () => ({ select: vi.fn() }),
}));

vi.mock("../components/onboarding/OnboardingChecklist", () => ({
  OnboardingChecklist: () => null,
  OnboardingTriggerButton: () => null,
}));

vi.mock("../components/charts/TrendChart", () => ({
  TrendChart: () => null,
}));

vi.mock("@/components/career/CareerQuestionsPanel", () => ({
  CareerQuestionsPanel: ({ taskId, heading }: { taskId: string; heading: string }) => (
    <section data-testid="career-questions-panel" data-task-id={taskId}>{heading}</section>
  ),
}));

vi.mock("../lib/showcase/router", () => ({ SHOWCASE: false }));

vi.mock("next/link", () => ({
  default: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => (
    <a href={href} className={className}>{children}</a>
  ),
}));

import TodayPage from "./page";

const idleHook = { data: undefined, error: undefined, isLoading: false, mutate: vi.fn() };

function setupJobs({ weekTotal = 0, allTotal = 0, weekItems = [] as Array<Record<string, unknown>> } = {}) {
  mockUseJobs.mockImplementation((filters: { period?: string; page_size?: number }) => {
    if (filters?.period === "week") {
      return { data: { items: weekItems, total: weekTotal, page: 1, page_size: 20 } };
    }
    return { data: { items: [], total: allTotal, page: 1, page_size: 1 } };
  });
}

describe("TodayPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseCalendarEvents.mockReturnValue(idleHook);
    mockUseAutomationInbox.mockReturnValue({ ...idleHook, data: { items: [] } });
    mockUseCareerTasks.mockReturnValue({ ...idleHook, data: { tasks: [] } });
    mockUseJobStats.mockReturnValue(idleHook);
    mockUseJobTrend.mockReturnValue(idleHook);
    mockUseProgressBoard.mockReturnValue({ ...idleHook, data: { companies: [], summary: {} } });
    mockUseProgressCandidates.mockReturnValue({ ...idleHook, data: { items: [], total: 0 } });
    mockUseNotifications.mockReturnValue({ data: [], mutate: mockMutateNotifications });
    mockTriggerDailyCareerReview.mockResolvedValue({ status: "dispatched" });
    mockDismissAutomationInboxItem.mockResolvedValue({ status: "dismissed" });
    mockGetCareerArtifact.mockResolvedValue({
      id: "prep-artifact-9",
      artifact_type: "interview_prep",
      title: "面试准备提纲",
      content_markdown: "## 准备重点\n\n先整理岗位证据。",
    });
  });

  it("本周无新岗位但已有保存岗位时，不显示“还没有岗位数据”", async () => {
    setupJobs({ weekTotal: 0, allTotal: 477 });
    render(<TodayPage />);

    expect(await screen.findByText(/本周暂无新岗位/)).toBeInTheDocument();
    expect(screen.getByText(/共 477 个已保存岗位/)).toBeInTheDocument();
    expect(screen.queryByText("还没有岗位数据")).not.toBeInTheDocument();
    expect(screen.queryByText("保存第一个岗位")).not.toBeInTheDocument();
  });

  it("directs provider authentication failures to model settings instead of blind retries", async () => {
    mockUseAutomationInbox.mockReturnValue({ ...idleHook, data: { items: [{
      item_id: "blocked-daily", category: "career_brief", task_id: "blocked-task", title: "每日简报需要处理", body: "old misleading failure",
      status: "pending", task_status: "blocked", task_error: "provider authentication failed", task_retryable: true,
      payload: { task: { task_type: "career_director", status: "blocked", error: "provider authentication failed" } },
    }] } });
    render(<TodayPage />);
    expect(await screen.findByRole("link", { name: "检查模型连接" })).toHaveAttribute("href", "/settings?section=models");
    expect(screen.queryByText("old misleading failure")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "配置后重试" })).toBeInTheDocument();
  });

  it("岗位总数为 0 时保留真实空状态和引导动作", async () => {
    setupJobs({ weekTotal: 0, allTotal: 0 });
    render(<TodayPage />);

    expect(await screen.findByText("还没有岗位数据")).toBeInTheDocument();
    expect(screen.getByText("保存第一个岗位")).toBeInTheDocument();
  });

  it("把当前求职状态压缩成最多三条主动下一步", async () => {
    setupJobs({ weekTotal: 1, allTotal: 3 });
    mockUseProgressCandidates.mockReturnValue({ ...idleHook, data: { items: [], total: 2 } });
    mockUseProgressBoard.mockReturnValue({
      ...idleHook,
      data: {
        companies: [
          {
            company: "星辰科技",
            records: [
              {
                application_attempt_id: 11,
                job_id: 101,
                company: "星辰科技",
                job_title: "AI 产品经理",
                current_stage: "interview_1",
                next_action: "准备一面",
                last_event_at: "2026-09-22T10:00:00",
                pending_candidates: 2,
                upcoming_interview: {
                  title: "AI 产品经理一面",
                  start_time: "2026-09-23T14:00:00",
                },
              },
            ],
          },
        ],
        summary: { pending_review: 2 },
        total_records: 1,
      },
    });

    render(<TodayPage />);

    expect(await screen.findByText("先做这几件事")).toBeInTheDocument();
    expect(screen.getByText("先确认 2 条求职进展")).toBeInTheDocument();
    expect(screen.getByText("准备 星辰科技 · AI 产品经理")).toBeInTheDocument();
    expect(screen.getByText(/最多只给你 3 个下一步/)).toBeInTheDocument();
  });

  it("在 Today 展示真实 CareerTask 生成的简报，并允许稍后处理", async () => {
    setupJobs({ weekTotal: 0, allTotal: 2 });
    mockUseAutomationInbox.mockReturnValue({
      ...idleHook,
      data: {
        items: [
          {
            item_id: "daily-brief-1",
            category: "needs_review",
            status: "pending",
            event_id: "daily-event-1",
            task_id: "daily-task-1",
            target_type: "career_brief",
            target_id: "2026-09-26",
            title: "今天的求职行动简报已准备",
            body: "Tomorrow interview takes priority.",
            payload: { event_type: "DAILY_REVIEW" },
            task_status: "completed",
          },
        ],
      },
    });
    mockUseCareerTasks.mockReturnValue({
      ...idleHook,
      data: {
        tasks: [
          {
            task_id: "daily-task-1",
            task_type: "career_director",
            status: "completed",
            input: { event_type: "DAILY_REVIEW" },
            result: {
              briefing: {
                situation_summary: "明天下午有面试，先准备岗位证据。",
                actions: [
                  {
                    objective: "准备星辰科技面试",
                    why_now: "面试安排在明天下午。",
                    expected_outcome: "整理岗位重点并完成一轮练习。",
                    autonomy_level: "L1",
                    requires_user: true,
                    dedupe_key: "interview-tomorrow",
                    target_ref: { kind: "job", id: "101" },
                  },
                ],
                questions: [],
              },
            },
          },
        ],
      },
    });
    render(<TodayPage />);

    expect(await screen.findByRole("heading", { name: "今天的求职简报" })).toBeInTheDocument();
    expect(screen.getByText("为什么现在：面试安排在明天下午。")).toBeInTheDocument();
    expect(screen.getByText("预期结果：整理岗位重点并完成一轮练习。")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /准备星辰科技面试/ })).toHaveAttribute("href", "/jobs/101");

    fireEvent.click(screen.getByRole("button", { name: "稍后处理" }));
    await waitFor(() => expect(mockDismissAutomationInboxItem).toHaveBeenCalledWith("daily-brief-1"));
  });

  it("在 Today 让 Daily Review 问题连接持久 CareerTask，并显示可用交付状态", async () => {
    setupJobs({ weekTotal: 0, allTotal: 2 });
    mockUseAutomationInbox.mockReturnValue({
      ...idleHook,
      data: {
        items: [{
          item_id: "daily-brief-questions",
          category: "needs_review",
          status: "pending",
          event_id: "daily-review-event",
          task_id: "daily-review-task",
          target_type: "career_brief",
          target_id: "2026-09-27",
          title: "今日简报已准备",
          body: "面试准备优先。",
          payload: { event_type: "DAILY_REVIEW" },
          task_status: "completed",
        }],
      },
    });
    mockUseCareerTasks.mockReturnValue({
      ...idleHook,
      data: {
        tasks: [{
          task_id: "daily-review-task",
          task_type: "career_director",
          status: "completed",
          input: { event_type: "DAILY_REVIEW" },
          result: {
            briefing: {
              situation_summary: "明天下午有面试。",
              actions: [],
              questions: [{ question: "你最想先练哪类问题？" }],
            },
            deliveries: [{
              state: "ready",
              artifact_id: "prep-artifact-9",
              artifact_type: "interview_prep",
              job_id: 42,
              title: "面试准备提纲",
              href: "/jobs/42?artifact=prep-artifact-9",
              practice: { answered: 0, total: 1, completed: false },
            }],
          },
        }],
      },
    });

    render(<TodayPage />);

    expect(await screen.findByTestId("career-questions-panel")).toHaveAttribute("data-task-id", "daily-review-task");
    expect(screen.getByText("面试准备提纲")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "打开练习" }));
    expect(await screen.findByRole("dialog", { name: "面试准备提纲" })).toBeInTheDocument();
    expect(mockGetCareerArtifact).toHaveBeenCalledWith("prep-artifact-9");
  });

  it("在收件箱前五项之外仍展示简历更新后的正向重新联系候选", async () => {
    setupJobs({ weekTotal: 0, allTotal: 2 });
    const filler = Array.from({ length: 5 }, (_, index) => ({
      item_id: `other-${index + 1}`,
      category: "fyi",
      status: "pending",
      event_id: `event-${index + 1}`,
      task_id: `task-${index + 1}`,
      target_type: "job",
      target_id: String(100 + index),
      title: "岗位情报正在更新",
      body: "稍后查看进度。",
      payload: { event_type: "JOB_SAVED" },
      task_status: "running",
    }));
    mockUseAutomationInbox.mockReturnValue({
      ...idleHook,
      data: {
        items: [
          ...filler,
          {
            item_id: "resume-update-inbox",
            category: "needs_review",
            status: "pending",
            event_id: "resume-update-event",
            task_id: "resume-update-task",
            target_type: "resume",
            target_id: "7",
            title: "新版简历找到一个可重新考虑的岗位",
            body: "这只是候选，不会自动联系招聘方。",
            payload: { event_type: "RESUME_UPDATED" },
            task_status: "completed",
          },
        ],
      },
    });
    mockUseCareerTasks.mockReturnValue({
      ...idleHook,
      data: {
        tasks: [{
          task_id: "resume-update-task",
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
                summary: "新版简历补上了岗位此前看不到的结果证据。",
                added_evidence_summary: "新增经确认的业务影响数据。",
                candidates: [
                  {
                    job_id: 42,
                    company: "星辰科技",
                    role: "产品经理",
                    worth_reengaging: true,
                    why: "旧版本没有体现这项已验证成果。",
                    suggested_angle: "说明项目带来的业务影响。",
                    urgency: "soon",
                  },
                  {
                    job_id: 43,
                    company: "云杉科技",
                    role: "产品负责人",
                    worth_reengaging: false,
                    why: "岗位已明确拒绝。",
                    urgency: "skip",
                  },
                ],
              },
            },
          },
          created_at: null,
          started_at: null,
          finished_at: null,
        }],
      },
    });

    render(<TodayPage />);

    expect(await screen.findByTestId("resume-reengagement-card")).toBeInTheDocument();
    expect(screen.getByText("星辰科技 · 产品经理")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "查看岗位与申请进展" })).toHaveAttribute("href", "/jobs/42");
    expect(screen.queryByText("云杉科技 · 产品负责人")).not.toBeInTheDocument();
    expect(screen.getByText(/不会发送消息或联系招聘方/)).toBeInTheDocument();
  });

  it("待确认信号可标记已处理，并从待确认列表消失", async () => {
    setupJobs({ weekTotal: 0, allTotal: 0 });
    const pending = {
      id: 7,
      email_subject: "面试邀请",
      email_from: "hr@example.com",
      company: "星辰科技",
      position: "后端工程师",
      category: "interview",
      category_display: "面试",
      interview_time: null,
      location: "",
      action_required: "确认面试时间",
      parsed_at: "2026-09-18 10:00:00",
      acknowledged_at: null,
    };
    const acked = { ...pending, id: 8, action_required: "回复笔试", acknowledged_at: "2026-09-18T08:00:00" };
    mockUseNotifications.mockReturnValue({
      data: [pending, acked],
      mutate: mockMutateNotifications,
    });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetchMock);

    render(<TodayPage />);

    // acked 信号不进入待确认列表
    expect(screen.getByText("确认面试时间")).toBeInTheDocument();
    expect(screen.queryByText("回复笔试")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("标记已处理"));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/api/email/notifications/7/ack"),
        expect.objectContaining({ method: "POST" }),
      ),
    );
    await waitFor(() => expect(mockMutateNotifications).toHaveBeenCalled());
    vi.unstubAllGlobals();
  });
});
