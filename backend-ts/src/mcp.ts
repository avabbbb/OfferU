import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { MCP_INSTRUCTIONS, TOOL_SPECS, type CoreStore } from "@offeru/core";

import { callTool, type ToolRuntime } from "./tools";

export { MCP_INSTRUCTIONS };

/** Same tools, descriptions and input schemas as Python app/mcp_server.py (generated TOOL_SPECS). */
export const MCP_TOOLS: Tool[] = TOOL_SPECS.map((spec) => ({
  name: spec.name,
  description: spec.description,
  inputSchema: spec.inputSchema as Tool["inputSchema"],
}));

/**
 * OfferU over MCP. The calling agent's handshake name is the actor (Python:
 * clientInfo.name or "agent"), so agent writes stay unconfirmed / forward-only.
 * Tool errors go back to the agent as text "错误：…".
 */
export function createMcpServer(runtime: ToolRuntime | CoreStore): Server {
  const server = new Server(
    { name: "OfferU", version: "0.1.0" },
    { capabilities: { tools: {} }, instructions: MCP_INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: MCP_TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const actor = server.getClientVersion()?.name || "agent";
    try {
      const result = await callTool(request.params.name, request.params.arguments ?? {}, runtime, actor, extra.signal);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    } catch (cause) {
      return {
        content: [{ type: "text" as const, text: `错误：${cause instanceof Error ? cause.message : String(cause)}` }],
        isError: true,
      };
    }
  });

  return server;
}

export async function runMcpServer(runtime: ToolRuntime | CoreStore): Promise<void> {
  const server = createMcpServer(runtime);
  await server.connect(new StdioServerTransport());
}
