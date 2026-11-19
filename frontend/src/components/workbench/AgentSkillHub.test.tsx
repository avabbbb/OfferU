import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AgentSkillCatalog } from "@/lib/api";
import { AgentSkillHub, filterSkills } from "./AgentSkillHub";

const CATALOG: AgentSkillCatalog = {
  skills: [
    { id: "interview-practice", title: "模拟面试与面试准备", when: "模拟面试、押题", keywords: ["模拟面试", "押题"], body: "- 一次只问一个问题", example: "给我来一场模拟面试" },
    { id: "email-writing", title: "投递邮件与网申回答", when: "写投递邮件", keywords: ["邮件", "网申"], body: "- 只写草稿", example: "帮我写投递邮件" },
  ],
  sandbox: { modes: ["read_only", "workspace_write"], default: "workspace_write", read_only_tools: ["search"] },
};

afterEach(cleanup);

describe("filterSkills", () => {
  it("matches title, keywords and body", () => {
    expect(filterSkills(CATALOG.skills, "").map((skill) => skill.id)).toHaveLength(2);
    expect(filterSkills(CATALOG.skills, "网申").map((skill) => skill.id)).toEqual(["email-writing"]);
    expect(filterSkills(CATALOG.skills, "一个问题").map((skill) => skill.id)).toEqual(["interview-practice"]);
    expect(filterSkills(CATALOG.skills, "nothing")).toEqual([]);
  });
});

describe("AgentSkillHub", () => {
  it("lists skills with trigger keywords, expands the method, and fills the composer with an example", async () => {
    const onTry = vi.fn();
    const onOpenChange = vi.fn();
    render(<AgentSkillHub open onOpenChange={onOpenChange} sandbox="workspace_write" onSandboxChange={() => {}} onTry={onTry} load={() => Promise.resolve(CATALOG)} />);
    await waitFor(() => expect(screen.getAllByTestId("agent-skill-item")).toHaveLength(2));
    expect(screen.getByText("模拟面试与面试准备")).toBeTruthy();
    expect(screen.getAllByText("押题").length).toBeGreaterThan(0);
    expect(screen.queryByTestId("agent-skill-body")).toBeNull();
    fireEvent.click(screen.getByText("模拟面试与面试准备"));
    expect(screen.getByTestId("agent-skill-body").textContent).toContain("一次只问一个问题");
    fireEvent.change(screen.getByLabelText("搜技能"), { target: { value: "网申" } });
    expect(screen.getAllByTestId("agent-skill-item")).toHaveLength(1);
    fireEvent.click(screen.getByTestId("agent-skill-try"));
    expect(onTry).toHaveBeenCalledWith("帮我写投递邮件");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("switches the sandbox", async () => {
    const onSandboxChange = vi.fn();
    const { rerender } = render(<AgentSkillHub open onOpenChange={() => {}} sandbox="workspace_write" onSandboxChange={onSandboxChange} onTry={() => {}} load={() => Promise.resolve(CATALOG)} />);
    expect(screen.getByTestId("agent-sandbox-write").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByTestId("agent-sandbox-readonly"));
    expect(onSandboxChange).toHaveBeenCalledWith("read_only");
    rerender(<AgentSkillHub open onOpenChange={() => {}} sandbox="read_only" onSandboxChange={onSandboxChange} onTry={() => {}} load={() => Promise.resolve(CATALOG)} />);
    expect(screen.getByTestId("agent-sandbox-readonly").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText(/写文档都会被拦下/)).toBeTruthy();
    await waitFor(() => expect(screen.getAllByTestId("agent-skill-item")).toHaveLength(2));
  });

  it("shows a load failure", async () => {
    render(<AgentSkillHub open onOpenChange={() => {}} sandbox="workspace_write" onSandboxChange={() => {}} onTry={() => {}} load={() => Promise.reject(new Error("服务没启动"))} />);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("服务没启动"));
  });
});
