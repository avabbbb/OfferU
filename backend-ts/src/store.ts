import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  ChangeRow,
  CoreStore,
  Json,
  PutOptions,
  RecordType,
  StoredRecord,
} from "@offeru/core";

type Row = {
  id: number;
  type: RecordType;
  job_id: number | null;
  data: string;
  created_at: string;
  updated_at: string;
};

type ChangeSqlRow = {
  id: number;
  at: string;
  actor: string;
  summary: string;
  type: RecordType;
  record_id: number;
  before: string | null;
  after: string | null;
  undone_at: string | null;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS records (
  id INTEGER PRIMARY KEY, type TEXT NOT NULL, job_id INTEGER, data TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS records_type ON records(type, updated_at);
CREATE INDEX IF NOT EXISTS records_job ON records(job_id);
CREATE TABLE IF NOT EXISTS changes (
  id INTEGER PRIMARY KEY, at TEXT NOT NULL, actor TEXT NOT NULL, summary TEXT NOT NULL,
  type TEXT NOT NULL, record_id INTEGER NOT NULL, before TEXT, after TEXT, undone_at TEXT);
`;

function decode(value: string | null): Json | null {
  return value === null ? null : JSON.parse(value) as Json;
}

function recordFromRow(row: Row): StoredRecord {
  return {
    ...JSON.parse(row.data) as Json,
    id: Number(row.id),
    type: row.type,
    job_id: row.job_id === null ? null : Number(row.job_id),
    created_at: row.created_at,
    updated_at: row.updated_at,
  } as StoredRecord;
}

function changeFromRow(row: ChangeSqlRow): ChangeRow {
  return {
    id: Number(row.id),
    at: row.at,
    actor: row.actor,
    summary: row.summary,
    type: row.type,
    record_id: Number(row.record_id),
    before: decode(row.before),
    after: decode(row.after),
    undone_at: row.undone_at,
  };
}

/** SQLite adapter for the shared OfferU core. Same records/changes schema as Python. */
export class SqliteCoreStore implements CoreStore {
  private readonly db: DatabaseSync;
  private queue: Promise<unknown> = Promise.resolve();
  private inTx = false;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL;");
    this.db.exec(SCHEMA);
  }

  async all(type: RecordType, jobId?: number | null): Promise<StoredRecord[]> {
    const rows = jobId === undefined
      ? this.db.prepare("SELECT * FROM records WHERE type=? ORDER BY updated_at DESC, id DESC").all(type)
      : this.db.prepare("SELECT * FROM records WHERE type=? AND job_id=? ORDER BY updated_at DESC, id DESC").all(type, jobId);
    return (rows as Row[]).map(recordFromRow);
  }

  async get(type: RecordType, id: number): Promise<StoredRecord | null> {
    const row = this.db.prepare("SELECT * FROM records WHERE type=? AND id=?").get(type, id) as Row | undefined;
    return row ? recordFromRow(row) : null;
  }

  async first(type: RecordType): Promise<StoredRecord | null> {
    const row = this.db.prepare("SELECT * FROM records WHERE type=? ORDER BY id LIMIT 1").get(type) as Row | undefined;
    return row ? recordFromRow(row) : null;
  }

  async put(type: RecordType, data: Json, options: PutOptions): Promise<StoredRecord> {
    const existing = options.id === undefined ? null : await this.get(type, options.id);
    if (options.id !== undefined && !existing && !options.restore) {
      throw new Error(`${type} #${options.id} 不存在`);
    }

    const base = options.replace || !existing ? {} : this.dataOf(existing);
    const merged: Json = { ...base, ...data };
    for (const [key, value] of Object.entries(merged)) {
      if (value === null) delete merged[key];
    }
    delete merged.id;
    delete merged.type;
    delete merged.job_id;
    delete merged.created_at;
    delete merged.updated_at;

    const now = options.now;
    const jobId = options.jobId === undefined ? existing?.job_id ?? null : options.jobId;
    const createdAt = existing?.created_at ?? options.createdAt ?? now;
    const id = existing?.id ?? options.id ?? this.nextRecordId();
    const sqlData = JSON.stringify(merged);

    if (existing) {
      this.db.prepare("UPDATE records SET job_id=?, data=?, updated_at=? WHERE id=?").run(jobId, sqlData, now, id);
    } else {
      this.db.prepare("INSERT INTO records(id, type, job_id, data, created_at, updated_at) VALUES (?,?,?,?,?,?)")
        .run(id, type, jobId, sqlData, createdAt, now);
    }

    return (await this.get(type, id))!;
  }

  async remove(type: RecordType, id: number): Promise<void> {
    this.db.prepare("DELETE FROM records WHERE type=? AND id=?").run(type, id);
  }

  async changes(limit: number): Promise<ChangeRow[]> {
    const rows = this.db.prepare("SELECT * FROM changes ORDER BY id DESC LIMIT ?").all(limit) as ChangeSqlRow[];
    return rows.map(changeFromRow);
  }

  async getChange(id: number): Promise<ChangeRow | null> {
    const row = this.db.prepare("SELECT * FROM changes WHERE id=?").get(id) as ChangeSqlRow | undefined;
    return row ? changeFromRow(row) : null;
  }

  async lastChange(): Promise<ChangeRow | null> {
    const row = this.db.prepare("SELECT * FROM changes ORDER BY id DESC LIMIT 1").get() as ChangeSqlRow | undefined;
    return row ? changeFromRow(row) : null;
  }

  async addChange(row: Omit<ChangeRow, "id" | "undone_at">): Promise<number> {
    const result = this.db.prepare(
      "INSERT INTO changes(at, actor, summary, type, record_id, before, after) VALUES (?,?,?,?,?,?,?)",
    ).run(
      row.at,
      row.actor,
      row.summary,
      row.type,
      row.record_id,
      row.before === null ? null : JSON.stringify(row.before),
      row.after === null ? null : JSON.stringify(row.after),
    );
    return Number(result.lastInsertRowid);
  }

  async updateChange(id: number, patch: Partial<Pick<ChangeRow, "at" | "after" | "undone_at">>): Promise<void> {
    const sets: string[] = [];
    const values: Array<string | null> = [];
    if (patch.at !== undefined) { sets.push("at=?"); values.push(patch.at); }
    if (patch.after !== undefined) { sets.push("after=?"); values.push(patch.after === null ? null : JSON.stringify(patch.after)); }
    if (patch.undone_at !== undefined) { sets.push("undone_at=?"); values.push(patch.undone_at); }
    if (!sets.length) return;
    this.db.prepare(`UPDATE changes SET ${sets.join(", ")} WHERE id=?`).run(...values, id);
  }

  /**
   * Serialized BEGIN IMMEDIATE ... COMMIT. node:sqlite is one synchronous
   * connection, so concurrent async callers must queue or their statements
   * would interleave inside each other's transaction.
   */
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    if (this.inTx) return fn();
    const run = this.queue.then(async () => {
      this.inTx = true;
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const result = await fn();
        this.db.exec("COMMIT");
        return result;
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      } finally {
        this.inTx = false;
      }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  close(): void {
    this.db.close();
  }

  private dataOf(record: StoredRecord): Json {
    const { id: _id, type: _type, job_id: _job, created_at: _created, updated_at: _updated, ...data } = record;
    return data;
  }

  private nextRecordId(): number {
    const row = this.db.prepare(
      "SELECT MAX(m) AS m FROM (SELECT MAX(id) AS m FROM records UNION ALL SELECT MAX(record_id) AS m FROM changes)",
    ).get() as { m: number | null };
    return Number(row.m ?? 0) + 1;
  }
}

export function openStore(path: string): SqliteCoreStore {
  return new SqliteCoreStore(path);
}
