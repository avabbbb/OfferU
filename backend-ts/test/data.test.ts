// Data backup / restore: export_data / import_data and the backup routes, against Python's store
// (fixtures/data/gen_data_roundtrip.py: a store Python wrote, its rows and its own tool views).

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { exportData, importData, parseSnapshot } from "@offeru/core";
import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app";
import { nodeBackupFiles } from "../src/routes/companion/backups";
import { SqliteCoreStore } from "../src/store";
import { callTool } from "../src/tools";

const here = dirname(fileURLToPath(import.meta.url));
const python = JSON.parse(readFileSync(join(here, "fixtures/data/python-store.json"), "utf8"));
const USER = { actor: "你", now: "2026-11-15T12:00:00", today: "2026-11-15" };

let stores: SqliteCoreStore[] = [];
afterEach(() => {
  for (const s of stores) s.close();
  stores = [];
});
const open = (path = ":memory:") => {
  const s = new SqliteCoreStore(path);
  stores.push(s);
  return s;
};
/** Python's change views carry SQLite ints (created: 1); TS booleans. Same truth value. */
const truthy = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (key, v) => (key === "created" || key === "deleted" ? Boolean(v) : v)));

describe("export_data / import_data vs a Python-written store", () => {
  it("imports Python's rows unchanged and exports the same rows back", async () => {
    const store = open();
    const result = await importData(store, python.snapshot, USER);
    expect(result.imported).toEqual(python.snapshot.counts);
    const out = await exportData(store, "2026-11-15T12:00:00");
    expect({ ...out, exported_at: python.snapshot.exported_at }).toEqual(python.snapshot);
  });

  it("the restored store answers list / get / changes like Python did", async () => {
    const store = open();
    await importData(store, python.snapshot, USER);
    for (const type of ["profile", "memory", "job", "event", "doc"]) {
      expect(await callTool("list", { type, full: true }, store), type).toEqual(python.views.list[type]);
    }
    const jobId = python.views.get_job.record.id;
    expect(await callTool("get", { type: "job", id: jobId }, store)).toEqual(python.views.get_job);
    expect(await callTool("get", { type: "memory", id: python.views.get_memory.record.id }, store)).toEqual(python.views.get_memory);
    expect(truthy(await callTool("changes", { limit: 50 }, store))).toEqual(truthy(python.views.changes));
    // Change ids survive: undoing Python's last change works on the restored store, and new ids continue after Python's.
    const last = python.snapshot.changes.at(-1);
    await callTool("undo", { change_id: last.id }, store);
    const saved = await callTool("save", { type: "memory", data: { title: "新" } }, store) as { record: { id: number }; change_id: number };
    expect(saved.change_id).toBe(last.id + 1); // undo marks the old row, it adds none
    expect(saved.record.id).toBeGreaterThan(Math.max(...python.snapshot.records.map((r: { id: number }) => r.id)));
  });

  it("rejects bad files without touching the data, and only the user may restore", async () => {
    const store = open();
    await callTool("save", { type: "memory", data: { title: "原来的" } }, store);
    const broken = { ...python.snapshot, records: [...python.snapshot.records, { ...python.snapshot.records[0] }] };
    await expect(importData(store, broken, USER)).rejects.toThrow(/出现了两次/);
    await expect(importData(store, { format: "x" }, USER)).rejects.toThrow(/不是 OfferU/);
    await expect(importData(store, python.snapshot, { ...USER, actor: "agent" })).rejects.toMatchObject({ code: "forbidden" });
    expect((await exportData(store, USER.now)).records.map((r) => r.data.title)).toEqual(["原来的"]);
    expect(() => parseSnapshot({ ...python.snapshot, version: 2 })).toThrow(/版本/);
  });

  it("export_data / import_data are registry tools; import_data is user-only", async () => {
    const store = open();
    await callTool("import_data", { snapshot: python.snapshot }, store);
    const snap = await callTool("export_data", {}, store) as { counts: unknown };
    expect(snap.counts).toEqual(python.snapshot.counts);
    await expect(callTool("import_data", { snapshot: python.snapshot }, store, "Claude Code")).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("data routes", () => {
  it("export → import round-trips over HTTP; named backups and restore on the companion", async () => {
    const dir = mkdtempSync(join(tmpdir(), "offeru-data-"));
    const store = open(join(dir, "offeru.db"));
    const app = createApp({ store, runtime: "node", storage: "sqlite", backups: nodeBackupFiles(join(dir, "offeru.db")) });
    const json = (r: Response) => r.json() as Promise<any>;
    await callTool("import_data", { snapshot: python.snapshot }, store);

    const exported = await app.request("/api/data/export");
    expect(exported.headers.get("content-disposition")).toMatch(/offeru-data-\d{8}\.json/);
    const snapshot = await json(exported);

    const backup = await json(await app.request("/api/agent/data/backups", { method: "POST" }));
    expect(backup).toMatchObject({ reason: "user", version: "1", size_bytes: expect.any(Number), archive_sha256: backup.hash });

    await callTool("save", { type: "memory", data: { title: "备份之后加的" } }, store);
    const restored = await json(await app.request("/api/agent/data/restore", { method: "POST", body: JSON.stringify({ backup_id: backup.backup_id }) }));
    expect(restored).toMatchObject({ backup_id: backup.backup_id, pending_restart: false, database_replaced: true });
    expect((await exportData(store, "x")).records).toEqual(snapshot.records);

    const listed = await json(await app.request("/api/agent/data/backups"));
    expect(listed.items.map((i: { reason: string }) => i.reason).sort()).toEqual(["pre_restore", "user"]);
    expect(await json(await app.request("/api/agent/data/safety/status"))).toMatchObject({ backup_count: 2, invalid_backup_count: 0, pending_restore: null });

    const imported = await app.request("/api/data/import", { method: "POST", body: JSON.stringify({ snapshot }) });
    expect(imported.status).toBe(200);
    expect((await json(imported)).pre_restore_backup_id).toMatch(/^[0-9a-f]{32}$/);
    const agent = await app.request("/api/data/import", { method: "POST", headers: { "x-offeru-actor": "agent" }, body: JSON.stringify({ snapshot }) });
    expect(agent.status).toBe(403);
  });

  it("export / import work without backup storage (browser), named backups are 501 there", async () => {
    const store = open();
    const web = createApp({ store, runtime: "worker", storage: "none" });
    expect((await web.request("/api/data/import", { method: "POST", body: JSON.stringify(python.snapshot) })).status).toBe(200);
    expect((await (await web.request("/api/data/export")).json() as any).counts).toEqual(python.snapshot.counts);
    expect((await web.request("/api/agent/data/backups")).status).toBe(501);
  });

  const pythonReady = (() => { try { execFileSync("python3", ["-c", "import pydantic"], { stdio: "ignore" }); return true; } catch { return false; } })();
  it.skipIf(!pythonReady)("Python reads a store TS restored (same schema)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "offeru-py-"));
    const store = open(join(dir, "offeru.db"));
    await importData(store, python.snapshot, USER);
    store.close();
    stores = [];
    const out = execFileSync("python3", ["-c", [
      "import json, sys",
      `sys.path.insert(0, ${JSON.stringify(resolve(here, "../../backend"))})`,
      "from app.core import tools",
      "print(json.dumps({t: tools.call('list', {'type': t, 'full': True}, actor='你') for t in ['profile','memory','job','event','doc']}, ensure_ascii=False))",
    ].join("\n")], { env: { ...process.env, OFFERU_DATA_DIR: dir }, encoding: "utf8" });
    expect(JSON.parse(out)).toEqual(python.views.list);
  });

  it("legacy /api/agent/data/export answers the settings page and stays importable", async () => {
    const store = open();
    await importData(store, python.snapshot, USER);
    const app = createApp({ store, runtime: "worker", storage: "none" });
    const res = await app.request("/api/agent/data/export");
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, any>;
    expect(body.schema_version).toBe("offeru.internal-beta.export.v1");
    expect(body.counts.changes).toBeUndefined();
    expect(() => parseSnapshot(body)).not.toThrow();
  });
});

