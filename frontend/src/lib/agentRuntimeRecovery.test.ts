import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("./showcase/router", () => ({ SHOWCASE: false }));
import { agentRuntimeApi } from "./api";

describe("Agent runtime terminal failures", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("preserves a configuration rejection without reconnecting or resubmitting", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: "LLM API Key 未配置，请在设置页面填写" }), { status: 400, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);
    await expect(agentRuntimeApi.start({ message: "读取岗位", skill_id: "discovery" })).rejects.toThrow("LLM API Key 未配置");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("surfaces an explicit SSE provider failure immediately", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('event: error\ndata: {"error":"Provider 401: invalid_api_key","error_id":"fixture-error"}\n\n', { headers: { "Content-Type": "text/event-stream" } }));
    vi.stubGlobal("fetch", fetch);
    await expect(agentRuntimeApi.start({ message: "读取岗位", skill_id: "discovery" })).rejects.toThrow("fixture-error");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
