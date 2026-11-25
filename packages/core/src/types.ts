// Pure core types shared by the browser demo store and, later, a Node adapter.
// No DOM, React, localforage, or fetch here: this is the portable layer.

export type RecordType = "profile" | "memory" | "job" | "event" | "doc";
export type JobStatus = "saved" | "applied" | "test" | "interview" | "offer" | "rejected" | "closed";
export type EventKind = "todo" | "deadline" | "test" | "interview";
export type MemoryKind = "experience" | "project" | "education" | "skill" | "award" | "preference" | "note";
export type DocKind = "resume" | "apply_chat" | "email" | "review" | "research" | "evaluation" | "note";

export type Json = Record<string, unknown>;
export type PlainRecord = Json & { job_id?: number | null };

export type StoredRecord = {
  id: number;
  type: RecordType;
  job_id: number | null;
  created_at: string;
  updated_at: string;
} & Json;

export type ChangeRow = {
  id: number;
  at: string;
  actor: string;
  summary: string;
  type: RecordType;
  record_id: number;
  before: PlainRecord | null;
  after: PlainRecord | null;
  undone_at: string | null;
  /**
   * Operation key of the write (Agent: "<run_id>:<tool_call_id>"). Absent for the user's own
   * writes. Lets a resumed run tell which tool calls already committed before the crash.
   */
  op?: string;
};

export type ChangeView = {
  id: number;
  at: string;
  actor: string;
  summary: string;
  type: RecordType;
  record_id: number;
  created: boolean;
  deleted: boolean;
  undone_at: string | null;
};

export type CoreContext = {
  actor: string;
  now: string;
  today: string;
  /** Operation key stamped on every change this call writes (see ChangeRow.op). */
  op?: string;
};

export type PutOptions = {
  id?: number;
  jobId?: number | null;
  now: string;
  createdAt?: string;
  /** Undo restores the exact snapshot: drop fields that are absent from data. */
  replace?: boolean;
  /** Undo may re-insert a deleted record with its original id. */
  restore?: boolean;
};

/**
 * Persistence adapter. The core owns semantics; the adapter only stores rows.
 *
 * Every method is async so the same core runs on IndexedDB/OPFS in the
 * browser, node:sqlite on the local companion, and anything else later.
 * `transaction` must make every write inside `fn` all-or-nothing: a record
 * write and its change-log row either both land or neither does.
 * Transactions are serialized and never nest: an independent caller that
 * arrives while one is open queues behind it (never joins it, never shares its
 * rollback). Code already inside a transaction uses saveRecordInTx /
 * deleteRecordInTx instead of opening another one.
 */
export interface CoreStore {
  all(type: RecordType, jobId?: number | null): Promise<StoredRecord[]>;
  get(type: RecordType, id: number): Promise<StoredRecord | null>;
  first(type: RecordType): Promise<StoredRecord | null>;
  put(type: RecordType, data: Json, options: PutOptions): Promise<StoredRecord>;
  remove(type: RecordType, id: number): Promise<void>;
  changes(limit: number): Promise<ChangeRow[]>;
  getChange(id: number): Promise<ChangeRow | null>;
  lastChange(): Promise<ChangeRow | null>;
  addChange(row: Omit<ChangeRow, "id" | "undone_at">): Promise<number>;
  updateChange(id: number, patch: Partial<Pick<ChangeRow, "at" | "after" | "undone_at">>): Promise<void>;
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  /**
   * Optional: how many changes `actor` made at or after `since` (ISO), and the
   * latest `at`. Overview's mail progress uses it; stores without it are
   * scanned through `changes()`.
   */
  changeStats?(actor: string, since: string): Promise<{ count: number; last: string | null }>;
  /** Optional: every row of both tables, ids ascending (data.ts dumpRows scans through all() / changes() otherwise). */
  dumpAll?(): Promise<import("./data").DataRows>;
  /** Optional: delete every record and change, then insert these rows as-is (ids kept). Called inside transaction(). Needed for restore. */
  replaceAll?(rows: import("./data").DataRows): Promise<void>;
  /** Optional: engine-level check (SQLite PRAGMA integrity_check / foreign_key_check / user_version). */
  checkIntegrity?(): Promise<{ integrity_check: string[]; foreign_key_violations: unknown[][]; user_version: number }>;
}

/**
 * Machine-readable error kinds. Transports map these to status codes
 * (HTTP 400/404/409/403/501/502) instead of pattern-matching the Chinese message.
 * not_configured: the user has to set something up first (e.g. a search key);
 * upstream: an outside service (search provider) answered with an error.
 */
export type CoreErrorCode = "invalid" | "not_found" | "conflict" | "forbidden" | "unsupported" | "not_configured" | "upstream";

export class CoreError extends Error {
  readonly code: CoreErrorCode;

  constructor(message: string, code: CoreErrorCode = "invalid") {
    super(message);
    this.name = "CoreError";
    this.code = code;
  }
}

export function isCoreError(value: unknown): value is CoreError {
  return value instanceof Error && (value as { name?: string }).name === "CoreError" && typeof (value as { code?: unknown }).code === "string";
}
