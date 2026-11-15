import { describe, expect, it } from "vitest";

import {
  MemoryCoreStore,
  MemoryS3,
  type SyncProgress,
  decodeBundle,
  diagnoseS3,
  encodeBundle,
  exportBundle,
  importBundle,
  listConflicts,
  resolveConflict,
} from "../src";
import { Clock, PASS, device, snapshot } from "./helpers";

const BIG = { min: 64, avg: 256, max: 1024 };

async function seed(save: (type: string, data: Record<string, unknown>) => Promise<unknown>, jobs = 30) {
  await save("profile", { name: "张三", school: "清华" });
  for (let i = 0; i < jobs; i += 1) await save("job", { company: `公司${i}`, title: "后端", jd: `职责 ${i} `.repeat(200) });
}

describe("progress", () => {
  it("reports upload then download counters that end at their totals", async () => {
    const s3 = new MemoryS3();
    const clock = new Clock();
    const events: SyncProgress[] = [];
    const a = device(s3, clock, { chunks: BIG, onProgress: (p) => events.push(p) });
    await seed(a.save);
    const result = await a.engine.sync();

    const phases = [...new Set(events.map((e) => e.phase))];
    expect(phases).toEqual(["connect", "lock", "download", "merge", "upload", "commit", "done"]);
    const last = events.at(-1)!;
    expect(last.upload.total).toBeGreaterThan(30);
    expect(last.upload.done).toBe(last.upload.total);
    expect(last.upload.bytes).toBe(result.uploaded.bytes);
    // counters only grow
    const done = events.map((e) => e.upload.done);
    expect(done).toEqual([...done].sort((x, y) => x - y));

    const seen: SyncProgress[] = [];
    const b = device(s3, clock, { chunks: BIG, onProgress: (p) => seen.push(p) });
    const pulled = await b.engine.sync();
    const end = seen.at(-1)!;
    expect(end.download.total).toBe(last.upload.total);
    expect(end.download.done).toBe(end.download.total);
    expect(end.download.bytes).toBe(pulled.downloaded.bytes);
    expect(pulled.downloaded.objects).toBe(end.download.total);
  });
});

describe("resume", () => {
  it("an interrupted first upload resumes without re-uploading or re-checking finished chunks", async () => {
    const s3 = new MemoryS3();
    const clock = new Clock();
    const a = device(s3, clock, { chunks: BIG, concurrency: 1 });
    await seed(a.save);

    let puts = 0;
    s3.beforeRequest = (method, key) => {
      if (method === "PUT" && key.startsWith("offeru/objects/") && ++puts === 21) throw new TypeError("network dropped");
    };
    await expect(a.engine.sync()).rejects.toMatchObject({ code: "network" });
    const uploadedBefore = s3.keys("offeru/objects/").length;
    expect(uploadedBefore).toBe(20);
    expect((await a.state.load())!.uploaded).toHaveLength(20);

    s3.beforeRequest = undefined;
    s3.resetLog();
    const result = await a.engine.sync();
    expect(result.skipped).toBe(0);
    expect(s3.count("PUT", "offeru/objects/")).toBe(result.uploaded.objects);
    const heads = s3.log.filter((entry) => entry.method === "HEAD" && entry.key.startsWith("offeru/objects/")).length;
    expect(heads).toBe(result.uploaded.objects); // finished chunks are not even HEADed
    expect(uploadedBefore + result.uploaded.objects).toBe(s3.keys("offeru/objects/").length);
    expect((await a.state.load())!.uploaded).toBeUndefined();

    const b = device(s3, clock, { chunks: BIG });
    await b.engine.sync();
    expect(await snapshot(b.store)).toEqual(await snapshot(a.store));
  });

  it("without the checkpoint (state lost) finished chunks are found by HEAD and counted as skipped", async () => {
    const s3 = new MemoryS3();
    const clock = new Clock();
    const a = device(s3, clock, { chunks: BIG, concurrency: 1 });
    await seed(a.save);
    let puts = 0;
    s3.beforeRequest = (method, key) => {
      if (method === "PUT" && key.startsWith("offeru/objects/") && ++puts === 11) throw new TypeError("network dropped");
    };
    await expect(a.engine.sync()).rejects.toMatchObject({ code: "network" });
    s3.beforeRequest = undefined;
    const state = (await a.state.load())!;
    await a.state.save({ ...state, uploaded: undefined });
    const result = await a.engine.sync();
    expect(result.skipped).toBe(10);
    expect(s3.count("PUT", "offeru/objects/")).toBe(10 + result.uploaded.objects);
  });
});

