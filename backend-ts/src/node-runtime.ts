import { dirname, join } from "node:path";

import { createSearchClient, type CoreStore, type SearchClient } from "@offeru/core";

import { llmFromEnv } from "./llm-env";
import { dataDir, dbPath } from "./paths";
import { createLocalFiles } from "./routes/companion/files";
import { exportResumePdf, filesDirFor, nodeFileStore, playwrightRenderer } from "./routes/companion/resume";
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
export function nodeToolRuntime(store: CoreStore): Required<Pick<ToolRuntime, "store" | "llm" | "search" | "fetch" | "companion">> & Pick<ToolRuntime, "files" | "measure" | "exportResumePdf"> {
  const files = createLocalFiles(join(dataDir(), "files"));
  const uploads = nodeFileStore(filesDirFor(dbPath()));
  const renderer = playwrightRenderer();
  return {
    files: uploads,
    measure: (html) => renderer.pageCount(html),
    exportResumePdf: (docId, name) => exportResumePdf({ store, files: uploads, renderer }, join(dirname(dbPath()), "exports"), docId, name),
    store,
    llm: () => llmFromEnv(),
    search: () => searchFromEnv(),
    fetch: (input, init) => globalThis.fetch(input, init),
    companion: { handlers: files.handlers, readFile: files.readFile },
  };
}
