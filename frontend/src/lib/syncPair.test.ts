import { describe, expect, it, vi } from "vitest";
import { sealPairing } from "@offeru/sync";

import { completePairing, pairCodeOf } from "./syncPair";

const BUCKET = { endpoint: "https://acc.r2.cloudflarestorage.com", bucket: "offeru", region: "auto", accessKeyId: "AK", secretAccessKey: "SK" };
const PASS = "agent generated passphrase";
const result = { at: "2026-11-26T12:00:00Z", pulled: 12, pushed: 0, conflicts: 0, resurrected: 0, uploaded: { objects: 0, bytes: 0 } };

function fakeApi() {
  return { configure: vi.fn(async () => ({}) as never), now: vi.fn(async () => ({ result, status: {} as never })) };
}

describe("#/sync/pair", () => {
  it("reads the code from the hash query", () => {
    expect(pairCodeOf("?c=abc_-1")).toBe("abc_-1");
    expect(pairCodeOf("")).toBe("");
  });

  it("decrypts with the passphrase, saves the settings like the sync panel, then syncs once", async () => {
    const { code } = await sealPairing(BUCKET, PASS, { iterations: 1000 });
    const api = fakeApi();
    await expect(completePairing(code, PASS, api)).resolves.toMatchObject({ pulled: 12 });
    expect(api.configure).toHaveBeenCalledWith({ ...BUCKET, prefix: "offeru", pathStyle: true, passphrase: PASS });
    expect(api.now).toHaveBeenCalledTimes(1);
  });

  it("maps failures to the three Chinese errors and saves nothing", async () => {
    const now = new Date("2026-11-26T12:00:00Z");
    const { code } = await sealPairing(BUCKET, PASS, { iterations: 1000, now });
    const api = fakeApi();
    await expect(completePairing(code, "wrong one", api, now)).rejects.toMatchObject({ kind: "passphrase", message: expect.stringContaining("口令不对") });
    await expect(completePairing(code, PASS, api, new Date("2026-11-26T13:00:00Z"))).rejects.toMatchObject({ kind: "expired", message: expect.stringContaining("链接已过期") });
    await expect(completePairing(code.slice(0, 30), PASS, api, now)).rejects.toMatchObject({ kind: "incomplete", message: expect.stringContaining("链接不完整") });
    await expect(completePairing("", PASS, api, now)).rejects.toMatchObject({ kind: "incomplete" });
    expect(api.configure).not.toHaveBeenCalled();
    const bucketSaysNo = { ...fakeApi(), configure: vi.fn(async () => { throw Object.assign(new Error("x"), { code: "sync_passphrase" }); }) };
    await expect(completePairing(code, PASS, bucketSaysNo, now)).rejects.toMatchObject({ kind: "passphrase" });
  });
});
