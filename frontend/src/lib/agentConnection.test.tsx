import { render, waitFor, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

interface AckResponse {
  ok: boolean;
  outputs: { version: number; route: string; entity_id: string };
}

const { mockSyncContext, mockConnections, mockUseWorkbench, mockUsePathname } = vi.hoisted(() => ({
  mockSyncContext: vi.fn<(body: Record<string, unknown>, signal: AbortSignal) => Promise<AckResponse>>(),
  mockConnections: vi.fn<() => Promise<unknown>>(),
  mockUseWorkbench: vi.fn(),
  mockUsePathname: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  agentRuntimeApi: {
    connections: mockConnections,
    syncContext: mockSyncContext,
    probeConnection: vi.fn(),
    connectIntegration: vi.fn(),
  },
}));

vi.mock("../lib/showcase/router", () => ({ SHOWCASE: false }));
vi.mock("../lib/workbench", () => ({ useWorkbench: mockUseWorkbench }));
vi.mock("next/navigation", () => ({ usePathname: mockUsePathname }));

import { AgentConnectionProvider } from "../lib/agentConnection";

function ack(route: string, entityId: string, version = 1): AckResponse {
  return { ok: true, outputs: { version, route, entity_id: entityId } };
}

describe("AgentContextWriter", () => {
  beforeEach(() => {
    mockSyncContext.mockReset();
    mockConnections.mockReset().mockResolvedValue({ items: [], checked_at: new Date().toISOString() });
    mockUsePathname.mockReturnValue("/jobs/458");
    mockUseWorkbench.mockReturnValue({ selection: null });
  });

  function renderProvider() {
    return render(<AgentConnectionProvider>{null}</AgentConnectionProvider>);
  }

  it("serializes concurrent writes so the last intent wins", async () => {
    const first = Promise.withResolvers<AckResponse>();
    const second = Promise.withResolvers<AckResponse>();
    mockSyncContext
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const { rerender } = renderProvider();
    // Let the 250ms debounce fire so writer 1 (route entity) goes in-flight.
    await act(async () => { await new Promise((r) => setTimeout(r, 400)); });
    expect(mockSyncContext).toHaveBeenCalledTimes(1);

    // Selection lands — queues writer 2, which must wait for writer 1.
    mockUseWorkbench.mockReturnValue({
      selection: { kind: "job", id: "sel-abc", title: "字节跳动 · 后端工程师" },
    });
    rerender(<AgentConnectionProvider>{null}</AgentConnectionProvider>);
    await act(async () => { await new Promise((r) => setTimeout(r, 400)); });

    // Writer 1 is still in-flight (we never resolved it). Only after it
    // resolves can writer 2 fire — that is the serialization guarantee.
    expect(mockSyncContext).toHaveBeenCalledTimes(1);
    first.resolve(ack("/jobs/458", "458", 1));
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(mockSyncContext).toHaveBeenCalledTimes(2);
    second.resolve(ack("/jobs/458", "sel-abc", 2));
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });

    const secondBody = mockSyncContext.mock.calls[1][0];
    expect(secondBody.entity_id).toBe("sel-abc");
    expect(secondBody.entity_type).toBe("job");
  });

  it("empty selection cannot erase a valid route entity", async () => {
    mockSyncContext.mockResolvedValue(ack("/jobs/458", "458", 1));
    renderProvider();
    await act(async () => { await new Promise((r) => setTimeout(r, 400)); });
    const body = mockSyncContext.mock.calls[0][0];
    expect(body.entity_id).toBe("458");
    expect(body.entity_type).toBe("job");
  });
});
