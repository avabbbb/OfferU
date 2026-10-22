import { isTauri } from "@tauri-apps/api/core";

const TOKEN_KEY = "offeru.ui_token";

/** Workbench served by an `offeru start` backend (same origin, port 8766). */
export function isLiteRuntime(): boolean {
  return !isTauri() && typeof window !== "undefined" && window.location.port === "8766";
}

export function liteToken(): string {
  return isLiteRuntime() ? window.localStorage.getItem(TOKEN_KEY) || "" : "";
}

export function saveLiteToken(token: string): void {
  window.localStorage.setItem(TOKEN_KEY, token);
}
