import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ResumePaper, bulletsToDescription, editBullet, type PaperSection } from "./ResumePaper";
import { normalizeTemplateSettings } from "./templateSettings";

const section = (overrides: Partial<PaperSection> = {}): PaperSection => ({
  id: 7,
  section_type: "workExperiences",
  title: "工作经历",
  visible: true,
  sort_order: 0,
  content_json: [{
    company: "示例科技",
    position: "后端工程师",
    startDate: "2023.07",
    endDate: "至今",
    description: "<ul><li><p>负责支付对账服务</p></li><li><p>把对账耗时从 40 分钟降到 6 分钟</p></li></ul>",
  }],
  ...overrides,
});

const renderPaper = (props: Partial<Parameters<typeof ResumePaper>[0]> = {}) => render(
  <ResumePaper
    userName="林一"
    title="后端工程师"
    summary=""
    contactJson={{ email: "lin@example.com" }}
    sections={[section()]}
    styleConfig={{ template: "paper" }}
    {...props}
  />,
);

const commit = (element: HTMLElement, text: string) => {
  element.focus();
  element.textContent = text;
  fireEvent.blur(element);
};

describe("纸模板：成品即编辑器", () => {
  it("renders the finished resume without any editing chrome when read-only", () => {
    renderPaper();
    expect(screen.getByText("林一")).toBeInTheDocument();
    expect(screen.getByText("把对账耗时从 40 分钟降到 6 分钟")).toBeInTheDocument();
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
    expect(screen.queryByText(/添加一条/)).not.toBeInTheDocument();
  });

  it("commits a direct edit of a bullet back to the same source field", () => {
    const onSectionChange = vi.fn();
    renderPaper({ editable: true, onSectionChange });
    const [, second] = screen.getAllByRole("textbox", { name: "经历要点" });
    commit(second, "把对账耗时从 40 分钟降到 4 分钟");
    const next = onSectionChange.mock.calls[0][0] as PaperSection;
    expect(next.id).toBe(7);
    expect(next.content_json[0].description).toBe(
      "<ul><li><p>负责支付对账服务</p></li><li><p>把对账耗时从 40 分钟降到 4 分钟</p></li></ul>",
    );
    expect(next.content_json[0].company).toBe("示例科技");
  });

  it("edits profile fields in place and does nothing when the text is unchanged", () => {
    const onProfileChange = vi.fn();
    renderPaper({ editable: true, onProfileChange });
    const name = screen.getByRole("textbox", { name: "姓名" });
    commit(name, "林一");
    expect(onProfileChange).not.toHaveBeenCalled();
    commit(name, "林一一");
    expect(onProfileChange).toHaveBeenCalledWith({ user_name: "林一一" });
    commit(screen.getByRole("textbox", { name: "电话" }), "138 0000 0000");
    expect(onProfileChange).toHaveBeenLastCalledWith({ contact_json: { email: "lin@example.com", phone: "138 0000 0000" } });
  });

  it("Escape restores the original text instead of committing", () => {
    const onSectionChange = vi.fn();
    renderPaper({ editable: true, onSectionChange });
    const title = screen.getByRole("textbox", { name: "公司" });
    title.focus();
    title.textContent = "写错了";
    fireEvent.keyDown(title, { key: "Escape" });
    expect(title.textContent).toBe("示例科技");
  });

  it("adds an item from the canvas", () => {
    const onSectionChange = vi.fn();
    renderPaper({ editable: true, onSectionChange });
    fireEvent.click(screen.getByRole("button", { name: /添加一条/ }));
    const next = onSectionChange.mock.calls[0][0] as PaperSection;
    expect(next.content_json).toHaveLength(2);
    expect(next.content_json[1]).toMatchObject({ company: "", position: "", description: "" });
  });
});

describe("要点与 description 互转", () => {
  it("escapes user text and drops empty bullets", () => {
    expect(bulletsToDescription(["A <b>", " ", "\u200b"])).toBe("<ul><li><p>A &lt;b&gt;</p></li></ul>");
  });

  it("keeps hidden bullet indexes aligned when a bullet is removed", () => {
    const item = { description: "<ul><li><p>a</p></li><li><p>b</p></li><li><p>c</p></li></ul>", hidden_bullet_indexes: [2] };
    const next = editBullet(item, 0, { remove: true });
    expect(next.description).toBe("<ul><li><p>b</p></li><li><p>c</p></li></ul>");
    expect(next.hidden_bullet_indexes).toEqual([1]);
  });
});

describe("纸模板默认排版", () => {
  it("uses the Kami-style dense defaults only for the paper template", () => {
    const paper = normalizeTemplateSettings({ template: "paper" });
    expect(paper.margins).toEqual({ top: 11, right: 13, bottom: 11, left: 13 });
    expect(paper.exact.headingColor).toBe("#1B365D");
    expect(paper.exact.lineHeight).toBe(1.45);
    const reference = normalizeTemplateSettings({ template: "reference" });
    expect(reference.margins.top).toBe(8);
  });
});