describe("encrypted backup bundle", () => {
  it("export -> import roundtrips every record, offline, and the file is opaque", async () => {
    const clock = new Clock();
    const s3 = new MemoryS3();
    const a = device(s3, clock);
    await seed(a.save, 5);
    await a.save("memory", { body: "很私密的偏好：只投北京" });
    const before = await a.store.changes(1000);
    const { bytes, records } = await exportBundle({ store: a.store, passphrase: PASS, kdfIterations: 1000, now: clock.tick });
    expect(records).toBe(7);
    expect(await a.store.changes(1000)).toEqual(before); // export does not touch local data
    const text = new TextDecoder().decode(bytes);
    expect(text.startsWith("OUBK")).toBe(true);
    expect(text).not.toContain("很私密");
    expect(text).not.toContain("张三");
    expect(s3.log).toHaveLength(0); // no network at all

    const fresh = new MemoryCoreStore();
    const result = await importBundle({ store: fresh, bytes, passphrase: PASS, now: clock.tick });
    expect(result.pulled).toBe(7);
    expect(await snapshot(fresh)).toEqual(await snapshot(a.store));
    expect((await fresh.changes(100)).every((row) => row.actor === "导入备份")).toBe(true);

    // importing the same file again changes nothing
    const again = await importBundle({ store: fresh, bytes, passphrase: PASS, now: clock.tick });
    expect(again.pulled).toBe(0);
    expect(await snapshot(fresh)).toEqual(await snapshot(a.store));
  });

  it("wrong passphrase and corrupt files fail before writing", async () => {
    const clock = new Clock();
    const store = new MemoryCoreStore();
    const a = device(new MemoryS3(), clock, { store });
    await a.save("job", { company: "X", title: "y" });
    const { bytes } = await exportBundle({ store, passphrase: PASS, kdfIterations: 1000 });
    const target = new MemoryCoreStore();
    await expect(importBundle({ store: target, bytes, passphrase: "not the passphrase" })).rejects.toMatchObject({ code: "passphrase" });
    await expect(importBundle({ store: target, bytes: bytes.slice(0, bytes.length - 10), passphrase: PASS })).rejects.toMatchObject({ code: "format" });
    await expect(importBundle({ store: target, bytes: new TextEncoder().encode("{\"jobs\":[]}"), passphrase: PASS })).rejects.toMatchObject({ code: "format" });
    expect(await target.all("job")).toHaveLength(0);
    await expect(exportBundle({ store, passphrase: "short" })).rejects.toMatchObject({ code: "config" });
  });

  it("encode/decode keeps every object byte for byte", async () => {
    const store = new MemoryCoreStore();
    const a = device(new MemoryS3(), new Clock(), { store });
    await a.save("doc", { kind: "note", title: "t", body: "x".repeat(5000) });
    const { bytes } = await exportBundle({ store, passphrase: PASS, kdfIterations: 1000 });
    const decoded = decodeBundle(bytes);
    expect(encodeBundle(decoded.objects)).toEqual(bytes);
  });

  it("importing into a device that already syncs merges without duplicates and pushes on next sync", async () => {
    const s3 = new MemoryS3();
    const clock = new Clock();
    const laptop = device(s3, clock);
    await laptop.save("job", { company: "共享", title: "两边都有" });
    await laptop.engine.sync();
    const browser = device(s3, clock);
    await browser.engine.sync();
    await browser.save("job", { company: "只在浏览器", title: "离线加的" });
    const { bytes } = await exportBundle({ store: browser.store, passphrase: "another backup pass", kdfIterations: 1000 });

    await importBundle({ store: laptop.store, bytes, passphrase: "another backup pass" });
    expect((await laptop.store.all("job")).map((job) => job.company).sort()).toEqual(["共享", "只在浏览器"]);
    await laptop.engine.sync();
    await browser.engine.sync();
    await laptop.engine.sync();
    for (const store of [laptop.store, browser.store]) {
      expect((await store.all("job")).map((job) => job.company).sort()).toEqual(["共享", "只在浏览器"]);
    }
  });
});

