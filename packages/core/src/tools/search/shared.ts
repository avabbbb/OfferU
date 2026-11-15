// Shared plumbing for the ported web-search providers (parallel / exa / firecrawl / keenable).
//
// The MCP JSON-RPC-over-HTTP reader is ported from oh-my-pi
//   packages/coding-agent/src/mcp/json-rpc.ts (callMCP / readMcpJsonRpcResponse)
//   https://github.com/can1357/oh-my-pi @ 4193d01, MIT License,
//   Copyright (c) 2025 Mario Zechner, (c) 2025-2026 Can Bölük, (c) 2026 Stencil Labs, Inc.
// Adapted: no omp logger / pi-utils; SSE parsed inline; transport is the injected fetch.
// Pure TS: no node:* (runs in the browser, Workers and Node).

import type { HttpFetch } from "../net";

/** One hit as a provider returns it, before OfferU's cleanResult (public-URL check, length caps). */
export type RawHit = { title?: unknown; url?: unknown; snippet?: unknown; published?: unknown };

/** A provider call: query + clamped limit → raw hits. Throws on transport/API errors. */
export type ProviderCall = (fetcher: HttpFetch, query: string, limit: number) => Promise<RawHit[]>;

export const SEARCH_TIMEOUT_MS = 20_000;

export class SearchProviderError extends Error {
  constructor(readonly provider: string, message: string, readonly status?: number) {
    super(message);
    this.name = "SearchProviderError";
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** POST with a hard timeout. Returns the Response (caller checks ok). */
export async function postWithTimeout(
  fetcher: HttpFetch,
  url: string,
  body: unknown,
  headers: Record<string, string>,
  read: (response: Response, signal: AbortSignal) => Promise<unknown>,
  timeoutMs = SEARCH_TIMEOUT_MS,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      redirect: "manual",
      signal: controller.signal,
    });
    return await read(response, controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

export async function errorText(response: Response, cap = 500): Promise<string> {
  try {
    return (await response.text()).slice(0, cap).trim();
  } catch {
    return "";
  }
}

/** Throw a provider error for a non-2xx response (429 gets a "rate limit" hint like omp). */
export async function failHttp(provider: string, response: Response, keyless: boolean): Promise<never> {
  const text = await errorText(response);
  if (response.status === 429 && keyless) {
    throw new SearchProviderError(provider, `${provider}: 免 Key 接口限流 (429)，配一个 ${provider} API Key 可提高额度`, 429);
  }
  throw new SearchProviderError(provider, `${provider} HTTP ${response.status}${text ? `: ${text}` : ""}`, response.status);
}

// ---------- MCP JSON-RPC over HTTP (Streamable HTTP: JSON or SSE response) ----------

export type JsonRpcResponse = { id: string | number; result?: unknown; error?: { code: number; message: string } };

function decodeJsonRpc(message: unknown): JsonRpcResponse | null {
  if (!isRecord(message)) throw new SyntaxError("Malformed JSON-RPC message");
  if ("method" in message) return null; // server notification / request
  if (typeof message.id !== "string" && typeof message.id !== "number") throw new SyntaxError("Malformed JSON-RPC response");
  const hasResult = Object.prototype.hasOwnProperty.call(message, "result");
  const hasError = Object.prototype.hasOwnProperty.call(message, "error");
  if (hasResult === hasError) throw new SyntaxError("Malformed JSON-RPC response");
  if (hasError) {
    const err = message.error;
    if (!isRecord(err) || typeof err.code !== "number" || typeof err.message !== "string") throw new SyntaxError("Malformed JSON-RPC error response");
    return { id: message.id, error: { code: err.code, message: err.message } };
  }
  return { id: message.id, result: message.result };
}

/** Pull `data:` payloads out of an SSE body (events separated by blank lines). */
function sseData(text: string): string[] {
  const out: string[] = [];
  for (const block of text.replace(/\r\n?/g, "\n").split(/\n\n+/)) {
    const lines = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, ""));
    if (lines.length) out.push(lines.join("\n"));
  }
  return out;
}

/** Read the JSON-RPC response matching `expectedId` from a JSON or text/event-stream body. */
export async function readMcpJsonRpcResponse(response: Response, expectedId: string | number): Promise<JsonRpcResponse> {
  let sawOther = false;
  const select = (payload: unknown): JsonRpcResponse | null => {
    for (const message of Array.isArray(payload) ? payload : [payload]) {
      const decoded = decodeJsonRpc(message);
      if (!decoded) continue;
      if (decoded.id === expectedId) return decoded;
      sawOther = true;
    }
    return null;
  };
  const text = await response.text();
  if ((response.headers.get("content-type") ?? "").toLowerCase().includes("text/event-stream")) {
    for (const data of sseData(text)) {
      if (data === "" || data === "[DONE]") continue;
      const matched = select(JSON.parse(data));
      if (matched) return matched;
    }
  } else {
    const matched = select(JSON.parse(text));
    if (matched) return matched;
  }
  throw new Error(sawOther ? "MCP response ID did not match request ID" : "MCP response did not include a result or error");
}

/** One `tools/call` against a public MCP endpoint; returns the tool result object. */
export async function callMcpTool(
  fetcher: HttpFetch,
  provider: string,
  url: string,
  name: string,
  args: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const id = Math.random().toString(36).slice(2);
  const rpc = await postWithTimeout(
    fetcher,
    url,
    { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } },
    { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...extraHeaders },
    async (response) => {
      if (!response.ok) await failHttp(provider, response, true);
      try {
        return await readMcpJsonRpcResponse(response, id);
      } catch (cause) {
        throw new SearchProviderError(provider, `${provider} MCP 响应解析失败：${cause instanceof Error ? cause.message : String(cause)}`);
      }
    },
  ) as JsonRpcResponse;
  if (rpc.error) throw new SearchProviderError(provider, `${provider} MCP error: ${rpc.error.message}`);
  const result = isRecord(rpc.result) ? rpc.result : {};
  if (result.isError === true) {
    const content = Array.isArray(result.content) ? result.content : [];
    const message = content.map((item) => (isRecord(item) && item.type === "text" && typeof item.text === "string" ? item.text.trim() : "")).find(Boolean);
    throw new SearchProviderError(provider, message || `${provider} MCP returned an error`);
  }
  return result;
}

/** Text parts of an MCP tool result's `content` array. */
export function mcpTextParts(result: Record<string, unknown>): string[] {
  const content = Array.isArray(result.content) ? result.content : [];
  return content
    .map((item) => (isRecord(item) && typeof item.text === "string" ? item.text : ""))
    .filter((text) => text.trim().length > 0);
}
