import type { RecordType } from "../types";

/**
 * Files that travel with the data (resume attachments, school logos, photos).
 * Paths are '/'-separated and relative to the app's file root. The browser
 * backs this with OPFS/IDB, the Node companion with a directory.
 */
export type SyncFileInfo = { path: string; size: number; mtime: string };

export interface SyncFileStore {
  list(): Promise<SyncFileInfo[]>;
  read(path: string): Promise<Uint8Array>;
  /** Create parent dirs as needed; set mtime when the backend can. */
  write(path: string, bytes: Uint8Array, mtime?: string): Promise<void>;
  remove(path: string): Promise<void>;
}

/** User's S3 settings. Device-local only: never synced, never sent to a Worker, never logged. */
export type SyncConfig = {
  endpoint: string;
  region: string;
  bucket: string;
  /** Key prefix inside the bucket; always ends with "/". */
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  passphrase: string;
  forcePathStyle: boolean;
  /** Shown in conflict copies and snapshot names. */
  deviceName: string;
  /** 0 = manual only. */
  autoMinutes: number;
  syncOnStart: boolean;
};

export interface SyncConfigStore {
  load(): Promise<SyncConfig | null>;
  save(config: SyncConfig | null): Promise<void>;
}

/** One record or file in a snapshot. Equal `h` = equal content. */
export type Entry = {
  /** Object id of the content; null for a tombstone. */
  h: string | null;
  /** updated_at (records) / mtime (files), or deletion time for a tombstone. */
  u: string;
  del?: true;
  /** Record type (records only). */
  t?: RecordType;
  /** Byte size (files only). */
  size?: number;
};

export type EntryMap = Record<string, Entry>;

export type Snapshot = {
  format: 1;
  name: string;
  parent: string | null;
  device: string;
  device_name: string;
  created_at: string;
  records: EntryMap;
  files: EntryMap;
};

export type SyncConflict = {
  kind: "record" | "file";
  /** Record "type #id" or file path, as on this device. */
  what: string;
  kept: "local" | "remote";
  /** Where the losing version went: a new record id / file path, or "change-log" for the singleton profile. */
  copy: string;
};

export type SyncRunResult = {
  ok: true;
  at: string;
  snapshot: string | null;
  pulled: number;
  pushed: number;
  uploaded_objects: number;
  conflicts: SyncConflict[];
  attempts: number;
  gc?: GcResult;
};

export type GcResult = { snapshots_deleted: number; objects_deleted: number; snapshots_kept: number };

export type SyncStatus = {
  configured: boolean;
  running: boolean;
  device_id: string | null;
  last_run_at: string | null;
  last_ok_at: string | null;
  last_error: string | null;
  last_result: SyncRunResult | null;
  auto_minutes: number;
};
