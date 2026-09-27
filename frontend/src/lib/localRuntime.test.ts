import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./showcase/router", () => ({ SHOWCASE: true }));
vi.mock("./apiBase", () => ({ resolveApiBase: () => "http://127.0.0.1:8766" }));

import {
  isDemoRuntime,
  isLocalRuntimeSelected,
  probeLocalRuntime,
  selectDemoRuntime,
  selectLocalRuntime,
} from "./localRuntime";

describe("localRuntime", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("keeps showcase in demo until the user explicitly connects", () => {
    expect(isDemoRuntime()).toBe(true);
    expect(isLocalRuntimeSelected()).toBe(false);
  });

  it("selects the single local runtime only after OfferU health identity passes", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      status: "ok",
      service: "OfferU",
      runtime: "python",
      version: "0.4.0",
      build_mode: "release",
    }), { status: 200, headers: { "Content-Type": "application/json" } })));

    const result = await selectLocalRuntime();

    expect(result.ok).toBe(true);
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:8766/api/health",
      expect.objectContaining({ cache: "no-store", redirect: "error" }),
    );
    expect(isLocalRuntimeSelected()).toBe(true);
    expect(isDemoRuntime()).toBe(false);
  });

  it("never switches truth source when the local probe fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));

    const result = await selectLocalRuntime();

    expect(result.ok).toBe(false);
    expect(isLocalRuntimeSelected()).toBe(false);
    expect(isDemoRuntime()).toBe(true);
  });

  it("disconnect returns the web surface to demo", async () => {
    localStorage.setItem("offeru.web.runtime", "local");
    expect(isDemoRuntime()).toBe(false);

    selectDemoRuntime();

    expect(isDemoRuntime()).toBe(true);
  });

  it("probe rejects a non-OfferU loopback service", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      status: "ok",
      service: "something-else",
      runtime: "python",
    }), { status: 200 })));

    expect((await probeLocalRuntime()).ok).toBe(false);
  });
});
