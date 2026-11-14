import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

/** The companion's data directory (Python store.data_dir): OFFERU_DATA_DIR, created on demand. */
export function dataDir(...parts: string[]): string {
  const dir = join(process.env.OFFERU_DATA_DIR || resolve("backend-ts/.data"), ...parts);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function dbPath(): string {
  if (process.env.OFFERU_DB_PATH) return process.env.OFFERU_DB_PATH;
  return join(dataDir(), "offeru.db");
}
