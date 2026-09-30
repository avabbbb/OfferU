import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  useConnection: vi.fn(), isTauri: vi.fn(), connections: vi.fn(), install: vi.fn(), probe: vi.fn(),
}));
vi.mock("@/lib/agentConnection", () => ({ useAgentConnection: mocks.useConnection, connectionTime: () => "12:00" }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: mocks.isTauri }));
vi.mock("@/lib/api", () => ({ agentRuntimeApi: { connections: mocks.connections, connectIntegration: mocks.install, probeConnection: mocks.probe } }));
vi.mock("@/lib/showcase/router", () => ({ SHOWCASE: false }));

import { AgentConnectionPanel, AgentConnectionStatus } from "./AgentConnectionPanel";
import { OFFERU_MATERIAL_COLLABORATION_PROMPT } from "@/lib/agentConnectionPrompt";

const state = () => ({ open: true, setOpen: vi.fn(), connection: null, reportConnection: vi.fn(), sync: { status: "synced", title: "目标岗位", error: "", confirmedAt: null, version: 3 }, retrySync: vi.fn() });
const host = (updates = {}) => ({ id: "codex", name: "Codex", installed: true, compatible: true, can_install_skill: true, skill_status: "NOT_INSTALLED", connection_verified: false, status: "integration_missing", last_error: "", ...updates });
const snapshot = (updates = {}) => ({ items: [host(updates)], recommended_provider_id: "codex" });

describe("AgentConnectionPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isTauri.mockReturnValue(true);
    mocks.useConnection.mockReturnValue(state());
    mocks.connections.mockResolvedValue(snapshot());
  });

  it("uses Desktop discovery without a copy-prompt or installation-directory flow", () => {
    render(<AgentConnectionPanel />);
    expect(screen.getByRole("button", { name: "发现本机 Agent" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "复制接入提示词" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("接入提示词")).not.toBeInTheDocument();
    expect(mocks.connections).not.toHaveBeenCalled();
    expect(screen.getByText(/内置 Agent 操作 OfferU/)).toBeInTheDocument();
  });

  it("installs through the existing adapter and only displays actual verified readback", async () => {
    const user = userEvent.setup();
    mocks.install.mockResolvedValue(snapshot({ skill_status: "INSTALLED", connection_verified: true, status: "ready" }));
    render(<AgentConnectionPanel />);
    await user.click(screen.getByRole("button", { name: "发现本机 Agent" }));
    expect(await screen.findByText("已发现 Agent，接入尚未完成。")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "连接 Codex" }));
    expect(mocks.install).toHaveBeenCalledWith("codex", "install");
    expect(await screen.findByText(/Agent 已完成真实工具读取/)).toBeInTheDocument();
  });

  it("does not claim installed-only or remotely blocked hosts are ready", async () => {
    const user = userEvent.setup();
    mocks.connections.mockResolvedValue(snapshot({ skill_status: "INSTALLED", status: "check_required" }));
    mocks.probe.mockResolvedValue(snapshot({ skill_status: "INSTALLED", connection_verified: true, status: "blocked", last_error: "模型服务不可用" }));
    render(<AgentConnectionPanel />);
    await user.click(screen.getByRole("button", { name: "发现本机 Agent" }));
    expect(await screen.findByText(/真实连接尚未验证/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "验证连接" }));
    expect(mocks.probe).toHaveBeenCalledWith("codex");
    expect(await screen.findByText("模型服务不可用")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "已验证连接" })).not.toBeInTheDocument();
  });

  it("keeps update separate and reports an installation failure", async () => {
    const user = userEvent.setup();
    mocks.connections.mockResolvedValue(snapshot({ skill_status: "OUTDATED" }));
    mocks.install.mockRejectedValue(new Error("fixture installation failure"));
    render(<AgentConnectionPanel />);
    await user.click(screen.getByRole("button", { name: "发现本机 Agent" }));
    await user.click(await screen.findByRole("button", { name: "更新接入并验证" }));
    expect(mocks.install).toHaveBeenCalledWith("codex", "update");
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "已验证连接" })).not.toBeInTheDocument();
  });

  it("does not scan or install from an ordinary browser", () => {
    mocks.isTauri.mockReturnValue(false);
    render(<AgentConnectionPanel />);
    expect(screen.getByText(/当前网页不会扫描本机/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "发现本机 Agent" })).not.toBeInTheDocument();
    expect(mocks.connections).not.toHaveBeenCalled();
    expect(mocks.install).not.toHaveBeenCalled();
  });

  it("offers material collaboration without claiming a tool connection", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const connection = state();
    mocks.useConnection.mockReturnValue(connection);
    render(<AgentConnectionPanel />);
    await user.click(screen.getByText("我的 Agent 只能聊天，使用材料协作"));
    await user.click(screen.getByRole("button", { name: "复制协作说明" }));
    expect(writeText).toHaveBeenCalledWith(OFFERU_MATERIAL_COLLABORATION_PROMPT);
    expect(connection.reportConnection).not.toHaveBeenCalled();
    expect(await screen.findByText(/当前仍未连接 OfferU/)).toBeInTheDocument();
  });

  it("keeps context synchronization failure distinct from host connection", () => {
    mocks.useConnection.mockReturnValue({ ...state(), sync: { status: "failed", error: "网络中断" } });
    render(<AgentConnectionStatus />);
    expect(screen.getByRole("button", { name: "OfferU 页面同步失败，查看 Agent 接入" })).toBeInTheDocument();
  });
});
