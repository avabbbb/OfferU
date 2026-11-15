// Named backups kept next to the data (Python services/data_safety.py, the
// parts the settings page uses): create, list (with hash check), restore with
// an automatic pre-restore backup, status. A backup is an export_data snapshot
// file plus a small meta file; the runtime injects where they live (companion:
// <data>/backups; the browser can use its own file store).
//
// Differences from Python, by design: a backup is the portable JSON snapshot,
// not a copy of the SQLite file, and restore happens at once inside one
// transaction (no "stage and restart"), so pending_restore is always null.

import { DATA_VERSION, exportData, importData, parseSnapshot, type DataSnapshot } from "./data";
import { CoreError, type CoreContext, type CoreStore } from "./types";

export interface BackupFiles {
  list(): Promise<string[]>;
  read(name: string): Promise<Uint8Array | null>;
  write(name: string, bytes: Uint8Array): Promise<void>;
}

export type BackupReason = "user" | "pre_restore" | "pre_reset";
export interface BackupItem {
  backup_id: string;
  version: string;
  schema: { user_version: number; schema_version: number };
  hash: string;
  created_at: string;
  reason: BackupReason | string;
  size_bytes: number;
}

const ID = /^[0-9a-f]{32}$/;
const SCHEMA = { user_version: 0, schema_version: DATA_VERSION };
const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function newId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function createBackup(store: CoreStore, files: BackupFiles, reason: BackupReason, now: string): Promise<BackupItem & { archive_sha256: string }> {
  const snapshot = await exportData(store, now);
  const bytes = encoder.encode(JSON.stringify(snapshot));
  const backup_id = newId();
  const hash = await sha256(bytes);
  const item: BackupItem = { backup_id, version: String(DATA_VERSION), schema: SCHEMA, hash, created_at: now, reason, size_bytes: bytes.length };
  await files.write(`${backup_id}.json`, bytes);
  await files.write(`${backup_id}.meta.json`, encoder.encode(JSON.stringify(item)));
  return { ...item, archive_sha256: hash };
}

async function readBackup(files: BackupFiles, id: string): Promise<{ item: BackupItem; snapshot: DataSnapshot }> {
  if (!ID.test(id)) throw new CoreError("备份编号无效");
  const [meta, body] = await Promise.all([files.read(`${id}.meta.json`), files.read(`${id}.json`)]);
  if (!meta || !body) throw new CoreError(`备份 ${id} 不存在`, "not_found");
  const item = JSON.parse(decoder.decode(meta)) as BackupItem;
  if (await sha256(body) !== item.hash) throw new CoreError(`备份 ${id} 的内容和记录的校验值不一致，可能已损坏`, "conflict");
  const snapshot = JSON.parse(decoder.decode(body)) as DataSnapshot;
  parseSnapshot(snapshot);
  return { item, snapshot };
}

export async function listBackups(files: BackupFiles): Promise<{ items: BackupItem[]; invalid: Array<{ backup_id: string; error: string }> }> {
  const ids = (await files.list()).filter((name) => name.endsWith(".meta.json")).map((name) => name.slice(0, -".meta.json".length)).filter((id) => ID.test(id));
  const items: BackupItem[] = [];
  const invalid: Array<{ backup_id: string; error: string }> = [];
  for (const id of ids) {
    try {
      items.push((await readBackup(files, id)).item);
    } catch (error) {
      invalid.push({ backup_id: id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  items.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.backup_id.localeCompare(a.backup_id));
  return { items, invalid };
}

/** Restore a named backup now; the current data is first saved as a pre_restore backup. */
export async function restoreBackup(store: CoreStore, files: BackupFiles, id: string, ctx: CoreContext): Promise<{
  backup_id: string; staged_at: string; pending_restart: false; database_replaced: true; pre_restore_backup_id: string;
}> {
  const { snapshot } = await readBackup(files, id);
  const pre = await createBackup(store, files, "pre_restore", ctx.now);
  await importData(store, snapshot, ctx);
  return { backup_id: id, staged_at: ctx.now, pending_restart: false, database_replaced: true, pre_restore_backup_id: pre.backup_id };
}

export async function dataSafetyStatus(files: BackupFiles, database: { exists: boolean; filename: string }, storageMode: string) {
  const { items, invalid } = await listBackups(files);
  return { database, backup_count: items.length, invalid_backup_count: invalid.length, pending_restore: null, storage_mode: storageMode };
}
