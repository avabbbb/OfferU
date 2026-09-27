import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockUseAgentConnection } = vi.hoisted(() => ({
  mockUseAgentConnection: vi.fn(),
}));

vi.mock("@/lib/agentConnection", () => ({
  useAgentConnection: mockUseAgentConnection,
  connectionTime: (value?: string | null) => value || "-",
}));

vi.mock("@/lib/showcase/router", () => ({ SHOWCASE: false }));

import { AgentConnectionPanel, AgentConnectionStatus } from "./AgentConnectionPanel";
import { OFFERU_CONNECT_PROMPT } from "@/lib/agentConnectionPrompt";

function makeState(overrides: Record<string, unknown> = {}) {
  return {
    open: true,
    setOpen: vi.fn(),
    promptCopied: false,
    markPromptCopied: vi.fn(),
    sync: { status: "synced", title: "目标岗位", error: "", confirmedAt: new Date().toISOString(), version: 3 },
    retrySync: vi.fn(),
    ...overrides,
  };
}

describe("AgentConnectionPanel", () => {
  beforeEach(() => {
    mockUseAgentConnection.mockReset();
  });

  it("shows one generic connection prompt without a provider picker", () => {
    mockUseAgentConnection.mockReturnValue(makeState());
    render(<AgentConnectionPanel />);

    expect(screen.getByRole("button", { name: "复制接入提示词" })).toBeInTheDocument();
    expect(screen.getByLabelText("接入提示词")).toHaveValue(OFFERU_CONNECT_PROMPT);
    expect(screen.getByText(/从 GitHub 获取官方 OfferU Skill/)).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "本机 Agent 列表" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Codex|Claude Code|OpenCode|Pi Agent|WorkBuddy|CodeBuddy|Gemini|OMP/)).not.toBeInTheDocument();
    expect(OFFERU_CONNECT_PROMPT).toContain("https://raw.githubusercontent.com/avabbbb/OfferU/main/.agents/skills/offeru/SKILL.md");
    expect(OFFERU_CONNECT_PROMPT).not.toContain("http://127.0.0.1:8766");
    expect(screen.getByText(/只代表提示词已准备好，不代表 Agent 已连接/)).toBeInTheDocument();
  });

  it("labels page-context sync failures as OfferU sync failures, not Agent connection failures", () => {
    mockUseAgentConnection.mockReturnValue(makeState({
      sync: { status: "failed", title: "目标岗位", error: "网络中断", confirmedAt: null, version: null },
    }));
    render(<AgentConnectionStatus />);

    expect(screen.getByRole("button", { name: "OfferU 页面同步失败，查看接入提示词" })).toBeInTheDocument();
  });

  it("copies the prompt and reports the next step without claiming connection success", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const state = makeState();
    mockUseAgentConnection.mockReturnValue(state);
    render(<AgentConnectionPanel />);

    await user.click(screen.getByRole("button", { name: "复制接入提示词" }));

    expect(writeText).toHaveBeenCalledWith(OFFERU_CONNECT_PROMPT);
    expect(state.markPromptCopied).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("现在切换到你的本地 Agent，粘贴并发送。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "已复制接入提示词" })).toBeInTheDocument();
  });

  it("shows a selectable manual fallback when clipboard access fails", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockRejectedValue(new Error("clipboard denied"));
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const state = makeState();
    mockUseAgentConnection.mockReturnValue(state);
    render(<AgentConnectionPanel />);

    await user.click(screen.getByRole("button", { name: "复制接入提示词" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("自动复制失败");
    expect(screen.getByLabelText("接入提示词")).toHaveValue(OFFERU_CONNECT_PROMPT);
    expect(state.markPromptCopied).not.toHaveBeenCalled();
  });
});
