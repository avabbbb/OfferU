import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { dbPath } from "./paths";

let cached: string | null = null;

export function tokenPath(): string {
  return join(dirname(dbPath()), "bridge_token");
}

/** Local secret for the static showcase bridge; never an account credential. */
export function pairingToken(): string {
  if (cached) return cached;
  const path = tokenPath();
  try {
    const existing = readFileSync(path, "utf8").trim();
    if (existing.length >= 24) {
      cached = existing;
      return existing;
    }
  } catch {
    // create below
  }
  const token = randomBytes(32).toString("base64url");
  writeFileSync(path, token, { encoding: "utf8", mode: 0o600 });
  cached = token;
  return token;
}
