// Firecrawl web search: POST api.firecrawl.dev/v2/search, with `Authorization: Bearer <key>`
// when a key is set, otherwise keyless (header omitted).
//
// Ported from oh-my-pi
//   packages/coding-agent/src/web/search/providers/firecrawl.ts (buildRequestBody / callFirecrawlSearch /
//     getWebResults / searchFirecrawl)
//   packages/coding-agent/src/web/firecrawl.ts (FIRECRAWL_DEFAULT_BASE_URL)
//   https://github.com/can1357/oh-my-pi @ 4193d01, MIT License,
//   Copyright (c) 2025 Mario Zechner, (c) 2025-2026 Can Bölük, (c) 2026 Stencil Labs, Inc.
// Adapted: no FIRECRAWL_BASE_URL self-host override (no process.env in core), no recency/tbs,
// no omp auth storage. Transport is the injected fetch.

import type { HttpFetch } from "../net";
import { failHttp, isRecord, postWithTimeout, SearchProviderError, type RawHit } from "./shared";

export const FIRECRAWL_SEARCH_URL = "https://api.firecrawl.dev/v2/search";

type FirecrawlWebResult = { title?: string | null; url?: string | null; description?: string | null; snippet?: string | null; markdown?: string | null };

function webResults(data: Record<string, unknown>): FirecrawlWebResult[] {
  if (Array.isArray(data.data)) return data.data as FirecrawlWebResult[];
  if (isRecord(data.data) && Array.isArray(data.data.web)) return data.data.web as FirecrawlWebResult[];
  return Array.isArray(data.results) ? (data.results as FirecrawlWebResult[]) : [];
}

export async function searchFirecrawl(fetcher: HttpFetch, query: string, limit: number, apiKey?: string): Promise<RawHit[]> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const data = await postWithTimeout(
    fetcher,
    FIRECRAWL_SEARCH_URL,
    { query, limit, sources: [{ type: "web" }] },
    headers,
    async (response) => {
      if (!response.ok) await failHttp("firecrawl", response, !apiKey);
      return response.json();
    },
  );
  if (!isRecord(data)) throw new SearchProviderError("firecrawl", "Firecrawl returned an invalid response");
  if (data.success === false) throw new SearchProviderError("firecrawl", (typeof data.error === "string" && data.error.trim()) || "Firecrawl request failed");
  return webResults(data)
    .filter((r) => r && r.url)
    .slice(0, limit)
    .map((r) => ({ title: r.title ?? r.url, url: r.url, snippet: r.description ?? r.snippet ?? r.markdown ?? "" }));
}
