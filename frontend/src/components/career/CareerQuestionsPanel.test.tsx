import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockList, mockSubmit } = vi.hoisted(() => ({
  mockList: vi.fn(),
  mockSubmit: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  careerQuestionsApi: { list: mockList, submit: mockSubmit },
}));

import { CareerQuestionsPanel } from "./CareerQuestionsPanel";

const question = {
  question_index: 0,
  question: "你负责的项目带来了什么可验证的结果？",
  why_needed: "岗位评估需要确认业务影响。",
  unlocks: "帮助判断哪些证据最值得展示。",
  optional: false,
  resume_proposal_id: "resume-proposal-7",
};

describe("CareerQuestionsPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("saves the answer as reviewable evidence and never exposes an approval action", async () => {
    mockList
      .mockResolvedValueOnce({ task_id: "career-task-1", questions: [question] })
      .mockResolvedValueOnce({
        task_id: "career-task-1",
        questions: [{ ...question, answer: { status: "pending", answer: "转化率提升了 18%。" } }],
      });
    mockSubmit.mockResolvedValue({ status: "pending" });

    render(<CareerQuestionsPanel taskId="career-task-1" />);
    const user = userEvent.setup();
    const input = await screen.findByRole("textbox", { name: /你负责的项目带来了/ });
    await user.type(input, "转化率提升了 18%。");
    await user.click(screen.getByRole("button", { name: "保存回答" }));

    await waitFor(() => expect(mockSubmit).toHaveBeenCalledWith("career-task-1", {
      question_index: 0,
      answer: "转化率提升了 18%。",
      proposal_id: "resume-proposal-7",
    }));
    expect(await screen.findByText("待审核")).toBeInTheDocument();
    expect(screen.getByText("你的回答（已保存，等待审核）")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /批准|采纳|审核/ })).not.toBeInTheDocument();
  });

  it("keeps the readable briefing fallback when the Registry question list is empty", async () => {
    mockList.mockResolvedValue({ task_id: "career-task-2", questions: [] });

    render(
      <CareerQuestionsPanel
        taskId="career-task-2"
        fallback={<p>你更关注产品规划还是增长运营？</p>}
      />,
    );

    expect(await screen.findByText("你更关注产品规划还是增长运营？")).toBeInTheDocument();
    expect(screen.queryByTestId("career-questions-panel")).not.toBeInTheDocument();
  });
});
