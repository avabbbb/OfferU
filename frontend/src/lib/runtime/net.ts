// The browser's own fetch, captured at module load — before web builds wrap
// window.fetch (lib/transport installFetchShim). Probes of the real local
// companion must use this one, never the shim.
export const nativeFetch: typeof fetch = typeof fetch === "function"
  ? fetch.bind(globalThis)
  : ((() => Promise.reject(new Error("fetch 不可用"))) as typeof fetch);
