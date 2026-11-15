import { describe, expect, it } from "vitest";
import { undoChange } from "../../core/src/index";

import { CONFIG_KEY, LATEST_KEY, MAGIC, MemoryS3, RemoteRepo, SyncEngine, MemoryStateStore, MemoryCoreStore } from "../src";
import { Clock, PASS, blobsFor, device, snapshot } from "./helpers";

const SECRET = "这是一段很私密的JD原文-字节跳动-后端";

function bucketText(s3: MemoryS3): string {
  return [...s3.objects.values()].map((object) => new TextDecoder().decode(object.body)).join("\n");
}

describe("sync engine", () => {
  it("initializes the bucket with nothing readable but a minimal config", async () => {
    const s3 = new MemoryS3();
    const a = device(s3, new Clock());
    await a.save("job", { company: "字节跳动", title: "后端", jd: SECRET });
    await a.save("profile", { name: "张三", phone: "13800000000" });
    const result = await a.engine.sync();
    expect(result.initialized).toBe(true);
    expect(result.pushed).toBe(2);

    expect(s3.keys()).toContain(`offeru/${CONFIG_KEY}`);
    expect(s3.keys()).toContain(`offeru/${LATEST_KEY}`);
    expect(bucketText(s3)).not.toContain(SECRET);
    expect(bucketText(s3)).not.toContain("张三");
    for (const [key, object] of s3.objects) {
      if (key.endsWith(CONFIG_KEY)) continue;
      expect([...object.body.slice(0, 4)]).toEqual([...MAGIC]);
    }
    const config = JSON.parse(new TextDecoder().decode(s3.objects.get(`offeru/${CONFIG_KEY}`)!.body));
    expect(Object.keys(config).sort()).toEqual(["check", "created_at", "format", "kdf", "repo_id", "version"]);
    expect(config.kdf.alg).toBe("PBKDF2-SHA256");
  });

  it("uses a high PBKDF2 iteration count by default", async () => {
    const s3 = new MemoryS3();
    const repo = await RemoteRepo.open(blobsFor(s3), PASS);
    expect(repo.config.kdf.iterations).toBeGreaterThanOrEqual(600_000);
  });

  it("a wrong passphrase fails fast and writes nothing", async () => {
    const s3 = new MemoryS3();
    const clock = new Clock();
    const a = device(s3, clock);
    await a.save("job", { company: "A", title: "x" });
    await a.engine.sync();
    const before = new Map([...s3.objects].map(([key, value]) => [key, value.etag]));
    s3.resetLog();

    const b = device(s3, clock, { passphrase: "wrong passphrase" });
    await b.save("job", { company: "B", title: "y" });
    await expect(b.engine.sync()).rejects.toMatchObject({ name: "SyncError", code: "passphrase" });
    expect(s3.count("PUT")).toBe(0);
    expect(s3.log.map((entry) => entry.key)).toEqual([`offeru/${CONFIG_KEY}`]);
    expect(new Map([...s3.objects].map(([key, value]) => [key, value.etag]))).toEqual(before);
    expect(await b.store.all("job")).toHaveLength(1);
  });

  it("uploads only what changed", async () => {
    const s3 = new MemoryS3();
    const a = device(s3, new Clock());
    const jobs = [];
    for (let i = 0; i < 20; i += 1) jobs.push(await a.save("job", { company: `公司${i}`, title: "后端" }));
    const first = await a.engine.sync();
    expect(first.uploaded.objects).toBe(20);

    await a.save("job", { notes: "二面约了周三" }, jobs[3].id);
    s3.resetLog();
    const second = await a.engine.sync();
    expect(second.uploaded.objects).toBe(1);
    expect(second.pushed).toBe(1);
    expect(s3.count("PUT", "offeru/objects/")).toBe(1);
    expect(s3.count("PUT", "offeru/indexes/")).toBe(1);

    s3.resetLog();
    const third = await a.engine.sync();
    expect(third.uploaded.objects).toBe(0);
    expect(third.pushed).toBe(0);
    expect(s3.count("PUT", "offeru/refs/")).toBe(0);
    expect(s3.count("PUT", "offeru/indexes/")).toBe(0);
    expect(s3.count("GET", "offeru/objects/")).toBe(0);
  });

  it("chunks large records so an edit re-uploads only the changed chunks", async () => {
    const s3 = new MemoryS3();
    const chunks = { min: 4096, avg: 16384, max: 65536 };
    const a = device(s3, new Clock(), { chunks });
    let body = "";
    for (let i = 0; i < 6000; i += 1) body += `第${i}行：项目经历与量化成果 ${i * 7919 % 10007}\n`;
    const doc = await a.save("doc", { kind: "note", title: "长笔记", body });
    const first = await a.engine.sync();
    expect(first.uploaded.objects).toBeGreaterThan(4);

    await a.save("doc", { body: `${body}最后加一行\n` }, doc.id);
    const second = await a.engine.sync();
    expect(second.uploaded.objects).toBeGreaterThanOrEqual(1);
    // Only the tail moves (appended text + updated_at); the head chunks are reused.
    expect(second.uploaded.objects).toBeLessThanOrEqual(3);
    expect(second.uploaded.objects).toBeLessThan(first.uploaded.objects / 2);

    const b = device(s3, new Clock());
    await b.engine.sync();
    expect((await b.store.all("doc"))[0].body).toBe((await a.store.all("doc"))[0].body);
  });

  it("merges concurrent edits to different fields of the same record", async () => {
    const s3 = new MemoryS3();
    const clock = new Clock();
    const a = device(s3, clock);
    const b = device(s3, clock);
    const job = await a.save("job", { company: "腾讯", title: "前端" });
    await a.save("event", { title: "笔试", kind: "test", job_id: job.id });
    await a.engine.sync();
    await b.engine.sync();
    const bJob = (await b.store.all("job"))[0];
    expect((await b.store.all("event"))[0].job_id).toBe(bJob.id);

    await a.save("job", { notes: "内推码 ABC" }, job.id);
    await b.save("job", { status: "applied" }, bJob.id);
    await a.engine.sync();
    const merged = await b.engine.sync();
    expect(merged.conflicts).toBe(0);
    await a.engine.sync();

    for (const store of [a.store, b.store]) {
      const [record] = await store.all("job");
      expect(record).toMatchObject({ notes: "内推码 ABC", status: "applied" });
    }
    expect(await snapshot(a.store)).toEqual(await snapshot(b.store));
    expect((await b.store.changes(50)).some((row) => row.actor === "同步")).toBe(true);
  });

  it("true conflicts: last writer wins and the losing version is kept as a conflict copy", async () => {
    const s3 = new MemoryS3();
    const clock = new Clock();
    const a = device(s3, clock);
    const b = device(s3, clock);
    const job = await a.save("job", { company: "美团", title: "算法" });
    await a.engine.sync();
    await b.engine.sync();
    const bJob = (await b.store.all("job"))[0];

    await a.save("job", { city: "北京" }, job.id);
    await b.save("job", { city: "上海" }, bJob.id); // later
    await a.engine.sync();
    const result = await b.engine.sync();
    expect(result.conflicts).toBe(1);
    await a.engine.sync();

    for (const store of [a.store, b.store]) {
      expect((await store.all("job"))[0].city).toBe("上海");
      const copies = (await store.all("doc")).filter((doc) => doc.sync_conflict);
      expect(copies).toHaveLength(1);
      expect(String(copies[0].body)).toContain("北京");
      expect(copies[0].job_id).toBe((await store.all("job"))[0].id);
    }
    expect(await snapshot(a.store)).toEqual(await snapshot(b.store));
  });

  it("delete vs edit: the edit survives on both devices; an untouched record is deleted", async () => {
    const s3 = new MemoryS3();
    const clock = new Clock();
    const a = device(s3, clock);
    const b = device(s3, clock);
    const kept = await a.save("job", { company: "阿里", title: "Java" });
    const gone = await a.save("job", { company: "网易", title: "游戏" });
    await a.engine.sync();
    await b.engine.sync();
    const bKept = (await b.store.all("job")).find((job) => job.company === "阿里")!;

    await a.remove("job", kept.id);
    await a.remove("job", gone.id);
    await b.save("job", { notes: "HR 刚打电话" }, bKept.id);
    await a.engine.sync();
    const result = await b.engine.sync();
    expect(result.resurrected).toBe(1);
    const back = await a.engine.sync();
    expect(back.pulled).toBe(1);

    for (const store of [a.store, b.store]) {
      const jobs = await store.all("job");
      expect(jobs.map((job) => job.company)).toEqual(["阿里"]);
      expect(jobs[0].notes).toBe("HR 刚打电话");
    }
    // A got its record back under its old id.
    expect((await a.store.all("job"))[0].id).toBe(kept.id);
  });

  it("lock contention: a live lock blocks, an expired one is taken over", async () => {
    const s3 = new MemoryS3();
    const clock = new Clock();
    const other = await RemoteRepo.open(blobsFor(s3), PASS, { iterations: 1000 });
    await other.acquireLock("other-device", { ttlMs: 60_000, attempts: 1, waitMs: 0, now: () => clock.ms, sleep: async () => undefined });

    const b = device(s3, clock);
    await b.save("job", { company: "B", title: "y" });
    await expect(b.engine.sync()).rejects.toMatchObject({ code: "locked" });
    expect(s3.keys("offeru/refs/")).toHaveLength(0);

    clock.ms += 120_000;
    const result = await b.engine.sync();
    expect(result.pushed).toBe(1);
    expect(s3.keys()).not.toContain("offeru/lock");
  });

  it("losing the refs/latest race re-merges and retries", async () => {
    const s3 = new MemoryS3();
    const clockA = new Clock();
    const clockB = new Clock();
    const a = device(s3, clockA);
    const b = device(s3, clockB);
    await a.save("job", { company: "共享", title: "x" });
    await a.engine.sync();
    await b.engine.sync();

    await b.save("memory", { kind: "skill", title: "Rust" });
    await a.save("memory", { kind: "skill", title: "Go" });
    let raced = false;
    s3.beforeRequest = async (method, key) => {
      if (raced || method !== "PUT" || key !== "offeru/refs/latest") return;
      raced = true;
      clockA.ms += 10 * 60_000; // A sees B's lock as expired and commits first
      await a.engine.sync();
    };
    const result = await b.engine.sync();
    s3.beforeRequest = undefined;
    expect(raced).toBe(true);
    expect(result.attempts).toBe(2);
    expect(result.conflicts).toBe(0);
    await a.engine.sync();
    const titles = (await a.store.all("memory")).map((m) => m.title).sort();
    expect(titles).toEqual(["Go", "Rust"]);
    expect(await snapshot(a.store)).toEqual(await snapshot(b.store));
  });

  it("first sync of a device that already has the same data adopts instead of duplicating", async () => {
    const s3 = new MemoryS3();
    const clock = new Clock();
    const a = device(s3, clock);
    await a.save("profile", { name: "李四", school: "清华" });
    const job = await a.save("job", { company: "华为", title: "嵌入式" });
    await a.engine.sync();

    // Device B starts from a copy of A's database (same rows, same timestamps).
    const copy = new MemoryCoreStore();
    copy.records = structuredClone((a.store as MemoryCoreStore).records);
    const b = device(s3, clock, { store: copy });
    await b.save("profile", { major: "计算机" }, (await copy.first("profile"))!.id);
    await b.engine.sync();
    await a.engine.sync();
    for (const store of [a.store, b.store]) {
      expect(await store.all("job")).toHaveLength(1);
      expect(await store.all("profile")).toHaveLength(1);
      expect((await store.first("profile"))).toMatchObject({ name: "李四", school: "清华", major: "计算机" });
    }
    expect(job.id).toBe((await b.store.all("job"))[0].id);
  });

  it("sync writes are undoable change-log rows", async () => {
    const s3 = new MemoryS3();
    const clock = new Clock();
    const a = device(s3, clock);
    const b = device(s3, clock);
    const job = await a.save("job", { company: "快手", title: "推荐" });
    await a.engine.sync();
    await b.engine.sync();
    await a.save("job", { status: "applied" }, job.id);
    await a.engine.sync();
    await b.engine.sync();
    const [row] = (await b.store.changes(1));
    expect(row.actor).toBe("同步");
    expect(row.summary).toContain("同步更新岗位");
    await undoChange(b.store, { change_id: row.id }, { actor: "你", now: clock.iso(), today: "2026-11-15" });
    expect((await b.store.all("job"))[0].status).toBe("saved");
  });

  it("status reports pending local changes", async () => {
    const s3 = new MemoryS3();
    const engine = new SyncEngine({ store: new MemoryCoreStore(), blobs: blobsFor(s3), state: new MemoryStateStore(), passphrase: PASS, kdfIterations: 1000 });
    expect((await engine.status()).pending).toBe(0);
    await engine.sync();
    expect((await engine.status()).last_index).toBeNull();
  });
});
