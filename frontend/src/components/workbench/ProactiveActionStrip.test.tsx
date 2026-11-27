import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("@/lib/core", () => ({
  write: vi.fn().mockResolvedValue({ change_id: 1 }),
}));

vi.mock("@/lib/agentCompose", () => ({
  composeToAgent: vi.fn(),
}));

import { write } from "@/lib/core";
import { composeToAgent } from "@/lib/agentCompose";
import type { ProactiveAction } from "@/lib/api";
import { ProactiveActionStrip } from "./ProactiveActionStrip";

const ACTIONS: ProactiveAction[] = [
  {
    id: "unconfirmed_memories:2",
    kind: "unconfirmed_memories",
    priority: "high",
    title: "2 条职业记忆待确认",
    reason: "确认后才会进入定制简历",
    button_label: "全部确认",
    prompt: "核对记忆",
    route: "/profile",
    record_ids: [2, 3],
    direct_action: "confirm_memories",
  },
  {
    id: "tailor_top_job:9",
    kind: "tailor_top_job",
    priority: "normal",
    title: "为「飞书 · AI 产品」定制简历",
    reason: "匹配度 88 分，还没有定制简历",
    button_label: "定制简历",
    prompt: "帮我定制岗位 #9 的简历",
    route: "/jobs/9",
    job_id: 9,
  },
];

describe("ProactiveActionStrip", () => {
  beforeEach(() => {
    vi.mocked(write).mockClear();
    vi.mocked(composeToAgent).mockClear();
  });
  afterEach(cleanup);

  it("confirms all pending memories in one tap and dispatches scoped job prompts to Agent", async () => {
    render(
      <MemoryRouter>
        <ProactiveActionStrip initialActions={ACTIONS} />
      </MemoryRouter>,
    );

    expect(screen.getByText("2 条职业记忆待确认")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "全部确认" }));
    await waitFor(() => expect(write).toHaveBeenCalledTimes(2));
    expect(write).toHaveBeenCalledWith("save", { type: "memory", id: 2, data: { confirmed: true } });
    expect(write).toHaveBeenCalledWith("save", { type: "memory", id: 3, data: { confirmed: true } });
    expect(await screen.findByText(/已确认 2 条记忆生效/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "定制简历" }));
    expect(composeToAgent).toHaveBeenCalledWith({ message: "帮我定制岗位 #9 的简历", jobId: 9 });
  });
});
