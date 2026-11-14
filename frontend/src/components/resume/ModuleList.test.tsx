import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { emptyResume, type Resume } from "@/lib/resumeModel";
import { BASICS, ModuleList } from "./ModuleList";

afterEach(cleanup);

function setup() {
  const resume = emptyResume(); // 教育、实习、项目、技能
  const onChange = vi.fn<(next: Resume) => void>();
  const onSelect = vi.fn<(id: string) => void>();
  render(<ModuleList resume={resume} onChange={onChange} selected={BASICS} onSelect={onSelect} />);
  return { resume, onChange, onSelect };
}

describe("ModuleList", () => {
  it("基础信息锁在第一位、开关不能关", () => {
    setup();
    expect(screen.getByRole("switch", { name: "基础信息总是显示" })).toBeDisabled();
    expect(screen.getAllByRole("button", { name: /^拖动排序：/ }).map((b) => b.getAttribute("aria-label")))
      .toEqual(["拖动排序：教育经历", "拖动排序：实习经历", "拖动排序：项目经历", "拖动排序：技能证书"]);
  });

  it("关掉开关只隐藏，点模块名切到它", () => {
    const { resume, onChange, onSelect } = setup();
    fireEvent.click(screen.getByRole("switch", { name: "在简历里隐藏实习经历" }));
    expect(onChange.mock.calls[0][0].sections[1]).toMatchObject({ id: resume.sections[1].id, hidden: true });
    fireEvent.click(screen.getByRole("button", { name: "项目经历" }));
    expect(onSelect).toHaveBeenCalledWith(resume.sections[2].id);
  });

  it("更多模块开关一开就加进来并切过去；也能加自定义模块", () => {
    const { onChange, onSelect } = setup();
    fireEvent.click(screen.getByRole("switch", { name: "加入荣誉奖项" }));
    const added = onChange.mock.calls[0][0].sections.at(-1)!;
    expect(added).toMatchObject({ type: "awards", title: "荣誉奖项", hidden: false });
    expect(onSelect).toHaveBeenCalledWith(added.id);
    fireEvent.click(screen.getByRole("button", { name: "添加自定义模块" }));
    expect(onChange.mock.calls[1][0].sections.at(-1)).toMatchObject({ type: "custom", title: "自定义模块" });
  });
});
