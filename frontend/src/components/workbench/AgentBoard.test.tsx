import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  agentBoardApi: { list: vi.fn() },
}));

import { agentBoardApi } from "@/lib/api";
import { OFFERU_AGENT_CONNECT_PROMPT } from "@/lib/agentConnectionPrompt";
import { AgentBoardEntry, AgentConnectPrompt } from "./AgentBoard";

const list = vi.mocked(agentBoardApi.list);
const SNAPSHOT = { agents: [], summary: { connected: 1, needs_attention: 2, detected: 3 } } as never;

describe("AgentConnectPrompt", () => {
  let writeText: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  });
  afterEach(cleanup);

  it("copies the self-routing connect prompt", async () => {
    render(<AgentConnectPrompt />);
    fireEvent.click(screen.getByRole("button", { name: "复制提示词" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(OFFERU_AGENT_CONNECT_PROMPT));
    expect(await screen.findByText("已复制，去 Agent 里粘贴")).toBeTruthy();
  });

  it("asks for manual copy when the clipboard fails", async () => {
    writeText.mockRejectedValueOnce(new Error("denied"));
    render(<AgentConnectPrompt />);
    fireEvent.click(screen.getByRole("button", { name: "复制提示词" }));
    expect((await screen.findByRole("alert")).textContent).toContain("手动复制");
  });
});

describe("AgentBoardEntry", () => {
  beforeEach(() => { list.mockReset(); list.mockResolvedValue(SNAPSHOT); });
  afterEach(cleanup);

  it("shows the board summary on the entry row", async () => {
    render(<AgentBoardEntry />);
    expect(await screen.findByText("已接入 1 · 需处理 2 · 本机检测到 3")).toBeTruthy();
  });

  it("opens a dialog with the copy prompt and the board", async () => {
    render(<AgentBoardEntry />);
    fireEvent.click(screen.getByRole("button", { name: "打开 Agent 看板" }));
    const dialog = await screen.findByTestId("agent-board-dialog");
    expect(within(dialog).getByTestId("agent-connect-prompt")).toBeTruthy();
    expect(within(dialog).getByTestId("agent-board")).toBeTruthy();
  });

  it("falls back to the hint when the board cannot be read", async () => {
    list.mockRejectedValue(new Error("offline"));
    render(<AgentBoardEntry />);
    expect(await screen.findByText(/一键复制接入提示词/)).toBeTruthy();
  });
});
