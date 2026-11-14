import type { LlmClient } from "../llm";
import type { CoreContext, CoreStore } from "../types";
import type { HttpFetch, SearchClient } from "./net";

/**
 * Everything a tool may need, injected by the runtime. Browser: IndexedDB
 * store + BYOK LlmClient + global fetch. Node companion: SQLite store + the
 * configured LlmClient/search + local file helpers. Worker: no store writes.
 * A missing capability makes the tools that need it fail with
 * CoreError(code="unsupported") instead of crashing.
 */
export type ToolDeps = {
  store: CoreStore;
  ctx: CoreContext;
  llm?: LlmClient | null;
  fetch?: HttpFetch;
  search?: SearchClient | null;
  /** Local file text (companion only): split_resume({path}) uses it. */
  readFile?: (path: string) => Promise<{ path: string; text: string; truncated: boolean }>;
  /** Resume PDF export (resume domain): draft_email attaches it when present. */
  exportResumePdf?: (docId: number, name: string) => Promise<{ path: string }>;
};
