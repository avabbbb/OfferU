import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

import type { SqliteCoreStore } from "./store";
import { callTool, SUPPORTED_TOOLS } from "./tools";

const TOOLS: Tool[] = [
  {
    name: "overview",
    description: "先调这个。当前求职阶段、下一步、待办分桶、各状态岗位数和最近改动。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list",
    description: "列出某类记录；长文本会截断，要全文用 get。",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["profile", "memory", "job", "event", "doc"] },
        status: { type: "string", enum: ["saved", "applied", "test", "interview", "offer", "rejected", "closed"] },
        kind: { type: "string" },
        job_id: { type: "number" },
        done: { type: "boolean" },
        tag: { type: "string" },
        full: { type: "boolean" },
        limit: { type: "number", minimum: 1, maximum: 500 },
      },
      required: ["type"],
      additionalProperties: false,
    },
  },
  {
    name: "get",
    description: "读一条完整记录；读岗位时连带它的事项和文档。",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["profile", "memory", "job", "event", "doc"] },
        id: { type: "number" },
      },
      required: ["type", "id"],
      additionalProperties: false,
    },
  },
  {
    name: "save",
    description: "新建或更新一条记录，直接生效，可撤销。更新时只传要改的字段，传 null 删除字段。",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["profile", "memory", "job", "event", "doc"] },
        id: { type: "number" },
        data: { type: "object", additionalProperties: true },
      },
      required: ["type", "data"],
      additionalProperties: false,
    },
  },
  {
    name: "delete",
    description: "删除一条记录（可撤销）。",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["profile", "memory", "job", "event", "doc"] },
        id: { type: "number" },
      },
      required: ["type", "id"],
      additionalProperties: false,
    },
  },
  {
    name: "undo",
    description: "撤销一条改动，把记录恢复到改动之前。",
    inputSchema: {
      type: "object",
      properties: { change_id: { type: "number" } },
      required: ["change_id"],
      additionalProperties: false,
    },
  },
  {
    name: "changes",
    description: "最近改动，谁改了什么，最新在前。",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", minimum: 1, maximum: 200 } },
      additionalProperties: false,
    },
  },
  {
    name: "search",
    description: "按关键词搜所有记录，返回 type、id、摘要。找用户经历和说过的话先用它。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        types: { type: "array", items: { type: "string", enum: ["profile", "memory", "job", "event", "doc"] } },
        limit: { type: "number", minimum: 1, maximum: 100 },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
];

export const MCP_INSTRUCTIONS = "OfferU 是用户本地的求职工作台。先调 overview 看阶段和下一步；写入直接生效，用户可以撤销；不编造经历，不替用户发送对外消息。";

export function createMcpServer(store: SqliteCoreStore): Server {
  const server = new Server(
    { name: "OfferU", version: "0.1.0" },
    { capabilities: { tools: {} }, instructions: MCP_INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    if (!SUPPORTED_TOOLS.includes(name as typeof SUPPORTED_TOOLS[number])) {
      return {
        content: [{ type: "text" as const, text: `错误：TS backend 暂不支持工具「${name}」` }],
        isError: true,
      };
    }
    try {
      const result = callTool(name, request.params.arguments ?? {}, store, "agent");
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (cause) {
      return {
        content: [{ type: "text" as const, text: `错误：${cause instanceof Error ? cause.message : "工具调用失败"}` }],
        isError: true,
      };
    }
  });

  return server;
}

export async function runMcpServer(store: SqliteCoreStore): Promise<void> {
  const server = createMcpServer(store);
  await server.connect(new StdioServerTransport());
}
