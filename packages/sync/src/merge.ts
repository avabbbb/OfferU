// Pure three-way, per-record merge. No I/O.
//
// base   = the record as of the last snapshot this device synced
// local  = the record in the local store now
// remote = the record in the newest remote snapshot
//
// A side that did not change since base yields to the side that did. When
// both changed, fields are merged one by one; a field both sides changed to
// different values is a true conflict: the later updated_at wins and the
// losing version is returned so the caller can keep it as a conflict copy.
// An edit always beats a concurrent delete (nothing is silently lost).

import type { Json, RecordType } from "../../core/src/index";

import { canonicalJson } from "./bytes";

export type SyncRecord = {
  uid: string;
  type: RecordType;
  /** uid of the linked job (job_id is device-local, uids are global). */
  job: string | null;
  data: Json;
  created_at: string;
  updated_at: string;
};

export type Tomb = { uid: string; deleted_at: string };
export type Side = SyncRecord | Tomb | undefined;

export type MergeOutcome = {
  value: SyncRecord | Tomb | undefined;
  conflict?: { winner: "local" | "remote"; loser: SyncRecord; fields: string[] };
  /** An edit on this side won over a delete on the other side. */
  resurrected?: "local" | "remote";
};

const JOB_FIELD = "$job";

export function isLive(side: Side): side is SyncRecord {
  return Boolean(side && "type" in side);
}

export function isTombSide(side: Side): side is Tomb {
  return Boolean(side && "deleted_at" in side);
}

export function contentOf(record: SyncRecord): string {
  return canonicalJson({ type: record.type, job: record.job, data: record.data });
}

export function sameContent(a: SyncRecord, b: SyncRecord): boolean {
  return contentOf(a) === contentOf(b);
}

function laterOf(a: string, b: string): string {
  return a >= b ? a : b;
}

function earlierOf(a: string, b: string): string {
  return a <= b ? a : b;
}

/** Deterministic winner for true conflicts: later updated_at, then larger content (same answer on every device). */
export function lwwWinner(local: SyncRecord, remote: SyncRecord): "local" | "remote" {
  if (local.updated_at !== remote.updated_at) return local.updated_at > remote.updated_at ? "local" : "remote";
  return contentOf(local) > contentOf(remote) ? "local" : "remote";
}

function fieldsOf(record: SyncRecord | undefined): Record<string, unknown> {
  if (!record) return {};
  return { ...record.data, [JOB_FIELD]: record.job };
}

export function mergeRecord(base: Side, local: Side, remote: Side): MergeOutcome {
  const B = isLive(base) ? base : undefined;
  const L = isLive(local) ? local : undefined;
  const R = isLive(remote) ? remote : undefined;

  if (!L && !R) {
    const tombs = [local, remote, base].filter(isTombSide);
    if (!tombs.length) return { value: undefined };
    return { value: tombs.reduce((a, b) => (a.deleted_at >= b.deleted_at ? a : b)) };
  }

  if (L && !R) {
    const remoteDeleted = Boolean(B) || isTombSide(remote);
    if (!remoteDeleted) return { value: L }; // created locally
    if (B && sameContent(L, B)) return { value: isTombSide(remote) ? remote : { uid: L.uid, deleted_at: L.updated_at } };
    return { value: L, resurrected: "local" };
  }

  if (R && !L) {
    const localDeleted = Boolean(B) || isTombSide(local);
    if (!localDeleted) return { value: R }; // created remotely
    if (B && sameContent(R, B)) return { value: isTombSide(local) ? local : { uid: R.uid, deleted_at: R.updated_at } };
    return { value: R, resurrected: "remote" };
  }

  const l = L!;
  const r = R!;
  const stamps = { created_at: earlierOf(l.created_at, r.created_at), updated_at: laterOf(l.updated_at, r.updated_at) };
  if (sameContent(l, r)) return { value: { ...l, ...stamps } };
  if (B && sameContent(l, B)) return { value: r };
  if (B && sameContent(r, B)) return { value: l };

  const winner = lwwWinner(l, r);
  const b = fieldsOf(B);
  const lf = fieldsOf(l);
  const rf = fieldsOf(r);
  const keys = [...new Set([...Object.keys(b), ...Object.keys(lf), ...Object.keys(rf)])].sort();
  const merged: Record<string, unknown> = {};
  const conflicts: string[] = [];
  for (const key of keys) {
    const bv = canonicalJson(b[key]);
    const lv = canonicalJson(lf[key]);
    const rv = canonicalJson(rf[key]);
    let pick: unknown;
    if (lv === rv || rv === bv) pick = lf[key];
    else if (lv === bv) pick = rf[key];
    else {
      pick = winner === "local" ? lf[key] : rf[key];
      conflicts.push(key === JOB_FIELD ? "job_id" : key);
    }
    if (pick !== undefined && pick !== null) merged[key] = pick;
  }
  const { [JOB_FIELD]: job, ...data } = merged;
  const value: SyncRecord = { uid: l.uid, type: l.type, job: typeof job === "string" ? job : null, data: data as Json, ...stamps };
  if (!conflicts.length) return { value };
  return { value, conflict: { winner, loser: winner === "local" ? r : l, fields: conflicts } };
}
