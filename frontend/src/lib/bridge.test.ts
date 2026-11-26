import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  bridgeActive,
  bridgeAuthToken,
  bridgeHeaders,
  connectLocalBridge,
  connectLocalBridgeInput,
  disconnectLocalBridge,
  hasSavedBridgeToken,
  pairLocalBridgeWithCode,
  parseBridgeInput,
  restoreLocalBridge,
} from "./bridge";

describe("local bridge", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    window.localStorage.clear();
    disconnectLocalBridge();
  });

  afterEach(() => {
    disconnectLocalBridge();
    window.localStorage.clear();
    globalThis.fetch = originalFetch;
  });

  it("parses pair URLs, /api/pairing JSON, short codes, and raw tokens", () => {
    expect(parseBridgeInput("https://offeru.avabbbb.com/#/pair/AbCdEf123456_xyz")).toEqual({ kind: "code", value: "AbCdEf123456_xyz" });
    expect(parseBridgeInput("http://127.0.0.1:8766/#/pair/uIZd2JClSvK-7uUi")).toEqual({ kind: "code", value: "uIZd2JClSvK-7uUi" });
    expect(parseBridgeInput('{"token":"long-token-value-12345678901234567890","backend":"http://127.0.0.1:8766"}')).toEqual({
      kind: "token",
      value: "long-token-value-12345678901234567890",
    });
    expect(parseBridgeInput("uIZd2JClSvK-7uUi")).toEqual({ kind: "code", value: "uIZd2JClSvK-7uUi" });
    expect(parseBridgeInput("raw-pairing-token-123456789012345678901234")).toEqual({
      kind: "token",
      value: "raw-pairing-token-123456789012345678901234",
    });
  });

  it("pairs with a one-time code, verifies overview, and persists tokens", async () => {
    const mockFetch = vi.fn(async (url: string) => {
      if (url.endsWith("/api/ui/pair")) {
        return new Response(JSON.stringify({ token: "auth-tok", pairing_token: "pair-tok-12345678901234567890" }), { status: 200 });
      }
      if (url.endsWith("/api/tools/overview")) {
        return new Response(JSON.stringify({ stage: "not_started" }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "ok", version: "0.2.0" }), { status: 200 });
    });
    globalThis.fetch = mockFetch as never;

    await pairLocalBridgeWithCode("uIZd2JClSvK-7uUi");
    expect(bridgeActive()).toBe(true);
    expect(bridgeHeaders()).toEqual({ "X-OfferU-Pairing": "pair-tok-12345678901234567890" });
    expect(bridgeAuthToken()).toBe("auth-tok");
    expect(hasSavedBridgeToken()).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith("http://127.0.0.1:8766/api/ui/pair", expect.objectContaining({ method: "POST" }));
  });

  it("restores saved bridge token when companion is running and clears it on 403", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as never;
    await connectLocalBridge("saved-token-12345678901234567890");
    // Simulate a fresh page load where memory state resets but localStorage remains.
    window.localStorage.setItem("offeru.local_bridge_token", "saved-token-12345678901234567890");
    expect(await restoreLocalBridge()).toBe(true);
    expect(bridgeActive()).toBe(true);

    // Token rotated -> 403 clears saved storage so the user is prompted to re-pair.
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ detail: "forbidden" }), { status: 403 })) as never;
    expect(await restoreLocalBridge()).toBe(false);
    expect(bridgeActive()).toBe(false);
    expect(hasSavedBridgeToken()).toBe(false);
  });

  it("connectLocalBridgeInput accepts a pasted full pair URL", async () => {
    globalThis.fetch = vi.fn(async (url: string) => {
      if (url.endsWith("/api/ui/pair")) {
        return new Response(JSON.stringify({ token: "tok-123456789012345678901234" }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as never;

    await connectLocalBridgeInput("https://offeru.avabbbb.com/#/pair/AbCdEf123456_xyz");
    expect(bridgeActive()).toBe(true);
  });
});
