// Exa web search: keyed REST (api.exa.ai/search) or the keyless public MCP
// (mcp.exa.ai/mcp?tools=web_search_exa).
//
// Ported from oh-my-pi
//   packages/coding-agent/src/web/search/providers/exa.ts (buildExaRequestBody / callExaSearch /
//     callExaMcpSearch / parseExaMcpTextPayload / searchExa)
//   packages/coding-agent/src/exa/mcp-client.ts (normalizeMcpToolPayload)
//   https://github.com/can1357/oh-my-pi @ 4193d01, MIT License,
//   Copyright (c) 2025 Mario Zechner, (c) 2025-2026 Can Bölük, (c) 2026 Stencil Labs, Inc.
// Adapted: no omp settings / request throttle / auth storage / query directive parser;
// `x-exa-source` identifies OfferU instead of oh-my-pi. The text parser additionally accepts
// the `Published:` / `Highlights:` labels the live MCP returns (observed 2026-11-15) besides
// omp's `Published Date:` / `Text:`, and treats `N/A` as missing.

import type { HttpFetch } from "../net";
import { callMcpTool, failHttp, isRecord, mcpTextParts, postWithTimeout, type RawHit } from "./shared";

export const EXA_API_URL = "https://api.exa.ai/search";
export const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
export const EXA_MCP_SOURCE = "offeru";
const MAX_EXA_SNIPPET_CHARS = 500;

type ExaResult = { title?: string | null; url?: string | null; publishedDate?: string | null; text?: string | null; highlights?: string[] | null; summary?: string | null };

function isSearchResponse(data: unknown): data is { results?: ExaResult[] } {
  return isRecord(data) && ("results" in data || "statuses" in data || "costDollars" in data || "searchTime" in data);
}

function clean(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.toUpperCase() !== "N/A" ? trimmed : undefined;
}

function field(section: string, labels: string): string | undefined {
  const match = new RegExp(`(?:^|\\n)(?:${labels}):[ \\t]*([^\\n]*)`).exec(section);
  return clean(match?.[1]);
}

/** parseExaMcpTextPayload: "Title: …\nURL: …\nPublished: …\nAuthor: …\nHighlights:\n…" blocks. */
export function parseExaMcpText(texts: string[]): ExaResult[] {
  const joined = texts.map((t) => t.replace(/\r\n?/g, "\n").trim()).filter(Boolean).join("\n\n");
  const sections = joined
    .split(/\n{2,}(?=Title:[^\n]*\n(?:URL|Author|Published Date|Published|Text|Highlights):)/)
    .map((s) => s.trim())
    .filter((s) => s.startsWith("Title:"));
  const results: ExaResult[] = [];
  for (const section of sections) {
    const title = field(section, "Title");
    const url = field(section, "URL");
    const publishedDate = field(section, "Published Date|Published");
    const body = /(?:^|\n)(?:Text|Highlights):[ \t]*([\s\S]*)$/.exec(section);
    const text = clean(body?.[1]);
    if (!title && !url && !text) continue;
    results.push({ title, url, publishedDate, text });
  }
  return results;
}

/** normalizeMcpToolPayload + text fallback. */
function mcpResults(result: Record<string, unknown>): ExaResult[] {
  const texts = mcpTextParts(result);
  const candidates: unknown[] = [result.structuredContent, result.data, result.result, result];
  for (const text of texts) {
    try {
      candidates.push(JSON.parse(text));
    } catch { /* not JSON */ }
  }
  for (const candidate of candidates) if (isSearchResponse(candidate)) return candidate.results ?? [];
  return parseExaMcpText(texts);
}

function toHits(results: ExaResult[], limit: number): RawHit[] {
  return results
    .filter((r) => r.url)
    .slice(0, limit)
    .map((r) => ({
      title: r.title ?? r.url,
      url: r.url,
      snippet: (r.summary || r.text || r.highlights?.join(" ") || "").slice(0, MAX_EXA_SNIPPET_CHARS),
      published: r.publishedDate ?? undefined,
    }));
}

export async function searchExa(fetcher: HttpFetch, query: string, limit: number, apiKey?: string): Promise<RawHit[]> {
  if (apiKey) {
    const payload = await postWithTimeout(
      fetcher,
      EXA_API_URL,
      { query, numResults: limit, type: "auto", contents: { summary: { query } } },
      { "Content-Type": "application/json", "x-api-key": apiKey },
      async (response) => {
        if (!response.ok) await failHttp("exa", response, false);
        return response.json();
      },
    );
    return toHits(isSearchResponse(payload) ? payload.results ?? [] : [], limit);
  }
  const result = await callMcpTool(
    fetcher,
    "exa",
    `${EXA_MCP_URL}?${new URLSearchParams({ tools: "web_search_exa" }).toString()}`,
    "web_search_exa",
    { query, numResults: limit },
    { "x-exa-source": EXA_MCP_SOURCE },
  );
  return toHits(mcpResults(result), limit);
}
