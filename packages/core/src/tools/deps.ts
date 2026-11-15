import type { LlmClient } from "../llm";
import type { FileSource } from "../resume/render";
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
  /** Caller disconnected / cancelled: long tools (evaluate) stop between jobs. */
  signal?: AbortSignal;
  /** Local file text (companion only): split_resume({path}) uses it. */
  readFile?: (path: string) => Promise<{ path: string; text: string; truncated: boolean }>;
  /** Resume PDF export (resume domain): draft_email attaches it when present. */
  exportResumePdf?: (docId: number, name: string) => Promise<{ path: string }>;
  /** Uploaded files (photo / school logo) for resume rendering in tailor_resume. */
  files?: FileSource | null;
  /** A4 page count of resume HTML (companion: Playwright); absent = tailor_resume reviews without a page count. */
  measure?: ((html: string) => Promise<number | null>) | null;
};
