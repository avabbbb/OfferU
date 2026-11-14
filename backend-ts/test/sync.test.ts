import { afterEach, describe, expect, it } from "vitest";
import {
  isCoreError,
  signRequest,
  SyncService,
  threeWayMerge,
  type SyncConfig,
  type SyncConfigStore,
  type SyncFileInfo,
  type SyncFileStore,
} from "@offeru/core";

import { createApp } from "../src/app";
import { SqliteCoreStore } from "../src/store";
import { callTool } from "../src/tools";
import { FakeS3 } from "./helpers/fake-s3";

const stores: SqliteCoreStore[] = [];
afterEach(() => {
  while (stores.length) stores.pop()!.close();
});

class MemoryFiles implements SyncFileStore {
  readonly files = new Map<string, { bytes: Uint8Array; mtime: string }>();
  async list(): Promise<SyncFileInfo[]> {
    return [...this.files].map(([path, f]) => ({ path, size: f.bytes.length, mtime: f.mtime }));
  }
  async read(path: string) {
    const found = this.files.get(path);
    if (!found) throw new Error(`no file ${path}`);
    return found.bytes.slice();
  }
  async write(path: string, bytes: Uint8Array, mtime?: string) {
    this.files.set(path, { bytes: bytes.slice(), mtime: mtime ?? new Date().toISOString() });
  }
  async remove(path: string) {
    this.files.delete(path);
  }
  text(path: string) {
    const found = this.files.get(path);
    return found ? new TextDecoder().decode(found.bytes) : undefined;
  }
}

class MemoryConfig implements SyncConfigStore {
  constructor(public value: SyncConfig | null = null) {}
  async load() { return this.value ? { ...this.value } : null; }
  async save(config: SyncConfig | null) { this.value = config ? { ...config } : null; }
}

const BASE_CONFIG: SyncConfig = {
  endpoint: "https://s3.test",
  region: "auto",
  bucket: "offeru-test",
  prefix: "offeru/",
  accessKeyId: "AKTEST",
  secretAccessKey: "secret-test",
  passphrase: "correct horse battery",
  forcePathStyle: true,
  deviceName: "A",
  autoMinutes: 0,
  syncOnStart: false,
};

function device(s3: FakeS3, name: string, overrides: Partial<SyncConfig> = {}, policy = {}) {
  const store = new SqliteCoreStore(":memory:");
  stores.push(store);
  const files = new MemoryFiles();
  const config = new MemoryConfig({ ...BASE_CONFIG, deviceName: name, ...overrides });
  const sync = new SyncService({ store, files, config, fetch: s3.fetch, kdfIterations: 1000, policy: { gcEveryDays: 10_000, ...policy } });
  const tool = (toolName: string, args: unknown): Promise<any> => callTool(toolName, args, store, "你");
  return { store, files, config, sync, tool };
}

// Store stamps have second precision: make the later edit really later.
const tick = () => new Promise((resolve) => setTimeout(resolve, 1100));

async function jobs(dev: ReturnType<typeof device>) {
  return (await dev.store.all("job")).map((job) => job.title).sort();
}

