import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

import type { ConsentRecord, ConsentStore } from "@offeru/core";

/** Python core/consent.py: <data>/platform-consent.json; a missing or corrupt file = not agreed. */
export function nodeConsentFile(path: string): ConsentStore {
  return {
    async load() {
      if (!existsSync(path)) return null;
      try {
        const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
        return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as ConsentRecord : null;
      } catch {
        return null;
      }
    },
    async save(record) {
      if (!record) {
        rmSync(path, { force: true });
        return;
      }
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify(record, null, 2), "utf8");
      renameSync(tmp, path);
    },
  };
}
