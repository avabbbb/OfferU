import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentConnection } from "@/lib/api";

const { mockUseAgentConnection } = vi.hoisted(() => ({
  mockUseAgentConnection: vi.fn(),
}));

vi.mock("@/lib/agentConnection", () => ({
  useAgentConnection: mockUseAgentConnection,
  connectionTime: (value?: string | null) => value || "-",
}));

vi.mock("@/lib/showcase/router", () => ({ SHOWCASE: false }));

import { AgentConnectionPanel } from "./AgentConnectionPanel";

function makeConnection(overrides: Partial<AgentConnection> = {}): AgentConnection {
  return {
    id: "codex",
    name: "Codex CLI",
    installed: true,
    compatible: true,
    version: "1.2.3",
    status: "check_required",
    authenticated: true,
    connection_verified: false,
    integration_status: "OK",
    skill_status: "INSTALLED",
    skill_version: "0.9",
    skill_hash: "abc",
    expected_skill_version: "0.9",
    expected_skill_hash: "abc",
    can_install_skill: true,
    can_live_verify_skill: true,
    auth_mode: "native",
    checked_at: new Date().toISOString(),
    detected_at: new Date().toISOString(),
    last_error: "",
    provider_checked_at: null,
    docs_url: "https://example.com/docs",
    can_verify_login: true,
    live_model_verified: false,
    native_auth_state: "OK",
    live_model_state: "NOT_VERIFIED",
    structured_output_state: "SUPPORTED",
    streaming_state: "SUPPORTED",
    resume_state: "SUPPORTED",
    cancel_state: "SUPPORTED",
    cwd_isolation_state: "SUPPORTED",
    web_search_state: "NOT_VERIFIED",
    conformance_checked_at: null,
    beginner: true,
    recommended: true,
    ...overrides,
  };
}

function makeState(overrides: Record<string, unknown> = {}) {
  return {
    snapshot: { items: [] as AgentConnection[], checked_at: new Date().toISOString(), connect_prompt: "" },
    loading: false,
    refreshing: false,
    error: "",
    stale: false,
    offline: false,
    open: true,
    setOpen: vi.fn(),
    probing: null as string | null,
    integrating: null as string | null,
    probe: vi.fn(async () => {}),
    connect: vi.fn(async () => {}),
    refresh: vi.fn(),
    sync: { status: "idle", title: "", error: "", confirmedAt: null, version: null },
    retrySync: vi.fn(),
    activity: [],
    ...overrides,
  };
}

describe("AgentConnectionPanel", () => {
  beforeEach(() => {
    mockUseAgentConnection.mockReset();
  });

  it("verified 状态对用户显示「已验证」并允许重新验证", () => {
    mockUseAgentConnection.mockReturnValue(
      makeState({
        snapshot: {
          items: [makeConnection({ status: "ready", connection_verified: true })],
          checked_at: new Date().toISOString(),
          connect_prompt: "",
        },
        sync: { status: "synced", title: "岗位页", error: "", confirmedAt: new Date().toISOString(), version: 3 },
      }),
    );
    render(<AgentConnectionPanel />);
    expect(screen.getAllByText("已验证").length).toBeGreaterThan(0);
    expect(screen.getByText("OfferU 已准备好")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新验证" })).toBeInTheDocument();
  });

  it("blocked 状态展示原因与可操作的修复路径", () => {
    mockUseAgentConnection.mockReturnValue(
      makeState({
        snapshot: {
          items: [makeConnection({ status: "blocked", last_error: "Provider 响应超时" })],
          checked_at: new Date().toISOString(),
          connect_prompt: "",
        },
      }),
    );
    render(<AgentConnectionPanel />);
    expect(screen.getAllByText("需要处理").length).toBeGreaterThan(0);
    expect(screen.getByText("上次任务遇到了连接问题")).toBeInTheDocument();
    // 错误原因必须可见，用户才知道修什么
    expect(screen.getByText("Provider 响应超时")).toBeInTheDocument();
    // 操作入口：重新验证接入
    expect(screen.getByRole("button", { name: "验证接入" })).toBeInTheDocument();
  });

  it("同步失败时展示失败状态并提供重试", async () => {
    const retrySync = vi.fn();
    mockUseAgentConnection.mockReturnValue(
      makeState({
        snapshot: {
          items: [makeConnection({ status: "ready", connection_verified: true })],
          checked_at: new Date().toISOString(),
          connect_prompt: "",
        },
        sync: { status: "failed", title: "岗位页", error: "网络中断", confirmedAt: null, version: null },
        retrySync,
      }),
    );
    render(<AgentConnectionPanel />);
    expect(screen.getByText("同步失败")).toBeInTheDocument();
    expect(screen.getByText("网络中断")).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /重试同步/ }));
    await waitFor(() => expect(retrySync).toHaveBeenCalledTimes(1));
  });
});
