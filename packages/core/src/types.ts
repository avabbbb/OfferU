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
}

/**
 * Machine-readable error kinds. Transports map these to status codes
 * (HTTP 400/404/409/403) instead of pattern-matching the Chinese message.
 */
export type CoreErrorCode = "invalid" | "not_found" | "conflict" | "forbidden" | "unsupported";

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
