// Ask the browser to keep IndexedDB "offeru-local" under storage pressure (and Safari's 7-day
// eviction). Without it the user's jobs, profile and resumes are "best effort" storage.
// Browsers decide on their own (engagement, installed PWA, bookmarks); the answer can be "no".

export type PersistenceState = "persisted" | "best-effort" | "unsupported";

let requested: Promise<PersistenceState> | null = null;

function storageManager(): StorageManager | undefined {
  return typeof navigator === "undefined" ? undefined : navigator.storage;
}

/** Called once when the in-page backend opens IndexedDB; later calls reuse the first answer unless `again`. */
export function requestPersistentStorage(again = false): Promise<PersistenceState> {
  if (requested && !again) return requested;
  const storage = storageManager();
  requested = !storage?.persist
    ? Promise.resolve("unsupported")
    : storage.persist().then((ok) => (ok ? "persisted" : "best-effort"), () => "best-effort" as const);
  return requested;
}

/** Current answer without prompting; also reports usage so Settings can say how much is at stake. */
export async function readPersistence(): Promise<{ state: PersistenceState; usage?: number; quota?: number }> {
  const storage = storageManager();
  if (!storage?.persisted) return { state: "unsupported" };
  const [persisted, estimate] = await Promise.all([
    storage.persisted().catch(() => false),
    storage.estimate ? storage.estimate().catch(() => undefined) : Promise.resolve(undefined),
  ]);
  return { state: persisted ? "persisted" : "best-effort", usage: estimate?.usage, quota: estimate?.quota };
}
