// After a deploy the Worker no longer serves the previous build's hashed chunks, so a tab that was
// opened before the deploy fails on its next lazy route ("Failed to fetch dynamically imported module").
// Reload once to pick up the new index.html; a timestamp in sessionStorage stops a reload loop when the
// chunk is really broken (then the error boundary shows its recovery card instead).

const KEY = "offeru:chunk-reload-at";
const WINDOW_MS = 30_000;

const CHUNK_ERROR = /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS|ChunkLoadError|Loading chunk [\w-]+ failed/i;

export function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error ?? "");
  return CHUNK_ERROR.test(message);
}

/** Reloads the page and returns true, unless we already reloaded for this within the last 30s. */
export function reloadOnceForStaleChunk(storage: Pick<Storage, "getItem" | "setItem"> | null = safeSession(), now = Date.now(), reload = () => window.location.reload()): boolean {
  const last = Number(storage?.getItem(KEY) || 0);
  if (last && now - last < WINDOW_MS) return false;
  try { storage?.setItem(KEY, String(now)); } catch { /* private mode: still reload once */ }
  reload();
  return true;
}

function safeSession(): Storage | null {
  try { return window.sessionStorage; } catch { return null; }
}

/** Vite fires vite:preloadError when a dynamic import's chunk or CSS fails to load. */
export function installStaleChunkReload(): void {
  window.addEventListener("vite:preloadError", (event) => {
    if (reloadOnceForStaleChunk()) event.preventDefault();
  });
}
