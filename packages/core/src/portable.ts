// Portable data packages: export a store to JSON, import it back either
// replacing everything or merged in next to existing data with fresh ids.
// Pure: no DOM, no node:*. The file download/upload lives in the caller.

import { CoreError, type ChangeRow, type Json, type PlainRecord, type StoredRecord } from "./types";
import { isRecordType } from "./labels";
import { nextIds, type PortableState, type SyncableStore } from "./stores";

export const DATA_PACKAGE_FORMAT = "offeru.data-package";
export const DATA_PACKAGE_VERSION = 1;
/** Packages written by the old showcase demo store; still importable. */
export const LEGACY_DEMO_PACKAGE_FORMAT = "offeru.demo-package";

export type DataPackage = {
  app: "offeru";
  format: typeof DATA_PACKAGE_FORMAT;
  version: typeof DATA_PACKAGE_VERSION;
  scope: "core";
  exported_at: string;
  data: PortableState;
};

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export function buildPackage(state: PortableState, now = new Date()): DataPackage {
  return {
    app: "offeru",
    format: DATA_PACKAGE_FORMAT,
    version: DATA_PACKAGE_VERSION,
    scope: "core",
    exported_at: now.toISOString(),
    data: clone(state),
  };
}

export async function exportPackage(store: SyncableStore, now = new Date()): Promise<DataPackage> {
  return buildPackage(await store.exportState(), now);
}

function objectOf(value: unknown): Json | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Json : null;
}

/**
 * Validate a package (object or JSON text). Accepts current packages and the
 * legacy showcase `offeru.demo-package`; both carry the same state shape.
 */
export function parsePackage(raw: unknown): DataPackage {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      throw new CoreError("数据包不是有效 JSON。");
    }
  }
  const pkg = objectOf(value);
  const legacy = pkg?.format === LEGACY_DEMO_PACKAGE_FORMAT;
  if (!pkg || pkg.app !== "offeru" || (pkg.format !== DATA_PACKAGE_FORMAT && !legacy)) {
    throw new CoreError("这不是 OfferU 数据包。");
  }
  if (pkg.version !== 1) throw new CoreError("数据包版本不支持，请先更新页面。", "unsupported");
  if (legacy ? pkg.scope !== "demo-core" : pkg.scope !== "core") throw new CoreError("数据包范围不支持。", "unsupported");
  const data = objectOf(pkg.data);
  if (!data || data.version !== 1 || !Array.isArray(data.records) || !Array.isArray(data.changes)
    || typeof data.nextRecordId !== "number" || typeof data.nextChangeId !== "number") {
    throw new CoreError("数据包内容不完整或已损坏。");
  }
  const ids = new Set<number>();
  for (const record of data.records) {
    const item = objectOf(record);
    if (!item || typeof item.id !== "number" || !Number.isInteger(item.id) || !isRecordType(item.type)
      || typeof item.updated_at !== "string" || typeof item.created_at !== "string") {
      throw new CoreError("数据包里有格式不对的记录。");
    }
    if (ids.has(item.id)) throw new CoreError(`数据包里记录 #${item.id} 重复。`);
    ids.add(item.id);
    if (item.job_id !== null && item.job_id !== undefined && typeof item.job_id !== "number") {
      throw new CoreError("数据包里有格式不对的记录。");
    }
  }
  const changeIds = new Set<number>();
  for (const change of data.changes) {
    const item = objectOf(change);
    if (!item || typeof item.id !== "number" || typeof item.at !== "string" || typeof item.record_id !== "number"
      || !isRecordType(item.type) || typeof item.summary !== "string" || typeof item.actor !== "string") {
      throw new CoreError("数据包里有格式不对的改动。");
    }
    if (changeIds.has(item.id)) throw new CoreError(`数据包里改动 #${item.id} 重复。`);
    changeIds.add(item.id);
  }
  const state = clone(data) as unknown as PortableState;
  for (const record of state.records) record.job_id = typeof record.job_id === "number" ? record.job_id : null;
  for (const change of state.changes) change.undone_at = typeof change.undone_at === "string" ? change.undone_at : null;
  return {
    app: "offeru",
    format: DATA_PACKAGE_FORMAT,
    version: DATA_PACKAGE_VERSION,
    scope: "core",
    exported_at: typeof pkg.exported_at === "string" ? pkg.exported_at : "",
    data: { ...state, ...nextIds(state) },
  };
}

