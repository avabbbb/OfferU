import type { Server } from "node:http";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAdaptorServer } from "@hono/node-server";
import { afterEach, describe, expect, it } from "vitest";
import { saveRecord } from "@offeru/core";
import { MemoryCoreStore, MemoryS3, MemoryStateStore, S3BlobStore, SyncEngine } from "@offeru/sync";

import { createApp } from "../src/app";
import { SqliteCoreStore } from "../src/store";
import { CompanionSync } from "../src/sync";

const PASS = "a long sync passphrase";
let cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});

async function companion(s3: MemoryS3) {
  const store = new SqliteCoreStore(":memory:");
  const dir = mkdtempSync(join(tmpdir(), "offeru-sync-"));
  const sync = new CompanionSync(store, dir, { fetch: s3.fetch, kdfIterations: 1000 });
  const server = createAdaptorServer({ fetch: createApp({ store, runtime: "node", storage: "sqlite", sync }).fetch }) as Server;
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", () => listening.resolve());
  await listening.promise;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  cleanup.push(async () => {
    const closed = Promise.withResolvers<void>();
    server.close(() => closed.resolve());
    await closed.promise;
    store.close();
  });
  const base = `http://127.0.0.1:${address.port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, json: await response.json() as Record<string, any> };
  };
  return { store, dir, call };
}

const bucket = (s3: MemoryS3) => ({
  endpoint: "https://s3.mock.local",
  bucket: s3.bucket,
  region: "auto",
  accessKeyId: s3.accessKeyId,
  secretAccessKey: "the-secret-key",
  prefix: "offeru",
});

/** The "browser": same engine, in-memory store and state, talking to the same bucket. */
function browser(s3: MemoryS3) {
  const store = new MemoryCoreStore();
  const engine = new SyncEngine({
    store,
    blobs: new S3BlobStore(bucket(s3), s3.fetch),
    state: new MemoryStateStore(),
    passphrase: PASS,
    kdfIterations: 1000,
  });
  return { store, engine };
}

let tick = Date.parse("2026-11-15T01:00:00Z");
const ctx = () => ({ actor: "你", now: new Date((tick += 1000)).toISOString(), today: "2026-11-15" });

describe("sync over HTTP", () => {
  it("configure / now / status end to end, secrets stay local", async () => {
    const s3 = new MemoryS3();
    const app = await companion(s3);

    const empty = await app.call("GET", "/api/sync/status");
    expect(empty.status).toBe(200);
    expect(empty.json).toMatchObject({ configured: false, config: null });

    const short = await app.call("POST", "/api/sync/configure", { ...bucket(s3), passphrase: "short" });
    expect(short.status).toBe(400);
    expect(short.json.code).toBe("sync_config");

    const configured = await app.call("POST", "/api/sync/configure", { ...bucket(s3), passphrase: PASS });
    expect(configured.status).toBe(200);
    expect(configured.json.configured).toBe(true);
    expect(JSON.stringify(configured.json)).not.toContain("the-secret-key");
    expect(JSON.stringify(configured.json)).not.toContain(PASS);
    expect(configured.json.config.accessKeyId).not.toBe(s3.accessKeyId);
    if (process.platform !== "win32") expect(statSync(join(app.dir, "sync.json")).mode & 0o777).toBe(0o600);

    await app.call("POST", "/api/tools/save", { type: "job", data: { company: "小米", title: "客户端" } });
    expect((await app.call("GET", "/api/sync/status")).json.pending).toBe(1);
    const now = await app.call("POST", "/api/sync/now");
    expect(now.status).toBe(200);
    expect(now.json.result).toMatchObject({ pushed: 1, initialized: false });
    expect(now.json.status).toMatchObject({ pending: 0, syncing: false });

    // Editing non-secret fields keeps the saved secret and passphrase.
    const again = await app.call("POST", "/api/sync/configure", { ...bucket(s3), secretAccessKey: "", passphrase: "" });
    expect(again.status).toBe(200);

    const wrong = await app.call("POST", "/api/sync/configure", { ...bucket(s3), passphrase: "another passphrase" });
    expect(wrong.status).toBe(400);
    expect(wrong.json.code).toBe("sync_passphrase");

    const cleared = await app.call("POST", "/api/sync/configure", { clear: true });
    expect(cleared.json.configured).toBe(false);
    const nothing = await app.call("POST", "/api/sync/now");
    expect(nothing.status).toBe(400);
  });

  it("browser and companion engines interoperate on one bucket", async () => {
    const s3 = new MemoryS3();
    const app = await companion(s3);
    const web = browser(s3);

    // Browser starts: a job with an event linked to it.
    const job = (await saveRecord(web.store, { type: "job", data: { company: "百度", title: "搜索" } }, ctx())).record;
    await saveRecord(web.store, { type: "event", data: { title: "一面", kind: "interview", job_id: job.id } }, ctx());
    await web.engine.sync();

    expect((await app.call("POST", "/api/sync/configure", { ...bucket(s3), passphrase: PASS })).status).toBe(200);
    expect((await app.call("POST", "/api/sync/now")).json.result.pulled).toBe(2);
    const [companionJob] = await app.store.all("job");
    const [companionEvent] = await app.store.all("event");
    expect(companionJob).toMatchObject({ company: "百度", title: "搜索" });
    expect(companionEvent.job_id).toBe(companionJob.id);

    // Concurrent edits on both sides, different fields.
    await app.call("POST", "/api/tools/save", { type: "job", id: companionJob.id, data: { status: "applied" } });
    await saveRecord(web.store, { type: "job", id: job.id, data: { notes: "带作品集" } }, ctx());
    await web.engine.sync();
    const merged = await app.call("POST", "/api/sync/now");
    expect(merged.json.result.conflicts).toBe(0);
    await web.engine.sync();

    for (const record of [(await app.store.all("job"))[0], (await web.store.all("job"))[0]]) {
      expect(record).toMatchObject({ status: "applied", notes: "带作品集" });
    }
    const changes = await app.call("POST", "/api/tools/changes", { limit: 5 });
    expect(changes.json.items.some((item: { actor: string }) => item.actor === "同步")).toBe(true);
  });
});
