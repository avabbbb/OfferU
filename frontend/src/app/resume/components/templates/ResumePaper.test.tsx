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

describe("纸模板：照片与校徽", () => {
  it("shows uploaded photo and school logo in the finished resume without editing chrome", () => {
    renderPaper({ photoUrl: "https://example.test/photo.jpg", logoUrl: "https://example.test/logo.png" });
    expect(screen.getByRole("img", { name: "照片" })).toHaveAttribute("src", "https://example.test/photo.jpg");
    expect(screen.getByRole("img", { name: "校徽" })).toHaveAttribute("src", "https://example.test/logo.png");
    expect(screen.queryByRole("button", { name: /更换|移除|添加/ })).not.toBeInTheDocument();
  });

  it("takes no header space for media in a read-only resume without images", () => {
    renderPaper();
    expect(screen.queryByTestId("paper-asset-photo")).not.toBeInTheDocument();
    expect(screen.queryByTestId("paper-asset-logo")).not.toBeInTheDocument();
  });

  it("adds, replaces and removes images directly on the canvas", () => {
    const onUploadAsset = vi.fn();
    const { rerender } = renderPaper({ editable: true, onUploadAsset });
    const photo = new File(["x"], "me.png", { type: "image/png" });
    expect(screen.getByRole("button", { name: "添加照片" })).toHaveAttribute("data-paper-chrome");
    fireEvent.change(screen.getByTestId("paper-asset-input-photo"), { target: { files: [photo] } });
    expect(onUploadAsset).toHaveBeenCalledWith("photo", photo);

    rerender(
      <ResumePaper userName="林一" title="后端工程师" summary="" contactJson={{}} sections={[section()]}
        styleConfig={{ template: "paper" }} editable onUploadAsset={onUploadAsset}
        photoUrl="https://example.test/photo.jpg" logoUrl="https://example.test/logo.png" />,
    );
    fireEvent.click(screen.getByRole("button", { name: "移除校徽" }));
    expect(onUploadAsset).toHaveBeenLastCalledWith("logo", null);
    expect(screen.getByRole("button", { name: "更换照片" })).toBeInTheDocument();
  });
});

describe("要点与 description 互转", () => {
  it("keeps typed angle brackets as text, strips unsafe tags and drops empty bullets", () => {
    expect(bulletsToDescription(["A &lt;b&gt;", " ", "\u200b"])).toBe("<ul><li><p>A &lt;b&gt;</p></li></ul>");
    expect(bulletsToDescription(['<img src=x onerror="alert(1)">做了<script>x</script><a href="javascript:alert(1)">链接</a>'])).toBe("<ul><li><p>做了x链接</p></li></ul>");
  });

  it("keeps hidden bullet indexes aligned when a bullet is removed", () => {
    const item = { description: "<ul><li><p>a</p></li><li><p>b</p></li><li><p>c</p></li></ul>", hidden_bullet_indexes: [2] };
    const next = editBullet(item, 0, { remove: true });
    expect(next.description).toBe("<ul><li><p>b</p></li><li><p>c</p></li></ul>");
    expect(next.hidden_bullet_indexes).toEqual([1]);
  });
});

describe("纸模板默认排版", () => {
  it("默认「清晰」，选「留白」时用 Kami 的密排参数；只作用于纸模板", () => {
    const paper = normalizeTemplateSettings({ template: "paper" });
    expect(paper.margins).toEqual({ top: 11, right: 13, bottom: 11, left: 13 });
    expect(paper.exact.bodySize).toBe(9.5);
    expect(paper.exact.lineHeight).toBe(1.45);
    const kami = normalizeTemplateSettings({ template: "paper", paperStyle: "kami" });
    expect(kami.exact.headingColor).toBe("#1B365D");
    expect(kami.exact.lineHeight).toBe(1.42);
    expect(kami.exact.bodySize).toBe(9.2);
    expect(kami.exact.nameSize).toBe(26.5);
  });
});

describe("要点加粗", () => {
  it("AI 给的 <strong> 能在纸上显示，改别的要点时也不会丢", async () => {
    const { splitRichBullets, plainBullet } = await import("@/lib/resumeText");
    const { editBullet } = await import("./ResumePaper");
    const item = { description: "<ul><li>大促峰值 <strong>P99 从 180ms 降到 65ms</strong></li><li>补偿延迟降到 40 秒</li></ul>" };
    const next = editBullet(item, 1, { text: "补偿延迟从 15 分钟降到 40 秒" });
    expect(next.description).toContain("<strong>P99 从 180ms 降到 65ms</strong>");
    expect(next.description).not.toMatch(/<(?!\/?(ul|li|p|strong)>)/);
    expect(splitRichBullets(next.description).map(plainBullet)).toEqual(["大促峰值 P99 从 180ms 降到 65ms", "补偿延迟从 15 分钟降到 40 秒"]);
  });
});

describe("要点格式", () => {
  it("斜体、下划线、删除线、颜色、链接都能保存；Chrome 的 <b>/<i>/<font> 统一成标准标签", async () => {
    const { sanitizeInline } = await import("@/lib/resumeText");
    expect(sanitizeInline('<b>P99</b> <i>降到</i> <u>65ms</u> <strike>旧</strike> <font color="#2463eb">蓝</font> <a href="https://github.com/x">仓库</a>'))
      .toBe('<strong>P99</strong> <em>降到</em> <u>65ms</u> <s>旧</s> <span style="color: #2463eb">蓝</span> <a href="https://github.com/x">仓库</a>');
  });

  it("Tab 把要点缩进成二级要点，同时保留刚输入的文字", () => {
    const onSectionChange = vi.fn();
    renderPaper({ editable: true, onSectionChange });
    const [, second] = screen.getAllByRole("textbox", { name: "经历要点" });
    second.focus();
    second.innerHTML = "把对账耗时降到 <b>4 分钟</b>";
    fireEvent.keyDown(second, { key: "Tab" });
    const next = onSectionChange.mock.calls[0][0] as PaperSection;
    expect(next.content_json[0].description).toBe(
      '<ul><li><p>负责支付对账服务</p></li><li data-indent="1"><p>把对账耗时降到 <strong>4 分钟</strong></p></li></ul>',
    );
  });

  it("模块切换成序号后成品用有序列表，二级要点带缩进样式", () => {
    const { container } = renderPaper({
      styleConfig: { numberedSections: "7" },
      sections: [section({ content_json: [{ company: "示例科技", description: '<ul><li><p>一</p></li><li data-indent="1"><p>二</p></li></ul>' }] })],
    });
    expect(container.querySelector("ul.paper-bullets.paper-bullets-numbered")).not.toBeNull();
    expect(container.querySelector("li.paper-bullet-sub")?.textContent).toBe("二");
  });
});
