// Parallel web search: keyed REST (api.parallel.ai/v1beta/search) or the keyless public MCP
// (search.parallel.ai/mcp, tool `web_search`).
//
// Ported from oh-my-pi
//   packages/coding-agent/src/web/search/providers/parallel.ts (searchWithPublicMcp / searchWithAuthStorage)
//   packages/coding-agent/src/web/parallel.ts (PARALLEL_SEARCH_URL, PARALLEL_BETA_HEADER, parseParallelSearchPayload)
//   https://github.com/can1357/oh-my-pi @ 4193d01, MIT License,
//   Copyright (c) 2025 Mario Zechner, (c) 2025-2026 Can Bölük, (c) 2026 Stencil Labs, Inc.
// Adapted: no omp auth storage / query directive parser (the query is passed through as-is),
// no session_id / model_name, no omp User-Agent header (browsers can't set it and Parallel's
// CORS allow-list doesn't include it). Transport is the injected fetch.

import type { HttpFetch } from "../net";
import { callMcpTool, failHttp, isRecord, mcpTextParts, postWithTimeout, SearchProviderError, type RawHit } from "./shared";

export const PARALLEL_MCP_URL = "https://search.parallel.ai/mcp";
export const PARALLEL_SEARCH_URL = "https://api.parallel.ai/v1beta/search";
export const PARALLEL_BETA_HEADER = "search-extract-2025-10-10";

/** parseParallelSearchPayload: results[].{url,title,excerpts[],publish_date}. */
export function parseParallelPayload(payload: unknown): RawHit[] {
  if (!isRecord(payload)) throw new SearchProviderError("parallel", "Parallel search returned an invalid response payload.");
  const results = Array.isArray(payload.results) ? payload.results : [];
  const hits: RawHit[] = [];
  for (const item of results) {
    if (!isRecord(item) || typeof item.url !== "string" || !item.url) continue;
    const excerpts = Array.isArray(item.excerpts) ? item.excerpts.filter((e): e is string => typeof e === "string") : [];
    hits.push({
      title: typeof item.title === "string" ? item.title : item.url,
      url: item.url,
      snippet: excerpts.join("\n\n"),
      published: typeof item.publish_date === "string" ? item.publish_date : undefined,
    });
  }
  return hits;
}

export async function searchParallel(fetcher: HttpFetch, query: string, limit: number, apiKey?: string): Promise<RawHit[]> {
  if (apiKey) {
    const payload = await postWithTimeout(
      fetcher,
      PARALLEL_SEARCH_URL,
      { objective: query, search_queries: [query], mode: "fast", excerpts: { max_chars_per_result: 10_000 } },
      { Accept: "application/json", "Content-Type": "application/json", "x-api-key": apiKey, "parallel-beta": PARALLEL_BETA_HEADER },
      async (response) => {
        if (!response.ok) await failHttp("parallel", response, false);
        return response.json();
      },
    );
    return parseParallelPayload(payload).slice(0, limit);
  }
  const result = await callMcpTool(fetcher, "parallel", PARALLEL_MCP_URL, "web_search", { objective: query, search_queries: [query] });
  if (result.structuredContent !== undefined) return parseParallelPayload(result.structuredContent).slice(0, limit);
  for (const text of mcpTextParts(result)) {
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      continue;
    }
    return parseParallelPayload(payload).slice(0, limit);
  }
  return [];
}
