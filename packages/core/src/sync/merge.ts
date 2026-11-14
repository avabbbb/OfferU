// Three-way merge of snapshot entry maps (base = last state both sides agreed on).
// Pure: no I/O. Used for records (key = uid) and files (key = path).

import type { Entry, EntryMap } from "./types";

export type MergeConflict = {
  key: string;
  /** Which side's version is kept under the original key. */
  keep: "local" | "remote";
  /** The losing (edited) version, to be preserved as a conflict copy. */
  loser: Entry;
};

export type MergeResult = {
  merged: EntryMap;
  /** Keys whose remote version must be written into the local store. */
  pull: string[];
  conflicts: MergeConflict[];
};

function live(entry: Entry | undefined): entry is Entry {
  return Boolean(entry && !entry.del && entry.h);
}

/** Same content: both absent/deleted, or both live with the same object id. */
export function sameEntry(a: Entry | undefined, b: Entry | undefined): boolean {
  if (!live(a) || !live(b)) return !live(a) && !live(b);
  return a.h === b.h;
}

/** Newer wins; ties broken by object id so both devices pick the same winner. */
function remoteWins(local: Entry, remote: Entry): boolean {
  if (remote.u !== local.u) return remote.u > local.u;
  return (remote.h ?? "") > (local.h ?? "");
}

export function threeWayMerge(base: EntryMap, local: EntryMap, remote: EntryMap): MergeResult {
  const merged: EntryMap = {};
  const pull: string[] = [];
  const conflicts: MergeConflict[] = [];
  const keys = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)]);

  for (const key of keys) {
    const b = base[key];
    const l = local[key];
    const r = remote[key];
    const takeRemote = () => {
      if (r) merged[key] = r;
      if (!sameEntry(l, r)) pull.push(key);
    };
    const takeLocal = () => {
      if (l) merged[key] = l;
    };

    if (sameEntry(l, r)) {
      // Keep whichever carries information (a tombstone beats nothing).
      const pick = live(l) ? l : live(r) ? r : (l ?? r);
      if (pick) merged[key] = pick;
      continue;
    }
    if (sameEntry(l, b)) { takeRemote(); continue; }
    if (sameEntry(r, b)) { takeLocal(); continue; }

    // Both sides changed it differently.
    if (!live(l)) { takeRemote(); continue; } // local delete vs remote edit: the edit survives
    if (!live(r)) { takeLocal(); continue; } // remote delete vs local edit: the edit survives
    if (remoteWins(l, r)) {
      takeRemote();
      conflicts.push({ key, keep: "remote", loser: l });
    } else {
      takeLocal();
      conflicts.push({ key, keep: "local", loser: r });
    }
  }
  return { merged, pull, conflicts };
}

/** Drop tombstones older than the cutoff (ISO time) so snapshots do not grow forever. */
export function pruneTombstones(entries: EntryMap, cutoff: string): EntryMap {
  const out: EntryMap = {};
  for (const [key, entry] of Object.entries(entries)) {
    if (entry.del && entry.u < cutoff) continue;
    out[key] = entry;
  }
  return out;
}
