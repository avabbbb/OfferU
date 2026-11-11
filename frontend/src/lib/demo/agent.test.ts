import { afterEach, describe, expect, it, vi } from "vitest";

import { runDemoAgent } from "./agent";
import { demoTool } from "./tools";

vi.mock("./tools", () => ({ demoTool: vi.fn(async () => ({ total: 1, items: [{ id: 2 }] })) }));

function sse(payloads: unknown[]): Response {
  const body = payloads.map((payload) => `data: ${JSON.stringify(payload)}\r\n\r\n`).join("") + "data: [DONE]\r\n\r\n";
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("browser demo agent", () => {
  it("streams text, executes a tool, then continues the conversation", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(sse([
        { choices: [{ delta: { content: "我先查一下。" } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "list", arguments: "{\"type\":\"job\"}" } }] } }] },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ]))
      .mockResolvedValueOnce(sse([
        { choices: [{ delta: { content: "一共 1 个岗位。" } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ]));
    vi.stubGlobal("fetch", fetchMock);

    const events: string[] = [];
    const result = await runDemoAgent({
      config: { baseUrl: "https://example.test/v1", model: "test", apiKey: "secret" },
      history: [],
      input: "有几个岗位？",
      signal: new AbortController().signal,
      onEvent: (event) => events.push(event.type === "text" ? `text:${event.text}` : event.type),
    });

    expect(result).toContain("我先查一下。");
    expect(result).toContain("一共 1 个岗位。");
    expect(demoTool).toHaveBeenCalledWith("list", { type: "job" }, "Agent");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(events).toEqual(expect.arrayContaining(["text:我先查一下。", "tool_start", "tool_end", "text:一共 1 个岗位。"]));

    const secondRequest = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(secondRequest.messages.at(-2).role).toBe("assistant");
    expect(secondRequest.messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "call_1" });
  });

  it("surfaces provider HTTP errors without leaking the key", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("bad request", { status: 400 })));
    await expect(runDemoAgent({
      config: { baseUrl: "https://example.test/v1", model: "test", apiKey: "secret-key" },
      history: [],
      input: "hi",
      signal: new AbortController().signal,
      onEvent: () => {},
    })).rejects.toThrow("HTTP 400");
  });
});