describe("diagnostics", () => {
  const cfg = (s3: MemoryS3, extra: Record<string, unknown> = {}) => ({
    endpoint: "https://s3.mock.local", bucket: s3.bucket, region: "auto", accessKeyId: s3.accessKeyId, secretAccessKey: "s", prefix: "offeru", ...extra,
  });
  const status = (d: { checks: { id: string; status: string }[] }) => Object.fromEntries(d.checks.map((c) => [c.id, c.status]));

  it("all green on an empty prefix, and leaves nothing behind", async () => {
    const s3 = new MemoryS3();
    const d = await diagnoseS3(cfg(s3), { fetch: s3.fetch });
    expect(d.ok).toBe(true);
    expect(d.repo).toBe("empty");
    expect(status(d)).toEqual({ network: "ok", clock: "ok", auth: "ok", bucket: "ok", write: "ok", conditional: "ok", repo: "ok" });
    expect(s3.keys()).toEqual([]);
  });

  it("existing repo: checks the passphrase", async () => {
    const s3 = new MemoryS3();
    const a = device(s3, new Clock(Date.now()));
    await a.save("job", { company: "X", title: "y" });
    await a.engine.sync();
    expect((await diagnoseS3(cfg(s3), { fetch: s3.fetch, passphrase: PASS })).passphrase).toBe("ok");
    const wrong = await diagnoseS3(cfg(s3), { fetch: s3.fetch, passphrase: "wrong passphrase" });
    expect(wrong.ok).toBe(false);
    expect(wrong.checks.at(-1)).toMatchObject({ id: "repo", status: "fail", code: "passphrase" });
  });

  it("names the failing layer", async () => {
    const s3 = new MemoryS3();
    expect((await diagnoseS3(cfg(s3, { bucket: "nope" }), { fetch: s3.fetch })).checks.at(-1)).toMatchObject({ id: "bucket", status: "fail", code: "NoSuchBucket" });
    expect((await diagnoseS3(cfg(s3, { accessKeyId: "someone-else" }), { fetch: s3.fetch })).checks.at(-1)).toMatchObject({ id: "auth", status: "fail", code: "AccessDenied" });

    const skewed = new MemoryS3();
    skewed.now = () => Date.now() + 40 * 60_000;
    const clock = await diagnoseS3(cfg(skewed), { fetch: skewed.fetch });
    expect(clock.checks.at(-1)).toMatchObject({ id: "clock", status: "fail" });
    expect(clock.checks.at(-1)!.detail).toContain("15 分钟");

    const readOnly = new MemoryS3();
    readOnly.readOnly = true;
    expect((await diagnoseS3(cfg(readOnly), { fetch: readOnly.fetch })).checks.at(-1)).toMatchObject({ id: "write", status: "fail" });

    const lax = new MemoryS3();
    lax.conditionalWrites = false;
    const warned = await diagnoseS3(cfg(lax), { fetch: lax.fetch });
    expect(warned.ok).toBe(true);
    expect(status(warned).conditional).toBe("warn");

    const dns = await diagnoseS3(cfg(s3), { fetch: async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } }); } });
    expect(dns.checks.at(-1)).toMatchObject({ id: "network", status: "fail", code: "dns" });

    expect((await diagnoseS3(cfg(s3, { bucket: "" }), { fetch: s3.fetch })).checks).toEqual([{ id: "config", status: "fail", detail: "请填写存储桶名称" }]);
  });

  it("browser: tells CORS apart from an unreachable host, and catches a hidden ETag", async () => {
    const s3 = new MemoryS3();
    const corsBlocked = async (input: string, init: RequestInit = {}) => {
      if ((init as { mode?: string }).mode === "no-cors") return new Response(null, { status: 200 });
      throw new TypeError("Failed to fetch");
    };
    const blocked = await diagnoseS3(cfg(s3), { fetch: corsBlocked, browser: true });
    expect(status(blocked)).toEqual({ network: "ok", cors: "fail" });

    const offline = await diagnoseS3(cfg(s3), { fetch: async () => { throw new TypeError("Failed to fetch"); }, browser: true });
    expect(status(offline)).toEqual({ network: "fail" });

    const writeBlocked = async (input: string, init: RequestInit = {}) => {
      if (init.method === "PUT") throw new TypeError("Failed to fetch");
      return s3.fetch(input, init);
    };
    const partial = await diagnoseS3(cfg(s3), { fetch: writeBlocked, browser: true });
    expect(partial.checks.at(-1)).toMatchObject({ id: "cors", status: "fail", code: "cors_write" });
    expect(partial.checks.filter((c) => c.id === "cors")).toHaveLength(1);

    const noEtag = async (input: string, init: RequestInit = {}) => {
      const response = await s3.fetch(input, init);
      const headers = new Headers(response.headers);
      headers.delete("etag");
      return new Response(response.body, { status: response.status, headers });
    };
    expect((await diagnoseS3(cfg(s3), { fetch: noEtag, browser: true })).checks.at(-1)).toMatchObject({ id: "write", status: "fail", code: "etag_hidden" });
    expect(s3.keys()).toEqual([]);
  });
});

