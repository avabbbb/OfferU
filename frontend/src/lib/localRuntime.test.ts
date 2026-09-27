import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./showcase/router", () => ({ SHOWCASE: true }));
vi.mock("./apiBase", () => ({ resolveApiBase: () => "http://127.0.0.1:8766" }));

import {
  getLocalRuntimeSnapshot,
  isDemoRuntime,
  isLocalRuntimeSelected,
  probeLocalRuntime,
  selectDemoRuntime,
  selectLocalRuntime,
  useLocalRuntime,
} from "./localRuntime";

const offeruHealth = {
  status: "ok",
  service: "OfferU",
  runtime: "python",
  version: "0.4.0",
  build_mode: "release",
};

function mockHealth(payload: unknown = offeruHealth, status = 200) {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("localRuntime", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    localStorage.clear();
    selectDemoRuntime();
  });

  it("keeps showcase in demo until the current page verifies a remembered or explicit connection", () => {
    expect(isDemoRuntime()).toBe(true);
    expect(isLocalRuntimeSelected()).toBe(false);
    expect(getLocalRuntimeSnapshot()).toMatchObject({ selected: false, connected: false, probing: false });
  });

  it("selects the single local runtime only after OfferU health identity passes", async () => {
    const fetchMock = mockHealth();

    const result = await selectLocalRuntime();

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8766/api/health",
      expect.objectContaining({
        mode: "cors",
        credentials: "omit",
        targetAddressSpace: "loopback",
        cache: "no-store",
        redirect: "error",
      }),
    );
    expect(isLocalRuntimeSelected()).toBe(true);
    expect(isDemoRuntime()).toBe(false);
    expect(getLocalRuntimeSnapshot()).toMatchObject({ selected: true, connected: true, probing: false, error: "" });
  });

  it("does not select local runtime from status=ok without both OfferU identity fields", async () => {
    for (const payload of [
      { status: "ok" },
      { status: "ok", service: "OfferU", runtime: "node" },
      { status: "degraded", service: "OfferU", runtime: "python" },
    ]) {
      localStorage.clear();
      selectDemoRuntime();
      mockHealth(payload);

      const result = await selectLocalRuntime();

      expect(result.ok).toBe(false);
      expect(isLocalRuntimeSelected()).toBe(false);
      expect(isDemoRuntime()).toBe(true);
      expect(localStorage.getItem("offeru.web.runtime")).toBeNull();
    }
  });

  it("rejects a local OfferU runtime with a different app version", async () => {
    mockHealth({ ...offeruHealth, version: "0.3.9" });

    const result = await selectLocalRuntime();

    expect(result.ok).toBe(false);
    expect(result.error).toContain("版本不匹配");
    expect(isDemoRuntime()).toBe(true);
    expect(localStorage.getItem("offeru.web.runtime")).toBeNull();
  });

  it("never switches truth source when the local probe fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));

    const result = await selectLocalRuntime();

    expect(result.ok).toBe(false);
    expect(isLocalRuntimeSelected()).toBe(false);
    expect(isDemoRuntime()).toBe(true);
    expect(getLocalRuntimeSnapshot()).toMatchObject({ selected: false, connected: false, probing: false });
  });

  it("rechecks a remembered connection on hook mount and restores local mode only after identity passes", async () => {
    localStorage.setItem("offeru.web.runtime", "local");
    const fetchMock = mockHealth();
    const { result } = renderHook(() => useLocalRuntime());

    await waitFor(() => expect(result.current).toMatchObject({ selected: true, connected: true, probing: false }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(isDemoRuntime()).toBe(false);
  });

  it("clears a remembered connection and stays in demo when its recheck fails", async () => {
    localStorage.setItem("offeru.web.runtime", "local");
    mockHealth({ status: "ok" });
    const { result } = renderHook(() => useLocalRuntime());

    await waitFor(() => expect(result.current).toMatchObject({ selected: false, connected: false, probing: false }));

    expect(result.current.error).toContain("不是 OfferU Runtime");
    expect(localStorage.getItem("offeru.web.runtime")).toBeNull();
    expect(isDemoRuntime()).toBe(true);
  });

  it("notifies subscribers on connect and disconnect without reloading the page", async () => {
    mockHealth();
    const { result } = renderHook(() => useLocalRuntime());

    await act(async () => {
      await result.current.connect();
    });
    expect(result.current.connected).toBe(true);
    expect(isDemoRuntime()).toBe(false);

    act(() => result.current.disconnect());
    expect(result.current).toMatchObject({ selected: false, connected: false, probing: false });
    expect(isDemoRuntime()).toBe(true);
  });

  it("does not restore a connection when the user disconnects during a pending probe", async () => {
    let resolveFetch!: (response: Response) => void;
    const pendingFetch = new Promise<Response>((resolve) => { resolveFetch = resolve; });
    vi.stubGlobal("fetch", vi.fn(() => pendingFetch));

    const selecting = selectLocalRuntime();
    expect(getLocalRuntimeSnapshot().probing).toBe(true);
    selectDemoRuntime();
    resolveFetch(new Response(JSON.stringify(offeruHealth), { status: 200 }));

    expect((await selecting).ok).toBe(false);
    expect(getLocalRuntimeSnapshot()).toMatchObject({ selected: false, connected: false, probing: false });
    expect(isDemoRuntime()).toBe(true);
  });

  it("probe rejects a non-OfferU loopback service", async () => {
    mockHealth({ status: "ok", service: "something-else", runtime: "python" });

    expect((await probeLocalRuntime()).ok).toBe(false);
  });
});
