import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { CoreStore } from "@offeru/core";
import type { FetchLike, SyncState, SyncStateStore } from "@offeru/sync";

import { SyncService, type StoredSyncSettings, type SyncSettingsStore } from "./syncService";

/**
 * Node companion side of sync: settings and state live next to the SQLite
 * file, never anywhere else. sync.json holds the bucket credentials and the
 * passphrase (chmod 600, same trust level as the database itself);
 * sync-state.json holds the three-way base, id map and upload checkpoint.
 */
class FileStateStore implements SyncStateStore {
  constructor(private readonly path: string) {}

  async load(): Promise<SyncState | null> {
    return existsSync(this.path) ? JSON.parse(readFileSync(this.path, "utf8")) as SyncState : null;
  }

  async save(state: SyncState): Promise<void> {
    writeFileSync(this.path, JSON.stringify(state));
  }
}

function fileSettings(path: string): SyncSettingsStore {
  return {
    async load() {
      return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as StoredSyncSettings : null;
    },
    async save(settings) {
      writeFileSync(path, JSON.stringify(settings, null, 2), { mode: 0o600 });
      try {
        chmodSync(path, 0o600);
      } catch {
        // Windows: ACLs, not modes
      }
    },
    async clear() {
      rmSync(path, { force: true });
    },
    secretsMode: async () => "stored",
  };
}

export class CompanionSync extends SyncService {
  constructor(store: CoreStore, dir: string, options: { fetch?: FetchLike; kdfIterations?: number } = {}) {
    mkdirSync(dir, { recursive: true });
    super(store, fileSettings(join(dir, "sync.json")), new FileStateStore(join(dir, "sync-state.json")), options);
  }
}
