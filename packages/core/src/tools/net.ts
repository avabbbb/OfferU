// Network-backed tools: fetch_page and web_search. Everything goes through an
// injected `fetch` (global fetch in Node / Workers / browser, a fake in tests).

import { CoreError } from "../types";
import { cleanText, guard, guardCounts, guardWarning, unescapeHtml, type GuardCounts } from "./posting-guard";
import { searchExa } from "./search/exa";
import { searchFirecrawl } from "./search/firecrawl";
import { searchKeenable } from "./search/keenable";
import { searchParallel } from "./search/parallel";
import type { ProviderCall, RawHit } from "./search/shared";

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

export type SearchResult = {
  title: string;
  url: string;
  snippet: string;
  engine: string;
  /** Publish date as the provider gave it (ISO date or date-time); only set when the provider returns one. */
  published?: string;
};

export type SearchOutcome = { items: SearchResult[]; errors: string[] };

/** A search backend. `search` returns [] for "nothing found"; `available` false means nothing is configured. */
export interface SearchClient {
  readonly available: boolean;
  search(query: string, limit: number): Promise<SearchResult[]>;
  /** Same as search, plus each provider's failure (`name: reason`) when every provider failed or came back empty. */
  searchDetailed?(query: string, limit: number): Promise<SearchOutcome>;
}

/** Keyed (paid) providers ported from Python, then the providers that also have a keyless path. */
export const KEYED_SEARCH_PROVIDERS = ["bocha", "tavily", "serper"] as const;
export const KEYLESS_SEARCH_PROVIDERS = ["parallel", "exa", "firecrawl", "keenable"] as const;
export type SearchProviderId = (typeof KEYED_SEARCH_PROVIDERS)[number] | (typeof KEYLESS_SEARCH_PROVIDERS)[number];
export const SEARCH_PROVIDERS: readonly ("auto" | SearchProviderId)[] = ["auto", ...KEYED_SEARCH_PROVIDERS, ...KEYLESS_SEARCH_PROVIDERS];

