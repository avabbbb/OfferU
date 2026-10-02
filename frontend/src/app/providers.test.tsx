import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BackendReadyGate } from "./providers";

const mocks = vi.hoisted(() => ({ isTauri: vi.fn(), invoke: vi.fn(), fetch: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ isTauri: mocks.isTauri, invoke: mocks.invoke }));
vi.mock("@nextui-org/react", () => ({ NextUIProvider: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("swr", () => ({ SWRConfig: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("@/lib/showcase/router", () => ({ SHOWCASE: false }));

import type { DesktopRuntimeIdentity } from "@/lib/runtimeIdentityApi";

const expected: DesktopRuntimeIdentity = {
  runtime_instance_id: "4cb704f3-df88-4fbf-9e8c-1a10ef96ea7d",
  version: "0.4.0",
  commit: "a".repeat(40),
  build_timestamp: null,
  dirty: true,
  source_fingerprint: null,
  data_root: "C:\\Users\\ava\\AppData\\Local\\OfferU",
  runtime_type: "local",
};

function matchingHealth() {
  return {
    status: "ok",
    service: "OfferU",
    runtime: "python",
    build_mode: "local-development",
    runtime_mode: expected.runtime_type,
    version: expected.version,
    runtime_instance_id: expected.runtime_instance_id,
    build_identity: {
      ...expected,
      runtime_instance_id: undefined,
      data_root: "c:/users/ava/AppData/Local/OfferU/",
      build_source: "source",
    },
  };
}

describe("BackendReadyGate desktop identity check", () => {
  beforeEach(() => {
    mocks.isTauri.mockReset().mockReturnValue(true);
    mocks.invoke.mockReset().mockResolvedValue(expected);
    mocks.fetch.mockReset().mockResolvedValue({ ok: true, json: async () => matchingHealth() });
    vi.stubGlobal("fetch", mocks.fetch);
  });

  it("mounts the app for the native-owned runtime instance", async () => {
    render(<BackendReadyGate><div>ready child</div></BackendReadyGate>);

    expect(await screen.findByText("ready child")).toBeTruthy();
    expect(mocks.invoke).toHaveBeenCalledWith("get_desktop_runtime_identity");
  });

  it("keeps the app gated when a same-version old service answers on the port", async () => {
    mocks.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ...matchingHealth(),
        runtime_instance_id: "cc6de107-688d-4b09-a0c4-859019b4ff05",
      }),
    });
    render(<BackendReadyGate><div>ready child</div></BackendReadyGate>);

    await waitFor(() => expect(screen.getByTestId("backend-ready-gate").getAttribute("data-readiness-state")).toBe("identity-mismatch"));
    expect(screen.queryByText("ready child")).toBeNull();
  });

  it("fails closed when health is legacy and has no runtime identity", async () => {
    mocks.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: "ok", service: "OfferU", runtime: "python", version: "0.4.0" }),
    });
    render(<BackendReadyGate><div>ready child</div></BackendReadyGate>);

    await waitFor(() => expect(screen.getByTestId("backend-ready-gate").getAttribute("data-readiness-state")).toBe("identity-mismatch"));
    expect(screen.queryByText("ready child")).toBeNull();
  });

  it("does not mount the app when native expected identity is unavailable", async () => {
    mocks.invoke.mockResolvedValueOnce(null);
    render(<BackendReadyGate><div>ready child</div></BackendReadyGate>);

    await waitFor(() => expect(screen.getByTestId("backend-ready-gate").getAttribute("data-readiness-state")).toBe("native-identity-unavailable"));
    expect(screen.queryByText("ready child")).toBeNull();
  });
});
