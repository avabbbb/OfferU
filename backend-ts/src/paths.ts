import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

export function dbPath(): string {
  if (process.env.OFFERU_DB_PATH) return process.env.OFFERU_DB_PATH;
  const dir = process.env.OFFERU_DATA_DIR || resolve("backend-ts/.data");
  mkdirSync(dir, { recursive: true });
  return join(dir, "offeru.db");
}
