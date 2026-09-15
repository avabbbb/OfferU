// =============================================
// BOSS 登录态同步测试
// 覆盖：字段映射写死（不允许任意键）、缺 wt2 fail-closed、
// 以后端回读为准、凭据不出现在错误信息里。
// =============================================

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpOfferUControl } from "./offeru-control-http.js";

const BACKEND = "http://127.0.0.1:8766";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("HttpOfferUControl.updateScraperSession", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("PUTs only the allow-listed config field and re-reads backend status", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ message: "Config updated" }))
      .mockResolvedValueOnce(
        jsonResponse({ configured: true, has_wt2: true, has_zp_token: true, message: "Cookie configured" }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const control = new HttpOfferUControl(BACKEND);
    const state = await control.updateScraperSession("boss", "wt2=abc; zp_token=def");

    const [putUrl, putInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(putUrl).toBe(`${BACKEND}/api/config/`);
    expect(putInit.method).toBe("PUT");
    expect(JSON.parse(putInit.body as string)).toEqual({ boss_cookie: "wt2=abc; zp_token=def" });

    const [getUrl] = fetchMock.mock.calls[1] as [string];
    expect(getUrl).toBe(`${BACKEND}/api/config/boss-status`);
    expect(state).toEqual({
      configured: true,
      hasWt2: true,
      hasZpToken: true,
      message: "Cookie configured",
    });
  });

  it("reports not-configured when the backend did not persist the session", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ message: "Config updated" }))
      .mockResolvedValueOnce(jsonResponse({ configured: false, has_wt2: false, has_zp_token: false }));
    vi.stubGlobal("fetch", fetchMock);

    const state = await new HttpOfferUControl(BACKEND).updateScraperSession("boss", "wt2=abc");
    expect(state.configured).toBe(false);
    expect(state.hasWt2).toBe(false);
  });

  it("rejects unknown providers instead of writing arbitrary config keys", async () => {
    const control = new HttpOfferUControl(BACKEND);
    await expect(control.updateScraperSession("evil", "wt2=abc")).rejects.toThrow("不支持的招聘站点");
  });

  it("rejects an empty cookie before touching the network", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const control = new HttpOfferUControl(BACKEND);
    await expect(control.updateScraperSession("boss", "   ")).rejects.toThrow("没有读取到登录态");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces backend errors without leaking the cookie", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ detail: "boom" }, false, 503),
    );
    vi.stubGlobal("fetch", fetchMock);

    const control = new HttpOfferUControl(BACKEND);
    let message = "";
    try {
      await control.updateScraperSession("boss", "wt2=SECRET-VALUE");
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("HTTP 503");
    expect(message).not.toContain("SECRET-VALUE");
  });
});
