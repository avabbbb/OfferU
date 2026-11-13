import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createMcpServer } from "../src/mcp";
import { SqliteCoreStore } from "../src/store";
import { callTool } from "../src/tools";

let store: SqliteCoreStore | null = null;

afterEach(() => {
  store?.close();
  store = null;
});

describe("TS MCP surface", () => {
  it("lists the shared tools and calls overview", async () => {
    store = new SqliteCoreStore(":memory:");
    await callTool("save", { type: "profile", data: { name: "MCP 用户" } }, store);
    const server = createMcpServer(store);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "offeru-test", version: "0.0.0" });
    await client.connect(clientTransport);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual([
        "overview", "list", "get", "save", "delete", "undo", "changes", "search",
      ]);
      const result = await client.callTool({ name: "overview", arguments: {} }) as { content: Array<{ type: string; text?: string }> };
      const text = result.content[0];
      expect(text.type).toBe("text");
      expect(text.type === "text" ? text.text : "").toContain("MCP 用户");
    } finally {
      await client.close();
      await server.close();
    }
  });
});
