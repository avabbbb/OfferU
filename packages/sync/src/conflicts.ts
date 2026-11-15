// Conflict view. A true conflict (two devices changed the same field to
// different values) is resolved automatically by updated_at, and the losing
// values are kept as a doc note with a structured `sync_conflict` field (see
// SyncEngine.conflictCopy). This module lists those notes as "mine vs theirs"
// from the point of view of the device asking, and resolves one:
//
//   keep the side that currently won  -> just delete the note
//   keep the side that lost           -> write the losing values back onto the
//                                        record (one undoable change), delete the note
//
// The note syncs like any record, so resolving on one device clears it everywhere.

import { type CoreStore, type Json, type StoredRecord, TYPE_LABEL, label, plain } from "../../core/src/index";
import type { RecordType } from "../../core/src/index";

import { SyncError } from "./errors";
import type { SyncState } from "./state";

type ConflictMeta = {
  uid: string;
  type: RecordType;
  fields: string[];
  at: string;
  loser?: "local" | "remote";
  device?: string;
  values?: Record<string, unknown>;
};

export type ConflictView = {
  /** id of the conflict note (type doc) */
  id: number;
  title: string;
  at: string;
  record: { uid: string; type: RecordType; id: number | null; label: string };
  fields: string[];
  /** this device's values for the conflicting fields */
  mine: Record<string, unknown>;
  /** the other device's values */
  theirs: Record<string, unknown>;
  /** which side the record currently holds */
  current: "mine" | "theirs";
  /** false for notes written before structured values existed, or whose record is gone */
  resolvable: boolean;
};

function metaOf(record: StoredRecord): ConflictMeta | null {
  const meta = (record as Json).sync_conflict as ConflictMeta | undefined;
  return meta && typeof meta === "object" && typeof meta.uid === "string" && Array.isArray(meta.fields) ? meta : null;
}

function idByUid(state: SyncState | null): Map<string, number> {
  const map = new Map<string, number>();
  for (const [id, uid] of Object.entries(state?.uids ?? {})) map.set(uid, Number(id));
  return map;
}

function currentValue(record: StoredRecord, field: string, uidOf: Map<number, string>): unknown {
  if (field === "job_id") return record.job_id === null || record.job_id === undefined ? null : uidOf.get(record.job_id) ?? null;
  return (record as Json)[field] ?? null;
}

async function findRecord(store: CoreStore, type: RecordType, id: number | undefined): Promise<StoredRecord | null> {
  return id === undefined ? null : store.get(type, id);
}

export async function listConflicts(store: CoreStore, state: SyncState | null): Promise<ConflictView[]> {
  const ids = idByUid(state);
  const uidOf = new Map([...ids].map(([uid, id]) => [id, uid]));
  const out: ConflictView[] = [];
  for (const note of await store.all("doc")) {
    const meta = metaOf(note);
    if (!meta) continue;
    const record = await findRecord(store, meta.type, ids.get(meta.uid));
    const lost: Record<string, unknown> = meta.values ?? {};
    const now: Record<string, unknown> = {};
    for (const field of meta.fields) now[field] = record ? currentValue(record, field, uidOf) : null;
    // `loser` was written from the perspective of the device that wrote the note.
    const writtenHere = !meta.device || meta.device === state?.device;
    const loserIsMine = writtenHere ? meta.loser === "local" : meta.loser === "remote";
    out.push({
      id: note.id,
      title: typeof note.title === "string" ? note.title : label(note),
      at: meta.at,
      record: { uid: meta.uid, type: meta.type, id: record?.id ?? null, label: record ? label(record) : `${TYPE_LABEL[meta.type]}（已删除）` },
      fields: meta.fields,
      mine: loserIsMine ? lost : now,
      theirs: loserIsMine ? now : lost,
      current: loserIsMine ? "theirs" : "mine",
      resolvable: Boolean(record && meta.values && meta.loser),
    });
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : -1));
}

export async function resolveConflict(
  store: CoreStore,
  state: SyncState | null,
  noteId: number,
  keep: "mine" | "theirs",
  ctx: { actor: string; now: string },
): Promise<{ applied: boolean; conflict: ConflictView }> {
  const conflict = (await listConflicts(store, state)).find((item) => item.id === noteId);
  if (!conflict) throw new SyncError("config", "这条冲突已经处理过了");
  const ids = idByUid(state);
  return store.transaction(async () => {
    let applied = false;
    if (keep !== conflict.current) {
      if (!conflict.resolvable || conflict.record.id === null) throw new SyncError("config", "这条冲突记录太旧或原记录已删除，只能手动对照笔记修改");
      const before = await store.get(conflict.record.type, conflict.record.id);
      if (!before) throw new SyncError("config", "原记录已删除");
      const values = keep === "mine" ? conflict.mine : conflict.theirs;
      const { id: _id, type: _type, job_id: jobId, created_at: createdAt, updated_at: _updated, ...data } = before;
      let linked = jobId ?? null;
      for (const [field, value] of Object.entries(values)) {
        if (field === "job_id") linked = typeof value === "string" ? ids.get(value) ?? null : null;
        else if (value === null || value === undefined) delete data[field];
        else data[field] = value;
      }
      const saved = await store.put(conflict.record.type, data, { id: before.id, jobId: linked, now: ctx.now, createdAt, replace: true });
      await store.addChange({
        at: ctx.now,
        actor: ctx.actor,
        summary: `处理同步冲突：${TYPE_LABEL[saved.type]}「${label(saved)}」改用${keep === "mine" ? "这台设备" : "另一台设备"}的版本`,
        type: saved.type,
        record_id: saved.id,
        before: plain(before),
        after: plain(saved),
      });
      applied = true;
    }
    const note = await store.get("doc", noteId);
    if (note) {
      await store.remove("doc", noteId);
      await store.addChange({
        at: ctx.now,
        actor: ctx.actor,
        summary: `处理同步冲突：删除「${label(note)}」`,
        type: "doc",
        record_id: noteId,
        before: plain(note),
        after: null,
      });
    }
    return { applied, conflict };
  });
}
