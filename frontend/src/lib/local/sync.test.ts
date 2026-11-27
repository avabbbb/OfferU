// @vitest-environment node
// (MemoryS3 checks `body instanceof Uint8Array`; jsdom has its own Uint8Array.)
import { describe, expect, it } from "vitest";
import { MemoryCoreStore, MemoryS3, MemoryStateStore, S3BlobStore, SyncEngine } from "@offeru/sync";
import { saveRecord } from "@offeru/core";

import { BrowserSyncController } from "./sync";

function memoryBox() {
  const items = new Map<string, unknown>();
  return {
    getItem: async (key: string) => (items.has(key) ? structuredClone(items.get(key)) : null),
    setItem: async (key: string, value: unknown) => { items.set(key, structuredClone(value)); return value; },
    removeItem: async (key: string) => { items.delete(key); },
  } as unknown as LocalForage;
}

const PASS = "a long sync passphrase";

describe("web build /api/sync controller", () => {
  it("pulls what another device (the Agent's CLI) pushed, keeps secrets out of status, survives a reload", async () => {
    const s3 = new MemoryS3();
    const bucket = { endpoint: "https://s3.mock.local", bucket: s3.bucket, region: "auto", accessKeyId: s3.accessKeyId, secretAccessKey: "the-secret-key", prefix: "offeru" };
    const agentStore = new MemoryCoreStore();
    await saveRecord(agentStore, { type: "job", data: { company: "飞书", title: "产品经理实习生" } }, { actor: "agent", now: "2026-11-26T12:00:00Z", today: "2026-11-26" });
    await new SyncEngine({ store: agentStore, blobs: new S3BlobStore(bucket, s3.fetch), state: new MemoryStateStore(), passphrase: PASS, kdfIterations: 1000 }).sync();

    const box = memoryBox();
    const page = new MemoryCoreStore();
    const sync = new BrowserSyncController(page, { fetch: s3.fetch, kdfIterations: 1000, box });
    await expect(sync.configure({ ...bucket, passphrase: "wrong passphrase" })).rejects.toMatchObject({ code: "passphrase" });
    const status = await sync.configure({ ...bucket, passphrase: PASS });
    expect(JSON.stringify(status)).not.toContain("the-secret-key");
    expect(status).toMatchObject({ configured: true, config: { bucket: s3.bucket, accessKeyId: expect.stringContaining("••••") } });
    const { result } = await sync.syncNow();
    expect(result.pulled).toBe(1);

    const reloaded = new BrowserSyncController(page, { fetch: s3.fetch, kdfIterations: 1000, box });
    expect(await reloaded.configured()).toBe(true);
    await expect(reloaded.syncNow()).resolves.toMatchObject({ result: { pulled: 0 } });
  });
});
