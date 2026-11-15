// Per-device sync state. Kept locally next to the data (never uploaded):
// which remote repo we sync with, the last snapshot we merged (the three-way
// base), and the device-local id <-> global uid map.

import type { SyncRecord } from "./merge";

export type BaseEntry = { c: string[]; r: SyncRecord } | { t: string };

export type SyncState = {
  v: 1;
  device: string;
  repo_id: string | null;
  location: string | null;
  last_index: string | null;
  last_sync_at: string | null;
  /** local record id -> uid */
  uids: Record<string, string>;
  /** uid -> record as of the last synced snapshot */
  base: Record<string, BaseEntry>;
};

export interface SyncStateStore {
  load(): Promise<SyncState | null>;
  save(state: SyncState): Promise<void>;
}

export class MemoryStateStore implements SyncStateStore {
  private value: SyncState | null = null;

  async load(): Promise<SyncState | null> {
    return this.value ? structuredClone(this.value) : null;
  }

  async save(state: SyncState): Promise<void> {
    this.value = structuredClone(state);
  }
}

export function emptyState(device: string): SyncState {
  return { v: 1, device, repo_id: null, location: null, last_index: null, last_sync_at: null, uids: {}, base: {} };
}
