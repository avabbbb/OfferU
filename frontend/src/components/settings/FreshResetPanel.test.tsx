import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  status: vi.fn(),
  listBackups: vi.fn(),
  runs: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  getRuntimeIdentity: vi.fn(),
  isDesktopRuntime: vi.fn(),
  mutate: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  request: mocks.request,
  dataSafetyApi: { status: mocks.status, listBackups: mocks.listBackups },
  agentRuntimeApi: { runs: mocks.runs, confirm: mocks.approve, reject: mocks.reject },
}));
vi.mock("@/lib/runtimeIdentityApi", () => ({
  getRuntimeIdentity: mocks.getRuntimeIdentity,
  isDesktopRuntime: mocks.isDesktopRuntime,
}));
vi.mock("@/lib/apiBase", () => ({ resolveApiBase: () => "http://127.0.0.1:8766" }));
vi.mock("swr", () => ({ useSWRConfig: () => ({ mutate: mocks.mutate }) }));
vi.mock("@/lib/showcase/router", () => ({ SHOWCASE: false }));

import { FreshResetPanel } from "./FreshResetPanel";

const proposal = {
  runId: "run_0123456789abcdef",
  actionId: "reset_local_business_data:1",
  summary: "清空本地 OfferU 职业数据",
};

describe("FreshResetPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mocks.isDesktopRuntime.mockReturnValue(true);
    mocks.getRuntimeIdentity.mockResolvedValue({
      data_root: "H:\\OfferUData",
      build_source: "package",
      runtime_type: "desktop-sidecar",
    });
    mocks.status.mockResolvedValue({
      database: { exists: true, filename: "djm.db" },
      backup_count: 1,
      invalid_backup_count: 0,
      pending_restore: null,
      storage_mode: "managed_local",
    });
    mocks.runs.mockResolvedValue({ runs: [] });
    mocks.listBackups.mockResolvedValue({ items: [], invalid: [] });
  });

  it("creates a persisted proposal, then uses Desktop approval and clears only OfferU onboarding state", async () => {
    const user = userEvent.setup();
    const sync = vi.fn();
    window.addEventListener("offeru_onboarding_sync", sync);
    localStorage.setItem("offeru_onboarding", '{"wizardCompleted":true}');
    localStorage.setItem("offeru_showcase_llm_key", "keep-key");
    localStorage.setItem("other-app-state", "keep-state");
    mocks.request.mockResolvedValue({
      executed: false,
      requires_confirmation: true,
      proposal: { run_id: proposal.runId, action_id: proposal.actionId, operation: "reset_local_business_data", status: "waiting_confirmation" },
    });
    mocks.approve.mockResolvedValue({
      ok: true,
      run: {
        steps: [{
          id: proposal.actionId,
          status: "completed",
          result: { outputs: { backup: { backup_id: "b".repeat(32) } } },
        }],
      },
      tool_calls: [],
    });
    mocks.listBackups.mockResolvedValue({
      items: [{ backup_id: "b".repeat(32), reason: "pre_reset" }],
      invalid: [],
    });

    render(<FreshResetPanel />);
    expect(await screen.findByText("H:\\OfferUData")).toBeInTheDocument();
    await user.type(screen.getByRole("textbox"), "全清并重新开始");
    await user.click(screen.getByRole("button", { name: "继续，进入确认" }));
    expect(mocks.request).toHaveBeenCalledWith(
      "/api/agent/data/fresh-reset/proposal",
      { method: "POST" },
    );
    expect(mocks.approve).not.toHaveBeenCalled();

    await user.click(await screen.findByRole("button", { name: "确认清空并重新开始" }));
    await waitFor(() => expect(mocks.approve).toHaveBeenCalledWith(proposal.runId, proposal.actionId));
    expect(localStorage.getItem("offeru_onboarding")).toBeNull();
    expect(localStorage.getItem("offeru_showcase_llm_key")).toBe("keep-key");
    expect(localStorage.getItem("other-app-state")).toBe("keep-state");
    expect(sync).toHaveBeenCalledTimes(1);
    expect(await screen.findByTestId("fresh-reset-backup-id")).toHaveTextContent("b".repeat(32));
    expect(screen.getByRole("button", { name: "返回 Today，开始首次建档" })).toBeInTheDocument();
    expect(mocks.mutate).toHaveBeenCalledWith(expect.any(Function));

    window.removeEventListener("offeru_onboarding_sync", sync);
  });

  it("blocks proposal creation outside Desktop or when the active data root is unknown", async () => {
    const user = userEvent.setup();
    mocks.isDesktopRuntime.mockReturnValue(false);
    mocks.getRuntimeIdentity.mockResolvedValue({ data_root: null, build_source: "unknown", runtime_type: "local" });
    render(<FreshResetPanel />);
    const input = await screen.findByRole("textbox");
    await user.type(input, "全清并重新开始");
    expect(screen.getByRole("button", { name: "继续，进入确认" })).toBeDisabled();
    expect(screen.getByText(/当前网页不会执行清理/)).toBeInTheDocument();
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("rejects a pending proposal through the same independent Desktop decision surface", async () => {
    const user = userEvent.setup();
    mocks.runs.mockResolvedValue({
      runs: [{
        id: proposal.runId,
        status: "waiting_confirmation",
        steps: [{ id: proposal.actionId, tool: "reset_local_business_data", status: "waiting_confirmation", summary: proposal.summary }],
      }],
    });
    mocks.reject.mockResolvedValue({
      ok: true,
      run: { steps: [{ id: proposal.actionId, status: "rejected" }] },
    });
    render(<FreshResetPanel />);
    await screen.findByTestId("fresh-reset-pending-proposal");
    await user.click(screen.getByRole("button", { name: "取消并保留数据" }));
    await waitFor(() => expect(mocks.reject).toHaveBeenCalledWith(proposal.runId, proposal.actionId));
    expect(mocks.request).not.toHaveBeenCalled();
  });
});
