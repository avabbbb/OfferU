// Store capabilities beyond CoreStore: whole-state export/replace (data
// packages, demo reset) and per-record enumeration (S3 sync). Both the browser
// IndexedDB store and the companion SQLite store implement SyncableStore, and
// packages/core/testing/storeContract.ts holds them to the same behaviour.

import type { ChangeRow, CoreStore, RecordType, StoredRecord } from "./types";

/** A whole store as plain JSON: what a data package carries and replaceState() loads. */
export type PortableState = {
  version: 1;
  /** Next id the store would hand out; never below max(record id, change record_id) + 1. */
  nextRecordId: number;
  nextChangeId: number;
  records: StoredRecord[];
  changes: ChangeRow[];
};

/**
 * One row of the per-record index sync diffs against.
 * `rev` is a store-wide counter: every write gives the record (or its
 * tombstone) a rev greater than any rev handed out before, so "changed since
 * the last sync" is `rev > lastSyncedRev`. Deleted records stay listed as
 * tombstones (`deleted: true`, `updated_at` = deletion time) until the store is
 * replaced or the record is re-created with the same id (undo of a delete).
 */
export type RecordEntry = {
  id: number;
  type: RecordType;
  rev: number;
  updated_at: string;
  deleted: boolean;
};

export interface SyncableStore extends CoreStore {
  /** Every live record and every tombstone, ordered by id. */
  entries(): Promise<RecordEntry[]>;
  /** Highest rev handed out so far (0 for a fresh store). */
  storeRev(): Promise<number>;
  /** Records and change log as plain JSON, ordered by id. */
  exportState(): Promise<PortableState>;
  /**
   * Replace everything atomically. Ids are kept as given. Records that existed
   * before and are absent from `state` get tombstones so a later sync deletes
   * them on the other side too.
   */
  replaceState(state: PortableState): Promise<void>;
}

export function emptyState(): PortableState {
  return { version: 1, nextRecordId: 1, nextChangeId: 1, records: [], changes: [] };
}

/** The smallest safe next ids for a state (ids are never reused). */
export function nextIds(state: Pick<PortableState, "records" | "changes"> & Partial<PortableState>): { nextRecordId: number; nextChangeId: number } {
  let record = Number(state.nextRecordId ?? 1);
  let change = Number(state.nextChangeId ?? 1);
  for (const row of state.records) record = Math.max(record, row.id + 1);
  for (const row of state.changes) {
    record = Math.max(record, row.record_id + 1);
    change = Math.max(change, row.id + 1);
  }
  return { nextRecordId: record, nextChangeId: change };
}
