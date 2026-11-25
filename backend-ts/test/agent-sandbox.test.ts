// 沙箱模式（packages/core agent/sandbox.ts）的单元契约：白名单、模式解析。
import { describe, expect, it } from "vitest";
import { applySandbox, isReadOnlyCall, readOnlyFailure, resolveSandbox, type AgentTool } from "@offeru/core";

function tool(name: string): AgentTool {
  return { name, description: `${name} 工具`, parameters: { type: "object" }, async execute() { return { text: `"${name} ran"`, isError: false }; } };
}

describe("sandbox", () => {
  it("resolves explicit > stored > default", () => {
    expect(resolveSandbox("read_only", "workspace_write")).toBe("read_only");
    expect(resolveSandbox(undefined, "read_only")).toBe("read_only");
    expect(resolveSandbox("bogus", undefined)).toBe("workspace_write");
  });

  it("whitelists reads; unknown tools count as writes", () => {
    expect(isReadOnlyCall("search")).toBe(true);
    expect(isReadOnlyCall("save")).toBe(false);
    expect(isReadOnlyCall("some_new_tool")).toBe(false);
  });

  it("read_only wraps write tools; workspace_write leaves tools untouched", async () => {
    const tools = [tool("search"), tool("save")];
    expect(applySandbox(tools, "workspace_write")).toBe(tools);
    const [search, save] = applySandbox(tools, "read_only");
    expect(search).toBe(tools[0]);
    expect((await search.execute({}, { callId: "1" })).text).toBe('"search ran"');
    const blocked = await save.execute({ type: "memory" }, { callId: "2" });
    expect(blocked.isError).toBe(true);
    expect(JSON.parse(blocked.text)).toEqual(readOnlyFailure("save"));
    expect(save.description).toMatch(/^【只读模式下不可用/);
  });
});
