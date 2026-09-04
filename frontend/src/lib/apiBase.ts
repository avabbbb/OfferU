const LOCAL_API_HOSTS = new Set(["localhost", "127.0.0.1", "tauri.localhost"]);
const DEFAULT_API_BASE = "http://127.0.0.1:8765";

function normalizeConfiguredApiBase(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = new URL(value.trim());
    if (!/^https?:$/i.test(parsed.protocol)) return null;
    if (LOCAL_API_HOSTS.has(parsed.hostname)) return DEFAULT_API_BASE;
    // OfferU is a local-first desktop app. Do not let stale or injected build
    // settings redirect ordinary career data requests to an arbitrary origin.
    return null;
  } catch {
    return null;
  }
}

export function resolveApiBase(): string {
  const configured = normalizeConfiguredApiBase(
    import.meta.env.VITE_API_URL || process.env.NEXT_PUBLIC_API_URL,
  );
  if (configured) return configured;
  return DEFAULT_API_BASE;
}
