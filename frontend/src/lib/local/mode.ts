// Build mode of the web app.
//   local-web : the Cloudflare Worker / static build. /api/* is answered in the page by the
//               backend-ts Hono app over IndexedDB (see backend.ts); nothing is stored server-side.
//   (unset)   : desktop (Tauri) and dev against the companion: /api/* goes to the real local server.
export const OFFERU_MODE: string = import.meta.env.VITE_OFFERU_MODE || "";
export const LOCAL_WEB = OFFERU_MODE === "local-web";