describe("conflict view", () => {
  async function conflicted() {
    const s3 = new MemoryS3();
    const clock = new Clock();
    const a = device(s3, clock);
    const b = device(s3, clock);
    const job = await a.save("job", { company: "美团", title: "算法" });
    await a.engine.sync();
    await b.engine.sync();
    const bJob = (await b.store.all("job"))[0];
    await a.save("job", { city: "北京" }, job.id);
    await b.save("job", { city: "上海" }, bJob.id); // later: wins
    await a.engine.sync();
    await b.engine.sync();
    await a.engine.sync();
    return { a, b, s3, clock };
  }

  it("lists mine / theirs from each device's point of view", async () => {
    const { a, b } = await conflicted();
    const [onA] = await listConflicts(a.store, await a.state.load());
    expect(onA).toMatchObject({ fields: ["city"], mine: { city: "北京" }, theirs: { city: "上海" }, current: "theirs", resolvable: true });
    expect(onA.record.label).toContain("美团");
    const [onB] = await listConflicts(b.store, await b.state.load());
    expect(onB).toMatchObject({ mine: { city: "上海" }, theirs: { city: "北京" }, current: "mine" });
  });

  it("keep-mine on the losing device writes it back, removes the note, and syncs everywhere", async () => {
    const { a, b, clock } = await conflicted();
    const [conflict] = await listConflicts(a.store, await a.state.load());
    const out = await resolveConflict(a.store, await a.state.load(), conflict.id, "mine", { actor: "你", now: clock.iso() });
    expect(out.applied).toBe(true);
    expect((await a.store.all("job"))[0].city).toBe("北京");
    expect(await listConflicts(a.store, await a.state.load())).toEqual([]);
    expect((await a.store.changes(2)).map((row) => row.summary).join()).toContain("处理同步冲突");
    await a.engine.sync();
    await b.engine.sync();
    expect((await b.store.all("job"))[0].city).toBe("北京");
    expect(await listConflicts(b.store, await b.state.load())).toEqual([]);
  });

  it("keeping the current winner only dismisses the note", async () => {
    const { b, clock } = await conflicted();
    const [conflict] = await listConflicts(b.store, await b.state.load());
    const out = await resolveConflict(b.store, await b.state.load(), conflict.id, "mine", { actor: "你", now: clock.iso() });
    expect(out.applied).toBe(false);
    expect((await b.store.all("job"))[0].city).toBe("上海");
    expect(await listConflicts(b.store, await b.state.load())).toEqual([]);
    await expect(resolveConflict(b.store, await b.state.load(), conflict.id, "mine", { actor: "你", now: clock.iso() })).rejects.toMatchObject({ code: "config" });
  });
});