export type SearchKeys = {
  provider?: "auto" | SearchProviderId;
  bochaApiKey?: string;
  tavilyApiKey?: string;
  serperApiKey?: string;
  parallelApiKey?: string;
  exaApiKey?: string;
  firecrawlApiKey?: string;
  keenableApiKey?: string;
  /** Allow the keyless public endpoints of parallel / exa / firecrawl / keenable (default true). */
  keyless?: boolean;
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

function cleanResult(title: unknown, url: unknown, snippet: unknown, engine: string, published?: unknown): SearchResult | null {
  const clean = String(url ?? "").trim();
  if (!clean || !isPublicHttpUrl(clean)) return null;
  const result: SearchResult = {
    title: String(title ?? "").trim().slice(0, 300),
    url: clean.slice(0, 2000),
    snippet: String(snippet ?? "").trim().slice(0, 1000),
    engine,
  };
  const date = typeof published === "string" ? published.trim().slice(0, 40) : "";
  if (date) result.published = date;
  return result;
}

/**
 * Search fallback chain (Python services/web_search.web_search, extended):
 * auto = providers the user gave a key for first (bocha → tavily → serper → parallel → exa →
 * firecrawl → keenable), then the keyless public endpoints parallel → exa → firecrawl → keenable.
 * An explicit provider runs only that one (with its key if set, else keyless where it has a
 * keyless path). First non-empty result wins; provider errors fall through. ddgs (a Python-only
 * optional package) is not ported.
 */
export function createSearchClient(keys: SearchKeys, fetcher: HttpFetch): SearchClient {
  const provider = keys.provider ?? "auto";
  if (!SEARCH_PROVIDERS.includes(provider)) throw new CoreError(`未知 search_provider: ${provider}`, "invalid");
  const keyless = keys.keyless !== false;
  type Runner = { name: string; run: (query: string, limit: number) => Promise<SearchResult[]> };
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
  const wants = (name: SearchProviderId) => provider === "auto" || provider === name;
  const ported = (name: SearchProviderId, call: ProviderCall, apiKey?: string): Runner => ({
    name: apiKey ? name : `${name}(免 Key)`,
    run: async (query, limit) => (await call(fetcher, query, limit))
      .map((hit) => cleanResult(hit.title, hit.url, hit.snippet, name, hit.published))
      .filter((r): r is SearchResult => r !== null)
      .slice(0, limit),
  });
  const PORTED: Record<(typeof KEYLESS_SEARCH_PROVIDERS)[number], { key?: string; search: (f: HttpFetch, q: string, n: number, key?: string) => Promise<RawHit[]> }> = {
    parallel: { key: keys.parallelApiKey, search: searchParallel },
    exa: { key: keys.exaApiKey, search: searchExa },
    firecrawl: { key: keys.firecrawlApiKey, search: searchFirecrawl },
    keenable: { key: keys.keenableApiKey, search: searchKeenable },
  };
  const chain: Runner[] = [];
  if (wants("bocha") && keys.bochaApiKey) {
    chain.push({ name: "bocha", run: async (query, limit) => {
      const payload = await post("https://api.bochaai.com/v1/web-search", { query, count: limit, summary: true }, { Authorization: `Bearer ${keys.bochaApiKey}` });
      const items: any[] = payload?.data?.webPages?.value ?? [];
      return items.slice(0, limit).map((item) => cleanResult(item.name, item.url, item.summary || item.snippet, "bocha")).filter((r): r is SearchResult => r !== null);
    } });
  }
  if (wants("tavily") && keys.tavilyApiKey) {
    chain.push({ name: "tavily", run: async (query, limit) => {
      const payload = await post("https://api.tavily.com/search", { api_key: keys.tavilyApiKey, query, max_results: limit });
      const items: any[] = payload?.results ?? [];
      return items.slice(0, limit).map((item) => cleanResult(item.title, item.url, item.content, "tavily")).filter((r): r is SearchResult => r !== null);
    } });
  }
  if (wants("serper") && keys.serperApiKey) {
    chain.push({ name: "serper", run: async (query, limit) => {
      const payload = await post("https://google.serper.dev/search", { q: query, num: limit }, { "X-API-KEY": keys.serperApiKey! });
      const items: any[] = payload?.organic ?? [];
      return items.slice(0, limit).map((item) => cleanResult(item.title, item.link, item.snippet, "serper")).filter((r): r is SearchResult => r !== null);
    } });
  }
  // Keyed mode of the newer providers, still before any keyless endpoint.
  for (const name of KEYLESS_SEARCH_PROVIDERS) {
    const { key, search } = PORTED[name];
    if (wants(name) && key) chain.push(ported(name, (f, q, n) => search(f, q, n, key), key));
  }
  if (keyless) {
    for (const name of KEYLESS_SEARCH_PROVIDERS) {
      const { key, search } = PORTED[name];
      if (wants(name) && !key) chain.push(ported(name, (f, q, n) => search(f, q, n)));
    }
  }
  const searchDetailed = async (query: string, limit: number): Promise<SearchOutcome> => {
    const clean = query.trim();
    if (!clean) throw new CoreError("query 不能为空");
    const safe = Math.max(1, Math.min(Math.trunc(limit), 20));
    const errors: string[] = [];
    for (const { name, run } of chain) {
      try {
        const results = await run(clean, safe);
        if (results.length) return { items: results, errors: [] };
        errors.push(`${name}: 没有结果`);
      } catch (cause) {
        errors.push(`${name}: ${(cause instanceof Error ? cause.message : String(cause)).slice(0, 200)}`);
      }
    }
    return { items: [], errors };
  };
  return {
    available: chain.length > 0,
    searchDetailed,
    async search(query, limit) {
      return (await searchDetailed(query, limit)).items;
    },
  };
}

export const NO_SEARCH = "没配搜索服务：选「自动」可用免 Key 搜索（Parallel / Exa / Firecrawl / Keenable），或填 Bocha / Tavily / Serper 等的 key 后才能搜网页";

/** web_search tool. `errors` (provider: reason) appears only when nothing came back, so the Agent can say why. */
export async function webSearch(search: SearchClient | null | undefined, query: string, limit = 8): Promise<{ query: string; items: SearchResult[]; errors?: string[] }> {
  if (!search?.available) throw new CoreError(NO_SEARCH, "unsupported");
  if (!search.searchDetailed) return { query, items: await search.search(query, limit) };
  const { items, errors } = await search.searchDetailed(query, limit);
  return items.length || !errors.length ? { query, items } : { query, items, errors };
}
