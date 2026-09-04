export const DEFAULT_OFFERU_SERVER_URL = "http://127.0.0.1:8765";
export const DEFAULT_OFFERU_FRONTEND_PORT = "7410";
export const DEFAULT_OFFERU_FRONTEND_URL = `http://127.0.0.1:${DEFAULT_OFFERU_FRONTEND_PORT}`;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "tauri.localhost"]);

export function normalizeOfferUServerUrl(input: unknown): string {
  const value = typeof input === "string" && input.trim()
    ? input.trim()
    : DEFAULT_OFFERU_SERVER_URL;
  try {
    const parsed = new URL(value);
    if (!/^https?:$/i.test(parsed.protocol)) {
      return DEFAULT_OFFERU_SERVER_URL;
    }
    if (LOCAL_HOSTS.has(parsed.hostname)) {
      // OfferU's local backend has one public origin; this also repairs old
      // stored values such as :8080, :8000, :7410 and an implicit :80.
      return DEFAULT_OFFERU_SERVER_URL;
    }
    return parsed.origin;
  } catch {
    return DEFAULT_OFFERU_SERVER_URL;
  }
}

/** The desktop web UI has one supported local port; stale custom values fail closed. */
export function normalizeOfferUFrontendPort(_input: unknown): string {
  return DEFAULT_OFFERU_FRONTEND_PORT;
}
