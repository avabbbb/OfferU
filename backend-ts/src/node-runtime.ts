import { join } from "node:path";

import { createSearchClient, type CoreStore, type SearchClient } from "@offeru/core";

import { llmFromEnv } from "./llm-env";
import { dataDir } from "./paths";
import { createLocalFiles } from "./routes/companion/files";
import type { ToolRuntime } from "./tools";

/**
 * Dev fallback for web search keys until the config domain (ts/interview-config)
 * injects the user's saved keys: BOCHA_API_KEY / TAVILY_API_KEY / SERPER_API_KEY,
 * the same env names Python Settings read. Read per call.
 */
export function searchFromEnv(env: NodeJS.ProcessEnv = process.env): SearchClient | null {
  const keys = { bochaApiKey: env.BOCHA_API_KEY?.trim(), tavilyApiKey: env.TAVILY_API_KEY?.trim(), serperApiKey: env.SERPER_API_KEY?.trim() };
  if (!keys.bochaApiKey && !keys.tavilyApiKey && !keys.serperApiKey) return null;
  return createSearchClient(keys, (input, init) => globalThis.fetch(input, init));
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
