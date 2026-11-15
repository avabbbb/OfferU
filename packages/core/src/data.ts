// Backup / restore of the user's whole store as one JSON document.
//
// The snapshot is the two SQLite tables row for row (records + changes, same
// ids, same JSON payloads), so it round-trips between every store: the
// companion's offeru.db (TS or Python, same schema), the browser's local store,
// and back. Change ids are kept, so "undo change #42" still means the same
// change after a restore. Connection secrets never live in these tables, so
// nothing needs redacting.

import { USER_ACTOR } from "./operations";
import { CoreError, type ChangeRow, type CoreContext, type CoreStore, type Json, type RecordType, type StoredRecord } from "./types";

export const DATA_FORMAT = "offeru-data";
export const DATA_VERSION = 1;

/** One records row: the record's own fields under `data`, like the SQLite column. */
export type RecordRow = { id: number; type: RecordType; job_id: number | null; data: Json; created_at: string; updated_at: string };
export type DataRows = { records: RecordRow[]; changes: ChangeRow[] };

export type DataSnapshot = {
  format: typeof DATA_FORMAT;
  version: typeof DATA_VERSION;
  exported_at: string;
  counts: Record<RecordType | "changes", number>;
} & DataRows;

/** Python store.TYPES order. */
export const RECORD_TYPES: RecordType[] = ["profile", "memory", "job", "event", "doc"];

const META = new Set(["id", "type", "job_id", "created_at", "updated_at"]);

export function recordRow(record: StoredRecord): RecordRow {
  const data: Json = {};
  for (const [key, value] of Object.entries(record)) if (!META.has(key)) data[key] = value;
  return { id: record.id, type: record.type, job_id: record.job_id ?? null, data, created_at: record.created_at, updated_at: record.updated_at };
}

/** Every row of both tables, ids ascending. Uses the store's own dump when it has one. */
export async function dumpRows(store: CoreStore): Promise<DataRows> {
  if (store.dumpAll) return store.dumpAll();
  const records: RecordRow[] = [];
  for (const type of RECORD_TYPES) for (const record of await store.all(type)) records.push(recordRow(record));
  records.sort((a, b) => a.id - b.id);
  const changes = [...await store.changes(Number.MAX_SAFE_INTEGER)].sort((a, b) => a.id - b.id);
  return { records, changes };
}

function counts(rows: DataRows): DataSnapshot["counts"] {
  const out = Object.fromEntries([...RECORD_TYPES, "changes"].map((key) => [key, 0])) as DataSnapshot["counts"];
  for (const row of rows.records) out[row.type] += 1;
  out.changes = rows.changes.length;
  return out;
}

export async function exportData(store: CoreStore, exportedAt: string): Promise<DataSnapshot> {
  const rows = await dumpRows(store);
  return { format: DATA_FORMAT, version: DATA_VERSION, exported_at: exportedAt, counts: counts(rows), ...rows };
}

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const isId = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const isText = (value: unknown): value is string => typeof value === "string";
const nullableText = (value: unknown): value is string | null => value === null || typeof value === "string";

/** Check a snapshot before anything is replaced: a bad file must never half-restore. */
export function parseSnapshot(raw: unknown): DataRows {
  if (!isObject(raw) || raw.format !== DATA_FORMAT) throw new CoreError("这不是 OfferU 的数据备份文件（format 不是 offeru-data）");
  if (raw.version !== DATA_VERSION) throw new CoreError(`不认识的数据备份版本 ${String(raw.version)}；这个版本能读 ${DATA_VERSION}`);
  if (!Array.isArray(raw.records) || !Array.isArray(raw.changes)) throw new CoreError("备份文件缺少 records / changes");
  const ids = new Set<number>();
  const records = raw.records.map((row, index): RecordRow => {
    const where = `records[${index}]`;
    if (!isObject(row) || !isId(row.id) || !RECORD_TYPES.includes(row.type as RecordType) || !isObject(row.data)
      || !(row.job_id === null || row.job_id === undefined || isId(row.job_id)) || !isText(row.created_at) || !isText(row.updated_at)) {
      throw new CoreError(`备份文件的 ${where} 格式不对`);
    }
    if (ids.has(row.id)) throw new CoreError(`备份文件里记录 #${row.id} 出现了两次`);
    ids.add(row.id);
    return { id: row.id, type: row.type as RecordType, job_id: (row.job_id as number | null | undefined) ?? null, data: row.data, created_at: row.created_at, updated_at: row.updated_at };
  });
  const changeIds = new Set<number>();
  const changes = raw.changes.map((row, index): ChangeRow => {
    const where = `changes[${index}]`;
    if (!isObject(row) || !isId(row.id) || !isText(row.at) || !isText(row.actor) || !isText(row.summary)
      || !RECORD_TYPES.includes(row.type as RecordType) || !isId(row.record_id)
      || !(row.before === null || isObject(row.before)) || !(row.after === null || isObject(row.after)) || !nullableText(row.undone_at ?? null)) {
      throw new CoreError(`备份文件的 ${where} 格式不对`);
    }
    if (changeIds.has(row.id)) throw new CoreError(`备份文件里改动 #${row.id} 出现了两次`);
    changeIds.add(row.id);
    return {
      id: row.id, at: row.at, actor: row.actor, summary: row.summary, type: row.type as RecordType, record_id: row.record_id,
      before: row.before as ChangeRow["before"], after: row.after as ChangeRow["after"], undone_at: (row.undone_at as string | null | undefined) ?? null,
    };
  });
  return { records: records.sort((a, b) => a.id - b.id), changes: changes.sort((a, b) => a.id - b.id) };
}

/**
 * Replace everything with the snapshot, all or nothing. Only the user may do
 * this (it deletes every current record): agents get "forbidden". Callers keep
 * a pre-restore export first (the routes do) so it can be undone by restoring that.
 */
export async function importData(store: CoreStore, raw: unknown, ctx: CoreContext): Promise<{ imported: DataSnapshot["counts"]; replaced: DataSnapshot["counts"] }> {
  if (ctx.actor !== USER_ACTOR) throw new CoreError("恢复数据会替换全部记录，只能由用户本人在设置里操作", "forbidden");
  if (!store.replaceAll) throw new CoreError("这个运行环境的数据存储不支持整库恢复", "unsupported");
  const rows = parseSnapshot(raw);
  const before = await dumpRows(store);
  await store.transaction(() => store.replaceAll!(rows));
  return { imported: counts(rows), replaced: counts(before) };
}
