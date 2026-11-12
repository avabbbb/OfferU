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

/** Persistence adapter. The core owns semantics; the adapter only stores rows. */
export interface CoreStore {
  all(type: RecordType, jobId?: number | null): StoredRecord[];
  get(type: RecordType, id: number): StoredRecord | null;
  first(type: RecordType): StoredRecord | null;
  put(type: RecordType, data: Json, options: PutOptions): StoredRecord;
  remove(type: RecordType, id: number): void;
  changes(limit: number): ChangeRow[];
  getChange(id: number): ChangeRow | null;
  lastChange(): ChangeRow | null;
  addChange(row: Omit<ChangeRow, "id" | "undone_at">): number;
  updateChange(id: number, patch: Partial<Pick<ChangeRow, "at" | "after" | "undone_at">>): void;
}

export class CoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoreError";
  }
}
