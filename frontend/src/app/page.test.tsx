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
  });

  it("本周无新岗位但已有保存岗位时，不显示“还没有岗位数据”", async () => {
    setupJobs({ weekTotal: 0, allTotal: 477 });
    render(<TodayPage />);

    expect(await screen.findByText(/本周暂无新岗位/)).toBeInTheDocument();
    expect(screen.getByText(/共 477 个已保存岗位/)).toBeInTheDocument();
    expect(screen.queryByText("还没有岗位数据")).not.toBeInTheDocument();
    expect(screen.queryByText("保存第一个岗位")).not.toBeInTheDocument();
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
