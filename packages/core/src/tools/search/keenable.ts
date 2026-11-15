// Keenable web search: POST api.keenable.ai/v1/search with `X-API-Key`, or the keyless,
// per-IP rate-limited api.keenable.ai/v1/search/public, which requires an app identifier
// in `X-Keenable-Title` (requests without it get 400).
//
// Ported from oh-my-pi
//   packages/coding-agent/src/web/search/providers/keenable.ts (buildKeenableBody / callKeenableSearch /
//     searchKeenable)
//   https://github.com/can1357/oh-my-pi @ 4193d01, MIT License,
//   Copyright (c) 2025 Mario Zechner, (c) 2025-2026 Can Bölük, (c) 2026 Stencil Labs, Inc.
// Adapted: app identifier is "offeru" (omp sends "oh-my-pi"); no site/date filters or omp
// auth storage. Transport is the injected fetch.

import type { HttpFetch } from "../net";
import { failHttp, isRecord, postWithTimeout, SearchProviderError, type RawHit } from "./shared";

export const KEENABLE_SEARCH_URL = "https://api.keenable.ai/v1/search";
export const KEENABLE_PUBLIC_SEARCH_URL = "https://api.keenable.ai/v1/search/public";
export const KEENABLE_APP_TITLE = "offeru";

function normalizeHttpUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  return text || undefined;
}

export async function searchKeenable(fetcher: HttpFetch, query: string, limit: number, apiKey?: string): Promise<RawHit[]> {
  const headers: Record<string, string> = { Accept: "application/json", "Content-Type": "application/json" };
  if (apiKey) headers["X-API-Key"] = apiKey;
  else headers["X-Keenable-Title"] = KEENABLE_APP_TITLE;
  const data = await postWithTimeout(
    fetcher,
    apiKey ? KEENABLE_SEARCH_URL : KEENABLE_PUBLIC_SEARCH_URL,
    { query, max_results: limit },
    headers,
    async (response) => {
      if (!response.ok) await failHttp("keenable", response, !apiKey);
      return response.json();
    },
  );
  if (!isRecord(data) || !Array.isArray(data.results)) throw new SearchProviderError("keenable", "Keenable search API returned an unexpected response shape");
  const hits: RawHit[] = [];
  const seen = new Set<string>();
  for (const entry of data.results) {
    if (!isRecord(entry)) continue;
    const url = normalizeHttpUrl(entry.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    hits.push({
      title: normalizeText(entry.title) ?? url,
      url,
      snippet: normalizeText(entry.snippet) ?? "",
      published: typeof entry.published_at === "string" && entry.published_at ? entry.published_at : undefined,
    });
  }
  return hits.slice(0, limit);
}
