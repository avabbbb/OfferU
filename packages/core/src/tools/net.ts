// Network-backed tools: fetch_page and web_search. Everything goes through an
// injected `fetch` (global fetch in Node / Workers / browser, a fake in tests).

import { CoreError } from "../types";
import { cleanText, guard, guardCounts, guardWarning, unescapeHtml, type GuardCounts } from "./posting-guard";

export type HttpFetch = (input: string, init?: RequestInit) => Promise<Response>;

export type FetchPageResult = {
  url: string;
  title: string;
  text: string;
  truncated: boolean;
  guard: GuardCounts;
  warning: string | null;
};

const MAX_PAGE_BYTES = 3_000_000;
const PAGE_TIMEOUT_MS = 15_000;

function charsetOf(contentType: string | null): string {
  const match = /charset=["']?([\w.:-]+)/i.exec(contentType ?? "");
  return match ? match[1].toLowerCase() : "utf-8";
}

async function readCapped(response: Response, cap: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array(await response.arrayBuffer()).slice(0, cap);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < cap) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const out = new Uint8Array(Math.min(size, cap));
  let at = 0;
  for (const chunk of chunks) {
    const take = chunk.subarray(0, Math.min(chunk.length, out.length - at));
    out.set(take, at);
    at += take.length;
    if (at >= out.length) break;
  }
  return out;
}

function decode(bytes: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset, { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }
}

/** Plain GET of a public page as text (Python tools.fetch_page). Pages that need login or JS come back thin. */
export async function fetchPage(fetcher: HttpFetch | undefined, url: string): Promise<FetchPageResult> {
  if (!/^https?:\/\//.test(url)) throw new CoreError("只支持 http/https 链接");
  if (!fetcher) throw new CoreError("这个运行环境不能联网抓网页", "unsupported");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PAGE_TIMEOUT_MS);
  let raw: string;
  try {
    const response = await fetcher(url, { headers: { "User-Agent": "Mozilla/5.0 OfferU" }, redirect: "follow", signal: controller.signal });
    if (!response.ok) throw new CoreError(`抓取失败：HTTP ${response.status}`);
    raw = decode(await readCapped(response, MAX_PAGE_BYTES), charsetOf(response.headers.get("content-type")));
  } catch (cause) {
    if (cause instanceof CoreError) throw cause;
    throw new CoreError(`抓取失败：${controller.signal.aborted ? "超过 15 秒没响应" : cause instanceof Error ? cause.message : String(cause)}`);
  } finally {
    clearTimeout(timer);
  }
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw);
  // 岗位页是第三方文本：隐藏内容和不可见字符不进正文，像指令的行只计数（posting_guard）。
  const title = cleanText(unescapeHtml(titleMatch?.[1] ?? "").trim())[0];
  const [text, findings] = guard(raw, true);
  return {
    url,
    title,
    text: text.slice(0, 20_000),
    truncated: text.length > 20_000,
    guard: guardCounts(findings),
    warning: guardWarning(findings),
  };
}

// ---------- web search ----------

export type SearchResult = { title: string; url: string; snippet: string; engine: string };

/** A search backend. `search` returns [] for "nothing found"; `available` false means nothing is configured. */
export interface SearchClient {
  readonly available: boolean;
  search(query: string, limit: number): Promise<SearchResult[]>;
}

export type SearchKeys = {
  provider?: "auto" | "bocha" | "tavily" | "serper";
  bochaApiKey?: string;
  tavilyApiKey?: string;
  serperApiKey?: string;
};

/** Login-walled / anti-scraping sites: only the user may copy text from them. */
export const RESTRICTED_DOMAINS = ["xiaohongshu.com", "xhslink.com", "maimai.cn", "nowcoder.com", "zhipin.com"];
/** Recruiting sites whose detail pages need login or JS (Python job_capture.CAPTURE_PASTE_ONLY_DOMAINS). */
export const PASTE_ONLY_DOMAINS = ["linkedin.com", "liepin.com", "lagou.com"];

export function hostIn(host: string, domains: readonly string[]): boolean {
  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function isPublicHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) return false;
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (host === "localhost" || host.endsWith(".local")) return false;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
      const [a, b] = host.split(".").map(Number);
      return !(a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
        || (a === 192 && b === 168) || a >= 224);
    }
    if (host.includes(":")) return !(host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80"));
    return true;
  } catch {
    return false;
  }
}

function cleanResult(title: unknown, url: unknown, snippet: unknown, engine: string): SearchResult | null {
  const clean = String(url ?? "").trim();
  if (!clean || !isPublicHttpUrl(clean)) return null;
  return {
    title: String(title ?? "").trim().slice(0, 300),
    url: clean.slice(0, 2000),
    snippet: String(snippet ?? "").trim().slice(0, 1000),
    engine,
  };
}

/**
 * Bocha / Tavily / Serper fallback chain (Python services/web_search.web_search):
 * first non-empty result wins, provider errors fall through. ddgs (a Python-only
 * optional package) is not ported.
 */
export function createSearchClient(keys: SearchKeys, fetcher: HttpFetch): SearchClient {
  const provider = keys.provider ?? "auto";
  type Runner = (query: string, limit: number) => Promise<SearchResult[]>;
  const post = async (url: string, body: unknown, headers: Record<string, string> = {}): Promise<any> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await fetcher(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
        redirect: "manual",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  };
  const chain: Runner[] = [];
  if ((provider === "auto" || provider === "bocha") && keys.bochaApiKey) {
    chain.push(async (query, limit) => {
      const payload = await post("https://api.bochaai.com/v1/web-search", { query, count: limit, summary: true }, { Authorization: `Bearer ${keys.bochaApiKey}` });
      const items: any[] = payload?.data?.webPages?.value ?? [];
      return items.slice(0, limit).map((item) => cleanResult(item.name, item.url, item.summary || item.snippet, "bocha")).filter((r): r is SearchResult => r !== null);
    });
  }
  if ((provider === "auto" || provider === "tavily") && keys.tavilyApiKey) {
    chain.push(async (query, limit) => {
      const payload = await post("https://api.tavily.com/search", { api_key: keys.tavilyApiKey, query, max_results: limit });
      const items: any[] = payload?.results ?? [];
      return items.slice(0, limit).map((item) => cleanResult(item.title, item.url, item.content, "tavily")).filter((r): r is SearchResult => r !== null);
    });
  }
  if ((provider === "auto" || provider === "serper") && keys.serperApiKey) {
    chain.push(async (query, limit) => {
      const payload = await post("https://google.serper.dev/search", { q: query, num: limit }, { "X-API-KEY": keys.serperApiKey! });
      const items: any[] = payload?.organic ?? [];
      return items.slice(0, limit).map((item) => cleanResult(item.title, item.link, item.snippet, "serper")).filter((r): r is SearchResult => r !== null);
    });
  }
  return {
    available: chain.length > 0,
    async search(query, limit) {
      const clean = query.trim();
      if (!clean) throw new CoreError("query 不能为空");
      const safe = Math.max(1, Math.min(Math.trunc(limit), 20));
      for (const run of chain) {
        try {
          const results = await run(clean, safe);
          if (results.length) return results;
        } catch {
          // next provider
        }
      }
      return [];
    },
  };
}

export const NO_SEARCH = "没配搜索服务：在设置里填 Bocha / Tavily / Serper 的 key（或装 ddgs）后才能搜网页";

export async function webSearch(search: SearchClient | null | undefined, query: string, limit = 8): Promise<{ query: string; items: SearchResult[] }> {
  if (!search?.available) throw new CoreError(NO_SEARCH, "unsupported");
  return { query, items: await search.search(query, limit) };
}