describe("SigV4", () => {
  it("matches the AWS S3 GET Object example signature", async () => {
    const headers = await signRequest(
      { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", region: "us-east-1" },
      { method: "GET", url: "https://examplebucket.s3.amazonaws.com/test.txt", headers: { Range: "bytes=0-9" }, date: new Date("2013-05-24T00:00:00Z") },
    );
    expect(headers.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, "
      + "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, "
      + "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
    expect(headers.host).toBeUndefined();
  });
});

describe("three-way merge", () => {
  it("takes one-sided changes, keeps edits over deletes, newer wins on double edits", () => {
    const e = (h: string, u = "2026-01-01") => ({ h, u });
    const del = (u = "2026-01-02") => ({ h: null, u, del: true as const });
    const result = threeWayMerge(
      { a: e("1"), b: e("1"), c: e("1"), d: e("1"), x: e("1") },
      { a: e("2"), b: e("1"), c: del(), d: e("2", "2026-02-01"), x: e("3", "2026-03-01") },
      { a: e("1"), b: e("2"), c: e("2"), d: del(), x: e("4", "2026-03-02") },
    );
    expect(result.merged.a.h).toBe("2");
    expect(result.merged.b.h).toBe("2");
    expect(result.merged.c.h).toBe("2"); // remote edit survives local delete
    expect(result.merged.d.h).toBe("2"); // local edit survives remote delete
    expect(result.merged.x.h).toBe("4");
    expect(result.pull.sort()).toEqual(["b", "c", "x"]);
    expect(result.conflicts).toEqual([{ key: "x", keep: "remote", loser: e("3", "2026-03-01") }]);
  });
});

describe("S3 sync between two devices", () => {
  it("round-trips records, remaps job links, and stores nothing readable in the bucket", async () => {
    const s3 = new FakeS3();
    const a = device(s3, "A");
    const b = device(s3, "B");
    // B already has a record so its local ids differ from A's.
    await b.tool("save", { type: "memory", data: { kind: "skill", title: "Rust" } });
    await b.tool("save", { type: "memory", data: { kind: "skill", title: "Go" } });

    await a.tool("save", { type: "profile", data: { name: "林沐" } });
    const job = (await a.tool("save", { type: "job", data: { company: "字节跳动", title: "后端实习" } })).record;
    await a.tool("save", { type: "doc", data: { kind: "note", title: "面经", body: "二面问了 Raft", job_id: job.id } });

    const first = await a.sync.run();
    expect(first.pushed).toBe(3);
    const pulled = await b.sync.run();
    expect(pulled.pulled).toBe(3);
    expect(pulled.conflicts).toEqual([]);

    const bJob = (await b.store.all("job"))[0];
    expect(bJob.title).toBe("后端实习");
    expect(bJob.id).not.toBe(job.id);
    const bDoc = (await b.store.all("doc"))[0];
    expect(bDoc.job_id).toBe(bJob.id);
    expect((await b.store.first("profile"))?.name).toBe("林沐");
    // Pulled writes are logged as undoable changes by the sync actor.
    expect((await b.store.changes(10)).some((row) => row.actor === "同步")).toBe(true);

    // A pulls B's memory; nothing else moves.
    const back = await a.sync.run();
    expect(back.pulled).toBe(2);
    expect((await a.store.all("memory")).map((row) => row.title).sort()).toEqual(["Go", "Rust"]);
    const idle = await a.sync.run();
    expect(idle).toMatchObject({ pulled: 0, pushed: 0, uploaded_objects: 0 });

    const needles = ["字节跳动", "后端实习", "林沐", "Raft"].map((text) => new TextEncoder().encode(text));
    for (const [key, value] of s3.objects) {
      const hay = Buffer.from(value.body);
      for (const needle of needles) expect(hay.includes(Buffer.from(needle)), key).toBe(false);
    }
    expect(s3.keys("offeru/objects/").length).toBeGreaterThan(0);
    expect(s3.keys("offeru/refs/latest")).toEqual(["offeru/refs/latest"]);
  });

  it("merges concurrent edits to different records without conflicts", async () => {
    const s3 = new FakeS3();
    const a = device(s3, "A");
    const b = device(s3, "B");
    const job = (await a.tool("save", { type: "job", data: { company: "美团", title: "算法" } })).record;
    await a.sync.run();
    await b.sync.run();

    await a.tool("save", { type: "job", id: job.id, data: { status: "applied" } });
    await b.tool("save", { type: "event", data: { kind: "todo", title: "改简历", date: "2026-12-01" } });
    await a.sync.run();
    const merged = await b.sync.run();
    expect(merged.conflicts).toEqual([]);
    await a.sync.run();

    for (const dev of [a, b]) {
      expect((await dev.store.all("job"))[0].status).toBe("applied");
      expect((await dev.store.all("event")).map((event) => event.title)).toEqual(["改简历"]);
    }
  });

  it("keeps the newer edit and a conflict copy when both devices edit the same record", async () => {
    const s3 = new FakeS3();
    const a = device(s3, "A");
    const b = device(s3, "B");
    const job = (await a.tool("save", { type: "job", data: { company: "腾讯", title: "前端" } })).record;
    await a.sync.run();
    await b.sync.run();
    const bJobId = (await b.store.all("job"))[0].id;

    await a.tool("save", { type: "job", id: job.id, data: { title: "前端（A 改）" } });
    await tick();
    await b.tool("save", { type: "job", id: bJobId, data: { title: "前端（B 改）" } });
    await a.sync.run();
    const result = await b.sync.run();
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toMatchObject({ kind: "record", kept: "local" });
    await a.sync.run();

    for (const dev of [a, b]) {
      expect(await jobs(dev)).toEqual(["前端（A 改）（同步冲突副本）", "前端（B 改）"]);
    }
    const copy = (await a.store.all("job")).find((row) => String(row.title).includes("副本"))!;
    expect(copy.sync_conflict).toMatchObject({ device: "B" });
  });

  it("profile conflicts keep the newer version and log the other one as undoable", async () => {
    const s3 = new FakeS3();
    const a = device(s3, "A");
    const b = device(s3, "B");
    await a.tool("save", { type: "profile", data: { name: "林沐" } });
    await a.sync.run();
    await b.sync.run();
    await a.tool("save", { type: "profile", data: { school: "A 大学" } });
    await tick();
    await b.tool("save", { type: "profile", data: { school: "B 大学" } });
    await b.sync.run();
    const result = await a.sync.run();
    expect(result.conflicts).toEqual([expect.objectContaining({ kept: "remote", copy: "change-log" })]);
    expect((await a.store.first("profile"))?.school).toBe("B 大学");
    expect(await a.store.all("profile")).toHaveLength(1);
    const logged = (await a.store.changes(5)).find((row) => row.actor === "同步" && row.type === "profile")!;
    await a.tool("undo", { change_id: logged.id });
    expect((await a.store.first("profile"))?.school).toBe("A 大学");
  });

  it("propagates deletes as tombstones, lets an edit beat a concurrent delete, and undo resurrects", async () => {
    const s3 = new FakeS3();
    const a = device(s3, "A");
    const b = device(s3, "B");
    const keep = (await a.tool("save", { type: "job", data: { company: "阿里", title: "Java" } })).record;
    const gone = (await a.tool("save", { type: "job", data: { company: "百度", title: "测试" } })).record;
    await a.sync.run();
    await b.sync.run();

    // Plain delete on A reaches B.
    await a.tool("delete", { type: "job", id: gone.id });
    // A deletes `keep` while B edits it: the edit wins.
    await a.tool("delete", { type: "job", id: keep.id });
    const bKeep = (await b.store.all("job")).find((row) => row.title === "Java")!;
    await b.tool("save", { type: "job", id: bKeep.id, data: { notes: "B 还想投" } });

    await a.sync.run();
    await b.sync.run();
    await a.sync.run();
    for (const dev of [a, b]) {
      const rows = await dev.store.all("job");
      expect(rows.map((row) => row.title)).toEqual(["Java"]);
      expect(rows[0].notes).toBe("B 还想投");
    }

    // B undoes the synced delete of 测试; the record comes back everywhere.
    const del = (await b.store.changes(20)).find((row) => row.actor === "同步" && row.after === null)!;
    await b.tool("undo", { change_id: del.id });
    await b.sync.run();
    await a.sync.run();
    expect(await jobs(a)).toEqual(["Java", "测试"]);
  });

  it("resumes an interrupted upload without re-sending finished objects", async () => {
    const s3 = new FakeS3();
    const a = device(s3, "A");
    for (let i = 0; i < 30; i += 1) await a.tool("save", { type: "memory", data: { kind: "note", title: `笔记 ${i}` } });
    await a.files.write("photo.png", new Uint8Array(1000).fill(7));

    s3.failOnPut = 12; // repo.json is PUT #1; the 12th PUT dies.
    await expect(a.sync.run()).rejects.toSatisfy((error: unknown) => isCoreError(error) && /连不上 S3/.test((error as Error).message));
    expect(s3.keys("offeru/refs/")).toEqual([]);
    const before = s3.putCount("offeru/objects/");
    expect(before).toBe(10);

    const done = await a.sync.run();
    expect(done.uploaded_objects).toBe(30 + 2 - before); // 30 records + file chunk + manifest
    expect(s3.putCount("offeru/objects/")).toBe(32);

    const b = device(s3, "B");
    await b.sync.run();
    expect(await b.store.all("memory")).toHaveLength(30);
    expect([...(await b.files.read("photo.png"))].every((byte) => byte === 7)).toBe(true);
  });

  it("rejects a wrong passphrase without touching local data", async () => {
    const s3 = new FakeS3();
    const a = device(s3, "A");
    await a.tool("save", { type: "job", data: { company: "京东", title: "数据" } });
    await a.sync.run();
    const b = device(s3, "B", { passphrase: "not the right one" });
    await b.tool("save", { type: "job", data: { company: "B 自己的", title: "x" } });
    const error = await b.sync.run().catch((cause: unknown) => cause);
    expect(isCoreError(error) && error.code).toBe("forbidden");
    expect(await jobs(b)).toEqual(["x"]);
    expect((await b.sync.status()).last_error).toMatch(/口令不对/);
  });

  it("rejects bad S3 credentials as forbidden", async () => {
    const s3 = new FakeS3();
    const a = device(s3, "A", { secretAccessKey: "wrong" });
    const error = await a.sync.run().catch((cause: unknown) => cause);
    expect(isCoreError(error) && error.code).toBe("forbidden");
  });

  it("re-merges when another device moves refs/latest first (ETag conditional write)", async () => {
    const s3 = new FakeS3();
    const a = device(s3, "A");
    const b = device(s3, "B");
    await a.tool("save", { type: "job", data: { company: "网易", title: "游戏" } });
    await a.sync.run();
    await b.sync.run();

    await a.tool("save", { type: "event", data: { kind: "todo", title: "A 的待办", date: "2026-12-02" } });
    await b.tool("save", { type: "event", data: { kind: "todo", title: "B 的待办", date: "2026-12-03" } });
    let slipped = false;
    s3.beforePut = async (key) => {
      if (slipped || key !== "offeru/refs/latest") return;
      slipped = true;
      s3.beforePut = null;
      await b.sync.run(); // B commits between A's read and A's ref write
    };
    const result = await a.sync.run();
    expect(slipped).toBe(true);
    expect(result.attempts).toBe(2);
    expect(result.conflicts).toEqual([]);
    await b.sync.run();
    for (const dev of [a, b]) {
      expect((await dev.store.all("event")).map((row) => row.title).sort()).toEqual(["A 的待办", "B 的待办"]);
    }
  });

  it("syncs files with conflict copies and deletions", async () => {
    const s3 = new FakeS3();
    const a = device(s3, "A");
    const b = device(s3, "B");
    const enc = (text: string) => new TextEncoder().encode(text);
    await a.files.write("resume/附件.pdf", enc("v1"), "2026-01-01T00:00:00.000Z");
    await a.files.write("logo.png", enc("logo"), "2026-01-01T00:00:00.000Z");
    await a.sync.run();
    await b.sync.run();
    expect(b.files.text("resume/附件.pdf")).toBe("v1");

    await a.files.write("resume/附件.pdf", enc("A edit"), "2026-01-02T00:00:00.000Z");
    await b.files.write("resume/附件.pdf", enc("B edit"), "2026-01-03T00:00:00.000Z");
    await b.files.remove("logo.png");
    await a.sync.run();
    const result = await b.sync.run();
    expect(result.conflicts).toEqual([expect.objectContaining({ kind: "file", kept: "local" })]);
    await a.sync.run();
    for (const dev of [a, b]) {
      expect(dev.files.text("resume/附件.pdf")).toBe("B edit");
      expect(dev.files.text("logo.png")).toBeUndefined();
      const copy = [...dev.files.files.keys()].find((path) => path.includes("冲突"))!;
      expect(copy).toMatch(/^resume\/附件 \(冲突 B \d{4}-\d{2}-\d{2}\)\.pdf$/);
      expect(dev.files.text(copy)).toBe("A edit");
    }
  });

  it("garbage-collects old snapshots and unreferenced objects but keeps the data restorable", async () => {
    const s3 = new FakeS3();
    const a = device(s3, "A", {}, { keepSnapshots: 1, keepDays: 0, gcGraceHours: 1 });
    const job = (await a.tool("save", { type: "job", data: { company: "小红书", title: "v0" } })).record;
    await a.sync.run();
    for (let i = 1; i <= 3; i += 1) {
      await a.tool("save", { type: "job", id: job.id, data: { title: `v${i}` } });
      await a.sync.run();
    }
    expect(s3.keys("offeru/snapshots/")).toHaveLength(4);
    expect(s3.keys("offeru/objects/")).toHaveLength(4);

    s3.age(2 * 3_600_000);
    const result = await a.sync.run({ gc: true });
    expect(result.gc).toEqual({ snapshots_deleted: 3, objects_deleted: 3, snapshots_kept: 1 });
    expect(s3.keys("offeru/objects/")).toHaveLength(1);

    const c = device(s3, "C");
    await c.sync.run();
    expect(await jobs(c)).toEqual(["v3"]);
  });

  it("adopts identical records on first contact instead of duplicating them", async () => {
    const s3 = new FakeS3();
    const a = device(s3, "A");
    const b = device(s3, "B");
    const now = "2026-01-01T00:00:00.000Z";
    for (const dev of [a, b]) await dev.store.put("job", { company: "同一份", title: "导入的" }, { now });
    await a.sync.run();
    await b.sync.run();
    expect(await jobs(b)).toEqual(["导入的"]);
  });
});

describe("/api/sync routes", () => {
  it("saves config without echoing secrets, runs, and reports status", async () => {
    const s3 = new FakeS3();
    const dev = device(s3, "A");
    dev.config.value = null;
    const app = createApp({ store: dev.store, runtime: "node", storage: "sqlite", sync: dev.sync });
    const call = (method: string, path: string, body?: unknown) =>
      app.request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

    expect(await (await call("GET", "/api/sync/config")).json()).toMatchObject({ configured: false, prefix: "offeru/" });
    expect((await call("POST", "/api/sync/run", {})).status).toBe(400);
    expect((await call("PUT", "/api/sync/config", { passphrase: "short" })).status).toBe(400);

    const saved = await (await call("PUT", "/api/sync/config", {
      endpoint: "https://s3.test/", bucket: "offeru-test", prefix: "/offeru", access_key_id: "AKTEST",
      secret_access_key: "secret-test", passphrase: "correct horse battery", device_name: "笔记本",
    })).json() as Record<string, unknown>;
    expect(saved).toMatchObject({ configured: true, endpoint: "https://s3.test", prefix: "offeru/", has_secret: true, has_passphrase: true, device_name: "笔记本" });
    expect(JSON.stringify(saved)).not.toContain("secret-test");
    expect(JSON.stringify(saved)).not.toContain("correct horse");

    // Saving again with blank secrets keeps them.
    await call("PUT", "/api/sync/config", { auto_minutes: 30, secret_access_key: "", passphrase: "" });
    expect((dev.config.value as SyncConfig | null)?.secretAccessKey).toBe("secret-test");
    expect((dev.config.value as SyncConfig | null)?.autoMinutes).toBe(30);
    dev.sync.stopAuto();

    await dev.tool("save", { type: "job", data: { company: "x", title: "y" } });
    const run = await (await call("POST", "/api/sync/run", {})).json() as Record<string, unknown>;
    expect(run).toMatchObject({ ok: true, pushed: 1 });
    const status = await (await call("GET", "/api/sync/status")).json() as Record<string, unknown>;
    expect(status).toMatchObject({ configured: true, running: false, last_error: null, auto_minutes: 30 });

    expect(await (await call("DELETE", "/api/sync/config")).json()).toEqual({ ok: true });
    expect(dev.config.value).toBeNull();
  });

  it("answers 501 where there is no local data (stateless Worker)", async () => {
    const store = new SqliteCoreStore(":memory:");
    stores.push(store);
    const app = createApp({ store, runtime: "worker", storage: "none" });
    expect((await app.request("/api/sync/status")).status).toBe(501);
  });
});
