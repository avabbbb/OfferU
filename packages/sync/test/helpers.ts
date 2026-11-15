import { saveRecord, deleteRecord, type CoreStore, type StoredRecord } from "@offeru/core";

import {
  canonicalJson,
  MemoryCoreStore,
  MemoryS3,
  MemoryStateStore,
  S3BlobStore,
  SyncEngine,
  type ChunkParams,
  type SyncEngineOptions,
} from "../src";

export class Clock {
  constructor(public ms = Date.parse("2026-11-15T00:00:00Z")) {}
  tick = (): Date => new Date((this.ms += 1000));
  iso = (): string => this.tick().toISOString();
}

export const PASS = "correct horse battery staple";

export function blobsFor(s3: MemoryS3, prefix = "offeru") {
  return new S3BlobStore(
    { endpoint: "https://s3.mock.local", bucket: s3.bucket, region: "auto", accessKeyId: s3.accessKeyId, secretAccessKey: "test-secret", prefix },
    s3.fetch,
  );
}

export type Device = {
  store: CoreStore;
  engine: SyncEngine;
  state: MemoryStateStore;
  save(type: string, data: Record<string, unknown>, id?: number): Promise<StoredRecord>;
  remove(type: string, id: number): Promise<void>;
};

export function device(
  s3: MemoryS3,
  clock: Clock,
  options: Partial<SyncEngineOptions> & { store?: CoreStore; chunks?: ChunkParams } = {},
): Device {
  const store = options.store ?? new MemoryCoreStore();
  const state = new MemoryStateStore();
  const engine = new SyncEngine({
    blobs: blobsFor(s3),
    passphrase: PASS,
    kdfIterations: 1000,
    now: clock.tick,
    sleep: async () => undefined,
    lock: { attempts: 2, waitMs: 0 },
    ...options,
    store,
    state,
  });
  const ctx = () => ({ actor: "你", now: clock.iso(), today: "2026-11-15" });
  return {
    store,
    engine,
    state,
    async save(type, data, id) {
      return (await saveRecord(store, { type, data, ...(id === undefined ? {} : { id }) }, ctx())).record;
    },
    async remove(type, id) {
      await deleteRecord(store, { type, id }, ctx());
    },
  };
}

/** Device-independent view of a store: records without local ids, links by label. */
export async function snapshot(store: CoreStore): Promise<string[]> {
  const out: string[] = [];
  const jobs = new Map<number, string>();
  for (const job of await store.all("job")) jobs.set(job.id, `${job.company}/${job.title}`);
  for (const type of ["profile", "job", "memory", "event", "doc"] as const) {
    for (const record of await store.all(type)) {
      const { id: _id, job_id: jobId, created_at: _c, updated_at: _u, ...data } = record;
      out.push(canonicalJson({ ...data, job: jobId === null ? null : jobs.get(jobId) ?? "?" }));
    }
  }
  return out.sort();
}
