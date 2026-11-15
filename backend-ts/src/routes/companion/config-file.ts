import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

import type { ConfigStore, StoredConfig } from "@offeru/core";

/**
 * Companion ConfigStore: <data>/offeru-ts-config.json, owner-only (0600). Keys
 * are stored as entered; the OS keychain integration of the Python backend is
 * not ported yet. A missing or corrupt file reads as "nothing configured".
 */
export function nodeConfigFile(path: string): ConfigStore {
  return {
    async load() {
      if (!existsSync(path)) return null;
      try {
        const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
        return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Partial<StoredConfig> : null;
      } catch {
        return null;
      }
    },
    async save(config) {
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify(config, null, 2), { encoding: "utf8", mode: 0o600 });
      renameSync(tmp, path);
      try { chmodSync(path, 0o600); } catch { /* best effort on Windows */ }
    },
  };
}
