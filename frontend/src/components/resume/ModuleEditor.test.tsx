import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/lib/agentCompose", () => ({ composeToAgent: vi.fn() }));

import { composeToAgent } from "@/lib/agentCompose";
import { normalizeResume, type Resume } from "@/lib/resumeModel";
import { ModuleEditor } from "./ModuleEditor";

afterEach(() => { cleanup(); vi.mocked(composeToAgent).mockClear(); });

const resume = normalizeResume({
  basics: { name: "欧非秀", contacts: [{ label: "电话", value: "138" }] },
  sections: [{ id: "edu", type: "education", title: "教育经历", items: [
    { id: "a", title: "清华大学", subtitle: "公共卫生 · 硕士", date: "2021.09 – 2024.06", text: "GPA 3.87" },
    { id: "b", title: "北京大学", subtitle: "生物科学 · 本科", date: "2017.09 – 2021.06" },
  ] }],
});

function setup(selected = "edu", canPolish = true) {
  const onChange = vi.fn<(next: Resume) => void>();
  render(<ModuleEditor resume={resume} onChange={onChange} selected={selected} doc={{ id: 7, title: "主简历" }} canPolish={canPolish} />);
  return onChange;
}

describe("ModuleEditor", () => {
  it("条目拆成学校 / 专业 / 学历 / 开始 / 结束，改结束时间写回一串 date；清空结束即至今", () => {
    const onChange = setup();
    expect(screen.getByRole("heading", { name: "教育经历 1" })).toBeInTheDocument();
    expect(screen.getAllByLabelText(/^专业/)[0]).toHaveValue("公共卫生");
    const end = screen.getAllByLabelText("结束时间（不填即为：至今）")[0];
    expect(end).toHaveValue("2024-06");
    fireEvent.change(end, { target: { value: "2024-07" } });
    expect(onChange.mock.calls[0][0].sections[0].items[0].date).toBe("2021.09 – 2024.07");
    fireEvent.change(end, { target: { value: "" } });
    expect(onChange.mock.calls[1][0].sections[0].items[0].date).toBe("2021.09 – 至今");
  });

  it("上移 / 下移 / 添加条目", () => {
    const onChange = setup();
    expect(screen.getByRole("button", { name: "上移教育经历 1" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "下移教育经历 1" }));
    expect(onChange.mock.calls[0][0].sections[0].items.map((i) => i.id)).toEqual(["b", "a"]);
    fireEvent.click(screen.getByRole("button", { name: "添加条目" }));
    expect(onChange.mock.calls[1][0].sections[0].items).toHaveLength(3);
  });

  it("AI 润色把这一条交给 Agent，说清是哪份简历哪一条；没存好时不能点", () => {
    setup();
    fireEvent.click(screen.getAllByRole("button", { name: "AI 润色" })[1]);
    const message = vi.mocked(composeToAgent).mock.calls[0][0].message;
    expect(message).toContain("doc #7");
    expect(message).toContain("id 为 b");
    expect(message).toContain("第 2 条（北京大学）");
    cleanup();
    setup("edu", false);
    expect(screen.getAllByRole("button", { name: "AI 润色" })[0]).toBeDisabled();
  });

  it("基础信息：姓名、联系方式增删", () => {
    const onChange = setup("basics");
    fireEvent.change(screen.getByLabelText(/^姓名/), { target: { value: "林同学" } });
    expect(onChange.mock.calls[0][0].basics.name).toBe("林同学");
    fireEvent.click(screen.getByRole("button", { name: "邮箱" }));
    expect(onChange.mock.calls[1][0].basics.contacts.map((c) => c.label)).toEqual(["电话", "邮箱"]);
  });
});
