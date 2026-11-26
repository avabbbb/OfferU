import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/lib/core", () => ({
  refreshAll: vi.fn().mockResolvedValue(undefined),
}));

import { disconnectLocalBridge } from "@/lib/bridge";
import { refreshAll } from "@/lib/core";
import { LocalBridgeCard } from "./LocalBridgeCard";

describe("LocalBridgeCard", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    window.localStorage.clear();
    disconnectLocalBridge();
    vi.mocked(refreshAll).mockClear();
  });

  afterEach(() => {
    cleanup();
    disconnectLocalBridge();
    window.localStorage.clear();
    globalThis.fetch = originalFetch;
  });

  it("pairs with the local companion from the dialog and allows disconnecting", async () => {
    globalThis.fetch = vi.fn(async (url: string) => {
      if (url.endsWith("/api/health")) {
        return new Response(JSON.stringify({ status: "ok", service: "OfferU", runtime: "node", version: "0.2.0" }), { status: 200 });
      }
      if (url.endsWith("/api/ui/pair")) {
        return new Response(JSON.stringify({ token: "t1", pairing_token: "pair-token-12345678901234567890" }), { status: 200 });
      }
      return new Response(JSON.stringify({ stage: "not_started" }), { status: 200 });
    }) as never;

    render(<LocalBridgeCard />);
    expect(screen.getByText("浏览器本地存储")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "连接本机 OfferU" }));
    expect(await screen.findByText(/已发现本机 OfferU/)).toBeTruthy();

    const input = screen.getByLabelText("配对链接 / 配对码 / Token");
    fireEvent.change(input, { target: { value: "https://offeru.avabbbb.com/#/pair/AbCdEf123456_xyz" } });
    fireEvent.click(screen.getByRole("button", { name: "连接" }));

    await waitFor(() => expect(screen.getByText("已连接本机 OfferU")).toBeTruthy());
    expect(refreshAll).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "断开本机" }));
    await waitFor(() => expect(screen.getByText("浏览器本地存储")).toBeTruthy());
    expect(refreshAll).toHaveBeenCalledTimes(2);
  });
});
