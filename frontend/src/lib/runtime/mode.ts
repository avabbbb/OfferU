// Which runtime this build talks to. No imports: everything else reads these.
//
// - Desktop / dev builds (default): HTTP to the local backend at 127.0.0.1:8766
//   (Python today, the Node companion `backend-ts` later).
// - Web builds (Cloudflare Pages): the same Hono app runs inside the page over
//   IndexedDB ("browser runtime"); no companion needed. A paired local
//   companion (lib/bridge) switches the page to HTTP.
//     VITE_RUNTIME=browser   TO C web app: starts empty.
//     VITE_SHOWCASE=true     public showcase: same runtime, seeded with
//                            fictional demo data, recorded replay for routes
//                            the browser runtime does not serve yet.

const env = (import.meta as { env?: Record<string, string | undefined> }).env ?? {};

/** Seeded showcase build (fictional demo data + snapshot replay fallback). */
export const DEMO_SEED = process.env.VITE_SHOWCASE === "true";

/** Any static web build: data lives in this browser unless a companion is paired. */
export const WEB_RUNTIME = DEMO_SEED || env.VITE_RUNTIME === "browser";
