import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./showcase/router", () => ({ SHOWCASE: true }));
vi.mock("./apiBase", () => ({ resolveApiBase: () => "http://127.0.0.1:8766" }));

import {
  connectLocalRuntime,
  disconnectLocalRuntime,
  isLocalRuntimeConnected,
} from "./localRuntime";

describe("localRuntime", () => {
  beforeEach(() => {
    localStorage.clear();
    disconnectLocalRuntime();
    vi.restoreAllMocks();
  });

  it("connects the web surface to the existing local OfferU runtime", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => new Response(JSON.stringify({ status: "ok" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    expect(isLocalRuntimeConnected()).toBe(false);
    await expect(connectLocalRuntime()).resolves.toBe(true);
    expect(isLocalRuntimeConnected()).toBe(true);
    expect(localStorage.getItem("offeru_web_local_runtime")).toBe("connected");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const request = fetchMock.mock.calls[0]?.[0] as unknown as Request;
    expect(request.url).toBe("http://127.0.0.1:8766/api/health");
  });

  it("fails closed and stays in showcase mode when no local runtime is reachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL) => {
      throw new TypeError("network unavailable");
    }));

    await expect(connectLocalRuntime()).resolves.toBe(false);
    expect(isLocalRuntimeConnected()).toBe(false);
    expect(localStorage.getItem("offeru_web_local_runtime")).toBeNull();
  });
});
