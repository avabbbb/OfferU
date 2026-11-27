import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mutateMock = vi.fn().mockResolvedValue(undefined);

vi.mock("@/lib/core", () => ({
  MEMORY_KIND: { education: "教育", experience: "实习 / 工作", project: "项目", skill: "技能", preference: "偏好", award: "奖项", note: "其他" },
  useTool: vi.fn(() => ({
    data: {
      items: [
        { id: 2, type: "memory", kind: "project", title: "AgentOS 研发", body: "首字等待缩短 17%", confirmed: false },
        { id: 5, type: "memory", kind: "preference", title: "目标城市", body: "深圳 / 杭州", confirmed: true },
        { id: 6, type: "memory", kind: "skill", title: "评测能力", body: "Benchmark 与 Rubric", confirmed: true },
      ],
    },
    mutate: mutateMock,
  })),
  write: vi.fn().mockResolvedValue({ change_id: 9 }),
}));

import { write } from "@/lib/core";
import { AgentMemoryDialog } from "./AgentMemoryDialog";

describe("AgentMemoryDialog", () => {
  beforeEach(() => {
    vi.mocked(write).mockClear();
    mutateMock.mockClear();
  });
  afterEach(cleanup);

  it("confirms pending memories, adds a new preference rule, and forgets a memory", async () => {
    render(<AgentMemoryDialog open onOpenChange={() => undefined} />);

    expect(screen.getByText("AgentOS 研发")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "全部确认" }));
    await waitFor(() => expect(write).toHaveBeenCalledWith("save", { type: "memory", id: 2, data: { confirmed: true } }));

    fireEvent.click(screen.getByRole("button", { name: "记住一条偏好" }));
    fireEvent.change(screen.getByLabelText("偏好主题"), { target: { value: "不看外包" } });
    fireEvent.change(screen.getByLabelText("具体规则（可选）"), { target: { value: "只看自研 AI 团队" } });
    fireEvent.click(screen.getByRole("button", { name: "记住" }));
    await waitFor(() => expect(write).toHaveBeenCalledWith("save", {
      type: "memory",
      data: { kind: "preference", title: "不看外包", body: "只看自研 AI 团队" },
    }));

    fireEvent.click(screen.getByRole("button", { name: "忘记 评测能力" }));
    await waitFor(() => expect(write).toHaveBeenCalledWith("delete", { type: "memory", id: 6 }));
  });
});
