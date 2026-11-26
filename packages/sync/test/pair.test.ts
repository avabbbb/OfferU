import { describe, expect, it } from "vitest";

import { fromBase64Url, openPairing, pairingUrl, sealPairing, toBase64Url } from "../src";

const BUCKET = {
  endpoint: "https://acc.r2.cloudflarestorage.com",
  bucket: "offeru",
  region: "auto",
  accessKeyId: "AKIA-pair",
  secretAccessKey: "s3cr3t/with+chars=",
};
const PASS = "correct horse battery staple";
const now = new Date("2026-11-26T12:00:00Z");

describe("pairing link", () => {
  it("seals with the passphrase and opens to the same bucket settings", async () => {
    const { code, expires_at } = await sealPairing(BUCKET, PASS, { now, iterations: 1000 });
    expect(code).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(code).not.toContain("s3cr3t");
    expect(expires_at).toBe("2026-11-26T12:30:00.000Z");
    const payload = await openPairing(code, PASS, { now: new Date("2026-11-26T12:29:00Z") });
    expect(payload).toEqual({ v: 1, ...BUCKET, prefix: "offeru", pathStyle: true, expires_at });
    expect(pairingUrl("https://offeru.avabbbb.com/", code)).toBe(`https://offeru.avabbbb.com/#/sync/pair?c=${code}`);
  });

  it("wrong passphrase, expiry, truncation and tampering each fail with their own code", async () => {
    const { code } = await sealPairing(BUCKET, PASS, { now, iterations: 1000 });
    await expect(openPairing(code, "wrong passphrase", { now })).rejects.toMatchObject({ code: "passphrase", message: expect.stringContaining("口令不对") });
    await expect(openPairing(code, PASS, { now: new Date("2026-11-26T12:30:01Z") })).rejects.toMatchObject({ code: "expired", message: expect.stringContaining("链接已过期") });
    await expect(openPairing(code.slice(0, 20), PASS, { now })).rejects.toMatchObject({ code: "format", message: expect.stringContaining("链接不完整") });
    await expect(openPairing("", PASS, { now })).rejects.toMatchObject({ code: "format" });
    await expect(openPairing(code + "%", PASS, { now })).rejects.toMatchObject({ code: "format" });
    // Swapping the iteration count in the header breaks the AAD.
    const raw = fromBase64Url(code);
    raw[7] ^= 1;
    await expect(openPairing(toBase64Url(raw), PASS, { now })).rejects.toMatchObject({ code: "passphrase" });
  });
});