export type RemapResult = {
  state: PortableState;
  /** incoming record id -> new id */
  recordIds: Map<number, number>;
  skippedProfile: boolean;
};

function remapSnapshot(snapshot: PlainRecord | null, ids: Map<number, number>): PlainRecord | null {
  if (!snapshot) return snapshot;
  const next = { ...snapshot };
  if (typeof next.job_id === "number") next.job_id = ids.get(next.job_id) ?? null;
  return next;
}

/**
 * Give every incoming record and change a fresh id above `base`, rewriting
 * job_id links and change-log record ids so they still point at the right
 * rows. With `existingProfile` the incoming profile (there is only one
 * profile per store) and its change rows are dropped.
 */
export function remapState(
  incoming: PortableState,
  base: Pick<PortableState, "nextRecordId" | "nextChangeId">,
  options: { existingProfile?: boolean } = {},
): RemapResult {
  const ids = new Map<number, number>();
  let nextRecord = base.nextRecordId;
  let skippedProfile = false;
  const kept: StoredRecord[] = [];
  for (const record of [...incoming.records].sort((a, b) => a.id - b.id)) {
    if (record.type === "profile" && options.existingProfile) {
      skippedProfile = true;
      continue;
    }
    ids.set(record.id, nextRecord++);
    kept.push(record);
  }
  // Change rows about records that are gone (deleted before export) still need distinct ids.
  for (const change of [...incoming.changes].sort((a, b) => a.id - b.id)) {
    if (change.type === "profile" && options.existingProfile) continue;
    if (!ids.has(change.record_id)) ids.set(change.record_id, nextRecord++);
  }
  const records = kept.map((record) => ({
    ...clone(record),
    id: ids.get(record.id)!,
    job_id: record.job_id === null ? null : ids.get(record.job_id) ?? null,
  }));
  let nextChange = base.nextChangeId;
  const changes: ChangeRow[] = [...incoming.changes]
    .sort((a, b) => a.id - b.id)
    .filter((change) => !(change.type === "profile" && options.existingProfile))
    .map((change) => ({
      ...clone(change),
      id: nextChange++,
      record_id: ids.get(change.record_id)!,
      before: remapSnapshot(change.before, ids),
      after: remapSnapshot(change.after, ids),
    }));
  return {
    state: { version: 1, nextRecordId: nextRecord, nextChangeId: nextChange, records, changes },
    recordIds: ids,
    skippedProfile,
  };
}

/** Replace the whole store with the package. */
export async function importReplace(store: SyncableStore, pkg: DataPackage): Promise<{ records: number; changes: number }> {
  await store.replaceState(pkg.data);
  return { records: pkg.data.records.length, changes: pkg.data.changes.length };
}

/**
 * Add the package next to what is already there. Incoming ids are remapped
 * so nothing is overwritten; the incoming profile is skipped when one exists.
 */
export async function importMerge(
  store: SyncableStore,
  pkg: DataPackage,
): Promise<{ records: number; changes: number; skipped_profile: boolean }> {
  const current = await store.exportState();
  const { state, skippedProfile } = remapState(pkg.data, nextIds(current), {
    existingProfile: current.records.some((record) => record.type === "profile"),
  });
  const merged: PortableState = {
    version: 1,
    records: [...current.records, ...state.records],
    changes: [...current.changes, ...state.changes],
    nextRecordId: state.nextRecordId,
    nextChangeId: state.nextChangeId,
  };
  await store.replaceState(merged);
  return { records: state.records.length, changes: state.changes.length, skipped_profile: skippedProfile };
}
