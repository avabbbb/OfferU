import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { buildCommentPrompt, CommentTray, SuggestionCard } from "./CanvasAssist";
import { conflictsWithManualEdit, diffText, findTargetSection, proposalTextChanges } from "./proposalDiff";

const before = {
  section_type: "experience", title: "工作经历", source_section_ids: [11],
  content_json: [{ company: "示例科技", description: "<ul><li><p>负责对账服务</p></li><li><p>优化慢查询</p></li></ul>" }],
};
const after = {
  ...before,
  content_json: [{ company: "示例科技", description: "<ul><li><p>负责日均千万笔的对账服务</p></li><li><p>优化慢查询</p></li></ul>" }],
};
const change = { change_id: "change_1", change_type: "modified", before, after, rationale: "JD 强调高并发" };

describe("行内 diff 的计算", () => {
  it("reports only the bullet that changed, with a readable location", () => {
    expect(proposalTextChanges(change)).toEqual([
      { label: "示例科技 · 要点 1", before: "负责对账服务", after: "负责日均千万笔的对账服务" },
    ]);
  });

  it("diffs Chinese by character so the inserted words stand out", () => {
    expect(diffText("负责对账服务", "负责日均千万笔的对账服务")).toEqual([
      { kind: "same", text: "负责" },
      { kind: "added", text: "日均千万笔的" },
      { kind: "same", text: "对账服务" },
    ]);
  });

  it("finds the target by evidence first and flags a manual edit as a conflict", () => {
    const sections = [
      { id: 1, section_type: "experience", title: "改过名的经历", content_json: before.content_json, source_section_ids: [11] },
    ];
    const target = findTargetSection(sections, change);
    expect(target?.id).toBe(1);
    expect(conflictsWithManualEdit(target, change)).toBe(false);
    const edited = { ...sections[0], content_json: [{ company: "示例科技", description: "我自己写的" }] };
    expect(conflictsWithManualEdit(edited, change)).toBe(true);
    expect(conflictsWithManualEdit(undefined, { change_type: "added" })).toBe(false);
  });
});

describe("建议卡：采用 / 修改 / 不用", () => {
  const renderProposal = (overrides: Partial<Parameters<typeof SuggestionCard>[0]> = {}) => {
    const props = {
      change, sectionLabel: "工作经历", conflict: false, factGateBlocked: false, busy: false,
      onAccept: vi.fn(), onSkip: vi.fn(), onAskRewrite: vi.fn(), onLocate: vi.fn(), ...overrides,
    };
    render(<SuggestionCard {...props} />);
    return props;
  };

  it("shows where, what changed and why, and accepts or drops it in one click", () => {
    const props = renderProposal();
    expect(screen.getByText("工作经历 · 示例科技")).toBeInTheDocument();
    expect(screen.getByText("负责对账服务")).toHaveClass("line-through");
    expect(screen.getByText("日均千万笔的")).toHaveAttribute("data-diff", "added");
    expect(screen.getByText("JD 强调高并发")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /采用/ }));
    expect(props.onAccept).toHaveBeenCalledWith();
    fireEvent.click(screen.getByRole("button", { name: "不用" }));
    expect(props.onSkip).toHaveBeenCalled();
    fireEvent.click(screen.getByText("JD 强调高并发"));
    expect(props.onLocate).toHaveBeenCalled();
  });

  it("lets the user rewrite the suggestion before accepting", () => {
    const props = renderProposal();
    fireEvent.click(screen.getByRole("button", { name: /修改/ }));
    const box = screen.getByRole("textbox", { name: "修改 AI 建议" });
    expect(box.textContent).toBe("负责日均千万笔的对账服务");
    box.textContent = "负责日均 1,000 万笔的对账服务";
    fireEvent.click(screen.getByRole("button", { name: /按我的改法采用/ }));
    expect(props.onAccept).toHaveBeenCalledWith("负责日均 1,000 万笔的对账服务");
  });

  it("never lets a stale suggestion overwrite the user's own edit", () => {
    const props = renderProposal({ conflict: true });
    expect(screen.getByRole("note")).toHaveTextContent("以你的版本为准");
    expect(screen.getByRole("button", { name: /^采用/ })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /^修改$/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "让 AI 按我的版本重写" }));
    expect(props.onAskRewrite).toHaveBeenCalled();
  });
});

describe("建议卡：推断技能要逐条确认", () => {
  const card = (extra: Record<string, unknown> = {}, onAccept = vi.fn()) => render(
    <SuggestionCard change={{ ...change, ...extra }} sectionLabel="工作经历" conflict={false} factGateBlocked={false} busy={false}
      onAccept={onAccept} onSkip={vi.fn()} onAskRewrite={vi.fn()} />,
  );

  it("lists inferred skills with their verbatim basis and asks to confirm truth", () => {
    const onAccept = vi.fn();
    card({ inferred_skills: [{ skill: "高并发", basis: "负责对账服务" }] }, onAccept);
    expect(screen.getByRole("note", { name: "模型推断的技能" })).toHaveTextContent("高并发");
    expect(screen.getByText(/依据：「负责对账服务」/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /属实，采用/ }));
    expect(onAccept).toHaveBeenCalledWith();
  });

  it("keeps the plain accept label when nothing is inferred", () => {
    card();
    expect(screen.queryByRole("note", { name: "模型推断的技能" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /属实/ })).not.toBeInTheDocument();
  });
});

describe("修改意见：先堆积，再一次交给 AI", () => {
  const comments = [
    { id: "a", quote: "负责对账服务", section: "工作经历", instruction: "更精炼" },
    { id: "b", quote: "优化慢查询", section: "工作经历", instruction: "补上优化幅度" },
  ];

  it("builds one prompt that keeps the user's edits and forbids invented facts", () => {
    const prompt = buildCommentPrompt(42, "示例公司 · 后端", comments);
    expect(prompt).toContain("岗位简历 #42");
    expect(prompt).toContain("1. 【工作经历】「负责对账服务」→ 更精炼");
    expect(prompt).toContain("2. 【工作经历】「优化慢查询」→ 补上优化幅度");
    expect(prompt).toContain("get_resume_workspace");
    expect(prompt).toContain("不要编造");
    expect(prompt).toContain("不要直接覆盖");
  });

  it("removes a single comment and submits the rest together", () => {
    const onRemove = vi.fn();
    const onSubmit = vi.fn();
    render(<CommentTray comments={comments} onRemove={onRemove} onSubmit={onSubmit} />);
    expect(screen.getByTestId("resume-comment-tray")).toHaveTextContent("2 条修改意见");
    fireEvent.click(screen.getAllByRole("button", { name: "删除这条意见" })[0]);
    expect(onRemove).toHaveBeenCalledWith("a");
    fireEvent.click(screen.getByRole("button", { name: "一次交给 AI" }));
    expect(onSubmit).toHaveBeenCalled();
  });
});
