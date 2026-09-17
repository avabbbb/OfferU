import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { ProgressBoardPayload, ProgressUnlinkedCandidate } from "@/lib/hooks";
import type * as SwrModule from "swr";

const { mockUseProgressBoard, mockUseProgressTimeline, mockReviewProgressCandidate, mockMutate } =
  vi.hoisted(() => ({
    mockUseProgressBoard: vi.fn(),
    mockUseProgressTimeline: vi.fn(),
    mockReviewProgressCandidate: vi.fn(),
    mockMutate: vi.fn(async () => {}),
  }));

vi.mock("@/lib/hooks", () => ({
  useProgressBoard: mockUseProgressBoard,
  useProgressTimeline: mockUseProgressTimeline,
  reviewProgressCandidate: mockReviewProgressCandidate,
}));

vi.mock("swr", async (importOriginal) => {
  const actual = await importOriginal<typeof SwrModule>();
  return { ...actual, useSWRConfig: () => ({ mutate: mockMutate }) };
});

vi.mock("@/lib/showcase/router", () => ({ SHOWCASE: false }));

import ProgressBoard from "./progress-board";

function emptyBoard(): ProgressBoardPayload {
  return {
    status: "active",
    total_companies: 0,
    total_records: 0,
    companies: [],
    unlinked_candidates: [],
    summary: { by_stage: {}, pending_review: 0, unlinked_review: 0 },
  };
}

function makeCandidate(overrides: Partial<ProgressUnlinkedCandidate> = {}): ProgressUnlinkedCandidate {
  return {
    candidate_id: "cand-1",
    status: "pending",
    match_state: "unmatched",
    suggested_stage: "interview_1",
    selected_stage: null,
    classification_conflict: false,
    rule_stage: "interview_1",
    llm_stage: "interview_1",
    application: null,
    signal: {
      signal_id: "sig-1",
      channel: "email",
      sender: "hr@bytedance.com",
      received_at: "2026-09-10T08:00:00Z",
      subject: "字节跳动 一面邀约",
      status: "parsed",
      snippet: "您好，邀请您参加后端工程师岗位的一面",
    },
    created_at: "2026-09-10T08:00:00Z",
    extracted: { company: "字节跳动", job_title: "后端工程师", interview_time: null },
    evidence: {
      snippet: "邀请您参加一面",
      evidence_span: "",
      rule_stage: "interview_1",
      llm_stage: "interview_1",
      llm_confidence: 0.9,
      classification_conflict: false,
    },
    match_candidates: [],
    reasons: [],
    can_create_record: true,
    ...overrides,
  };
}

function boardWithCandidate(candidate: ProgressUnlinkedCandidate): ProgressBoardPayload {
  const board = emptyBoard();
  board.unlinked_candidates = [candidate];
  board.summary.pending_review = 1;
  board.summary.unlinked_review = 1;
  return board;
}

function renderBoard() {
  return render(
    <MemoryRouter>
      <ProgressBoard />
    </MemoryRouter>,
  );
}

describe("ProgressBoard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseProgressTimeline.mockReturnValue({ data: undefined, isLoading: false });
    mockUseProgressBoard.mockReturnValue({ data: emptyBoard(), isLoading: false });
  });

  it("没有任何投递记录时给出下一步指引而不是空白", async () => {
    renderBoard();
    expect(await screen.findByText(/暂无进行中的投递记录/)).toBeInTheDocument();
    expect(screen.getByText(/从「岗位」页挑选岗位创建投递/)).toBeInTheDocument();
  });

  it("确认待归属进展会写入审核结果并刷新看板投影", async () => {
    mockUseProgressBoard.mockReturnValue({
      data: boardWithCandidate(makeCandidate()),
      isLoading: false,
    });
    mockReviewProgressCandidate.mockResolvedValue({ candidate_id: "cand-1", status: "confirmed", duplicate: false });

    renderBoard();
    expect(await screen.findByText("待归属进展")).toBeInTheDocument();
    expect(screen.getByText("字节跳动")).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "确认并建档" }));

    await waitFor(() =>
      expect(mockReviewProgressCandidate).toHaveBeenCalledWith("cand-1", {
        action: "accept",
        stage: "interview_1",
        application_attempt_id: undefined,
        create_record: true,
        add_calendar: true,
      }),
    );
    // 确认后必须让看板/候选两个投影都重新拉取
    await waitFor(() => expect(mockMutate).toHaveBeenCalled());
  });

  it("未选择阶段时无法确认，防止误写错误阶段", async () => {
    // classification_conflict 使初始阶段为空 → 必须用户显式选择
    mockUseProgressBoard.mockReturnValue({
      data: boardWithCandidate(
        makeCandidate({
          classification_conflict: true,
          evidence: {
            snippet: "面试通知",
            evidence_span: "",
            rule_stage: "applied",
            llm_stage: "interview_1",
            llm_confidence: 0.6,
            classification_conflict: true,
          },
        }),
      ),
      isLoading: false,
    });

    renderBoard();
    const confirm = await screen.findByRole("button", { name: "确认并建档" });
    expect(confirm).toBeDisabled();
    expect(screen.getByText(/阶段判断存在冲突/)).toBeInTheDocument();
  });
});
