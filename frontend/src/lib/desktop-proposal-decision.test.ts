import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, isTauri } = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke, isTauri }));

import {
  decideAgentRuntimeActionInDesktop,
  decideProposalInDesktop,
} from "./desktop-proposal-decision";

describe("desktop proposal decisions", () => {
  beforeEach(() => {
    invoke.mockReset();
    isTauri.mockReset();
    isTauri.mockReturnValue(true);
  });

  it("sends the exact decision through the native desktop command", async () => {
    invoke.mockResolvedValue({ approved: true, completed: true });

    await expect(
      decideProposalInDesktop("run-42", "update-job:1", true),
    ).resolves.toEqual({ approved: true, completed: true });
    expect(invoke).toHaveBeenCalledWith("decide_agent_proposal", {
      runId: "run-42",
      actionId: "update-job:1",
      approve: true,
    });
  });

  it("does not submit decisions from the browser-only UI", async () => {
    isTauri.mockReturnValue(false);

    await expect(
      decideProposalInDesktop("run-42", "update-job:1", true),
    ).rejects.toThrow("请在 OfferU 桌面应用中确认 Agent 提案");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("routes built-in Agent decisions through the same native authority", async () => {
    invoke.mockResolvedValue({ ok: true });

    await expect(
      decideAgentRuntimeActionInDesktop("run-42", "update-job:1", false),
    ).resolves.toEqual({ ok: true });
    expect(invoke).toHaveBeenCalledWith("decide_agent_runtime_action", {
      runId: "run-42",
      actionId: "update-job:1",
      approve: false,
    });
  });
});
