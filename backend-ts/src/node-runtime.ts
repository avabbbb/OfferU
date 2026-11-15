import { join } from "node:path";

import { createSearchClient, SEARCH_PROVIDERS, type CoreStore, type SearchClient, type SearchKeys } from "@offeru/core";

import { llmFromEnv } from "./llm-env";
import { dataDir } from "./paths";
import { createLocalFiles } from "./routes/companion/files";
import type { ToolRuntime } from "./tools";

/**
 * Web search keys until the config domain injects the user's saved keys: the same env names
 * Python Settings read (SEARCH_PROVIDER, BOCHA_API_KEY / TAVILY_API_KEY / SERPER_API_KEY) plus
 * PARALLEL_API_KEY / EXA_API_KEY / FIRECRAWL_API_KEY / KEENABLE_API_KEY. With no key at all the
 * keyless public endpoints (parallel → exa → firecrawl → keenable) still work;
 * OFFERU_SEARCH_KEYLESS=0 turns them off. Read per call.
 */
export function searchFromEnv(env: NodeJS.ProcessEnv = process.env): SearchClient | null {
  const key = (name: string) => env[name]?.trim() || undefined;
  const provider = (key("SEARCH_PROVIDER")?.toLowerCase() ?? "auto") as SearchKeys["provider"];
  const keys: SearchKeys = {
    provider: SEARCH_PROVIDERS.includes(provider!) ? provider : "auto",
    bochaApiKey: key("BOCHA_API_KEY"),
    tavilyApiKey: key("TAVILY_API_KEY"),
    serperApiKey: key("SERPER_API_KEY"),
    parallelApiKey: key("PARALLEL_API_KEY"),
    exaApiKey: key("EXA_API_KEY"),
    firecrawlApiKey: key("FIRECRAWL_API_KEY"),
    keenableApiKey: key("KEENABLE_API_KEY"),
    keyless: !/^(0|false|off|no)$/i.test(key("OFFERU_SEARCH_KEYLESS") ?? ""),
  };
  const client = createSearchClient(keys, (input, init) => globalThis.fetch(input, init));
  return client.available ? client : null;
}

/** Everything the shared tools get on the Node companion: model, search, network, local files. */
export function nodeToolRuntime(store: CoreStore): Required<Pick<ToolRuntime, "store" | "llm" | "search" | "fetch" | "companion">> {
  const files = createLocalFiles(join(dataDir(), "files"));
  return {
    store,
    llm: () => llmFromEnv(),
    search: () => searchFromEnv(),
    fetch: (input, init) => globalThis.fetch(input, init),
    companion: { handlers: files.handlers, readFile: files.readFile },
  };
}
