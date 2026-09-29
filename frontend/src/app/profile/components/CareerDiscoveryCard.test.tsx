import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockCareerQuestionList, mockCareerQuestionSubmit } = vi.hoisted(() => ({
  mockCareerQuestionList: vi.fn(),
  mockCareerQuestionSubmit: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  careerQuestionsApi: { list: mockCareerQuestionList, submit: mockCareerQuestionSubmit },
}));

import { CareerDiscoveryCard, type CareerBriefing, type CareerSnapshot } from "./CareerDiscoveryCard";

const snapshot: CareerSnapshot = {
  identity: {
    career_stage: {
      track: "experienced",
      substage: "early_career",
      confidence: "medium",
      basis: ["有两年产品运营经验", "最近一份工作仍在职"],
    },
    experience_years: 2,
    current_role: "产品运营",
    employment_state: "在职，考虑新机会",
  },
  goals: {
    primary_roles: ["产品经理", "产品运营"],
    locations: ["上海"],
    compensation: "面议",
    timing: "三个月内",
  },
  profile_coverage: {
    strong_evidence: ["简历中的旧有扎实依据"],
    weak_evidence: ["简历中的旧有薄弱依据"],
    missing_evidence: ["简历中的旧有缺失项"],
    unknowns: ["简历中的旧有未知项"],
    underexpressed_strengths: ["简历中的旧有未呈现优势"],
  },
};

const briefing: CareerBriefing = {
  career_stage: {
    track: "experienced",
    substage: "early_career",
    confidence: "medium",
    basis: ["有两年产品运营经验", "最近一份工作仍在职"],
  },
  strategy_pack: "experienced_search.v1",
  profile_coverage: {
    strong_evidence: ["负责过跨团队项目"],
    weak_evidence: ["项目结果缺少量化影响"],
    missing_evidence: ["尚未整理作品案例"],
    unknowns: ["是否愿意接受管理职责"],
    underexpressed_strengths: ["协调复杂项目的能力没有写进简历"],
  },
  situation_summary: "你已有相关经验，下一步可以突出项目影响并确认目标岗位范围。",
  questions: [
    {
      question: "你希望下一份工作更偏产品规划还是增长运营？",
      why_needed: "两个方向需要强调的经历不同。",
      unlocks: "帮助确定简历重点和岗位筛选方向。",
      optional: true,
    },
  ],
};

describe("CareerDiscoveryCard", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows a readable assessment, briefing evidence, goals, and questions without answer inputs", () => {
    render(
      <CareerDiscoveryCard
        snapshot={snapshot}
        briefing={briefing}
        status="completed"
        onStart={vi.fn()}
        onRefresh={vi.fn()}
        onCorrect={vi.fn()}
      />,
    );

    expect(screen.getByText("职场求职 · 早期职业发展")).toBeInTheDocument();
    expect(screen.getByText(/判断把握.*中/)).toBeInTheDocument();
    expect(screen.getByText("有两年产品运营经验")).toBeInTheDocument();
    expect(screen.getByText("负责过跨团队项目")).toBeInTheDocument();
    expect(screen.queryByText("简历中的旧有扎实依据")).not.toBeInTheDocument();
    expect(screen.getByText("已有扎实依据")).toBeInTheDocument();
    expect(screen.getByText("可以补强的依据")).toBeInTheDocument();
    expect(screen.getByText("还缺少的信息")).toBeInTheDocument();
    expect(screen.getByText("还需要了解")).toBeInTheDocument();
    expect(screen.getByText("可以更好呈现的优势")).toBeInTheDocument();
    expect(screen.getByText("你希望下一份工作更偏产品规划还是增长运营？")).toBeInTheDocument();
    expect(screen.getByText(/这会帮助我们：帮助确定简历重点和岗位筛选方向/)).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByText(/CareerSnapshot|CareerStage|StrategyPack/)).not.toBeInTheDocument();
  });

  it("shows progress and disables starting while the analysis is running", async () => {
    const onStart = vi.fn();
    render(
      <CareerDiscoveryCard
        snapshot={null}
        briefing={null}
        status="running"
        onStart={onStart}
        onRefresh={vi.fn()}
        onCorrect={vi.fn()}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("正在结合你的经历和求职方向进行分析");
    const start = screen.getByRole("button", { name: "开始了解" });
    expect(start).toBeDisabled();
    await userEvent.setup().click(start);
    expect(onStart).not.toHaveBeenCalled();
  });

  it("keeps the failure visible and lets the user retry or refresh", async () => {
    const onStart = vi.fn();
    const onRefresh = vi.fn();
    render(
      <CareerDiscoveryCard
        snapshot={snapshot}
        briefing={null}
        status="failed"
        error="暂时无法连接分析服务"
        onStart={onStart}
        onRefresh={onRefresh}
        onCorrect={vi.fn()}
      />,
    );
    const user = userEvent.setup();

    expect(screen.getByRole("alert")).toHaveTextContent("暂时无法连接分析服务");
    await user.click(screen.getByRole("button", { name: "重试分析" }));
    await user.click(screen.getByRole("button", { name: "刷新信息" }));
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("sends only the explicitly selected stage to the correction callback", async () => {
    const onCorrect = vi.fn();
    render(
      <CareerDiscoveryCard
        snapshot={snapshot}
        briefing={briefing}
        status="completed"
        onStart={vi.fn()}
        onRefresh={vi.fn()}
        onCorrect={onCorrect}
      />,
    );
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "纠正判断" }));
    await user.selectOptions(screen.getByLabelText("选择你的求职阶段"), "experienced:career_switch");
    await user.click(screen.getByRole("button", { name: "提交更正" }));

    expect(onCorrect).toHaveBeenCalledWith({ track: "experienced", substage: "career_switch" });
  });

  it("loads answerable Discovery questions from the CareerTask when its id is available", async () => {
    mockCareerQuestionList.mockResolvedValue({
      task_id: "discovery-task-4",
      questions: [{
        question_index: 0,
        question: "你希望下一份工作更偏产品规划还是增长运营？",
        why_needed: "两个方向需要强调的经历不同。",
        unlocks: "帮助确定简历重点和岗位筛选方向。",
        optional: true,
        answer: null,
      }],
    });

    render(
      <CareerDiscoveryCard
        snapshot={snapshot}
        briefing={briefing}
        status="completed"
        taskId="discovery-task-4"
        onStart={vi.fn()}
        onRefresh={vi.fn()}
        onCorrect={vi.fn()}
      />,
    );

    expect(await screen.findByRole("textbox", { name: /你希望下一份工作更偏/ })).toBeInTheDocument();
    expect(mockCareerQuestionList).toHaveBeenCalledWith("discovery-task-4");
  });
});
