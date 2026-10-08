import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { buildCommentPrompt, CommentTray, InlineProposal } from "./CanvasAssist";
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

describe("InlineProposal：采用 / 修改 / 跳过", () => {
  const renderProposal = (overrides: Partial<Parameters<typeof InlineProposal>[0]> = {}) => {
    const props = {
      change, conflict: false, factGateBlocked: false, busy: false,
      onAccept: vi.fn(), onSkip: vi.fn(), onAskRewrite: vi.fn(), ...overrides,
    };
    render(<InlineProposal {...props} />);
    return props;
  };

  it("shows the change in place and accepts or skips it in one click", () => {
    const props = renderProposal();
    expect(screen.getByText("日均千万笔的")).toHaveClass("paper-diff-added");
    expect(screen.getByText("JD 强调高并发")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /采用/ }));
    expect(props.onAccept).toHaveBeenCalledWith();
    fireEvent.click(screen.getByRole("button", { name: /跳过/ }));
    expect(props.onSkip).toHaveBeenCalled();
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
    expect(screen.getByRole("button", { name: /修改/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "让 AI 按我的版本重写" }));
    expect(props.onAskRewrite).toHaveBeenCalled();
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

