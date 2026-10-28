import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  agentBoardApi: { list: vi.fn(), launch: vi.fn() },
}));

import { agentBoardApi, type AgentBoardRow, type AgentBoardSnapshot } from "@/lib/api";
import { OFFERU_AGENT_CONNECT_PROMPT } from "@/lib/agentConnectionPrompt";
import { AgentBoard, AgentConnectPrompt } from "./AgentBoard";

const list = vi.mocked(agentBoardApi.list);
const launch = vi.mocked(agentBoardApi.launch);

const row = (id: string, extra: Partial<AgentBoardRow>): AgentBoardRow => ({
  id, display_name: id, custom: false, hidden: false, executable_found: true, skill_status: "INSTALLED",
  running: false, connected: false, last_call: {}, skill_path: "/home/u/." + id + "/skills/offeru", error: "",
  memory_status: "none", memory: {}, last_check: {}, executable: "", memory_file: "", docs_url: "", ...extra,
});

const SNAPSHOT: AgentBoardSnapshot = {
  live_window_seconds: 600,
  agents: [
    row("Alpha", { running: true, connected: true, last_call: { at: "2026-10-28T14:00:00+00:00", client: "codex-mcp-client" } }),
    row("Beta", { running: true, skill_status: "OUTDATED" }),
    row("Gamma", { hidden: true, running: true, connected: true, skill_status: "ERROR" }),
  ],
};

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

describe("AgentBoard", () => {
  beforeEach(() => {
    list.mockReset(); list.mockResolvedValue(SNAPSHOT);
    launch.mockReset(); launch.mockResolvedValue({ launched: true, executable: "/opt/bin/alpha" });
  });
  afterEach(cleanup);

  it("derives the summary from the rows it shows, leaving hidden rows out", async () => {
    render(<AgentBoard />);
    expect(await screen.findByText("在线 1 · 运行中 2 · Skill 已安装 1 · 需处理 1")).toBeTruthy();
    expect(screen.getByTestId("agent-board-row-Alpha").textContent).toContain("在线");
    expect(screen.getByTestId("agent-board-row-Beta").textContent).toContain("运行中 · 未调用 OfferU");
    expect(screen.queryByTestId("agent-board-row-Gamma")).toBeNull();
  });

  it("opens the Agent conversation through the launch API", async () => {
    render(<AgentBoard />);
    await screen.findByTestId("agent-board-row-Alpha");
    fireEvent.click(screen.getAllByRole("button", { name: "打开对话" })[0]);
    await waitFor(() => expect(launch).toHaveBeenCalledWith("Alpha"));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  });

  it("shows an error when the board cannot be read", async () => {
    list.mockRejectedValue(new Error("offline"));
    render(<AgentBoard />);
    expect((await screen.findByRole("alert")).textContent).toContain("offline");
  });
});
