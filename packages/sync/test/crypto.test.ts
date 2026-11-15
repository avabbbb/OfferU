import { describe, expect, it } from "vitest";

import {
  SyncError,
  chunk,
  contentId,
  deriveKeys,
  newKdfParams,
  open,
  randomBytes,
  seal,
  signRequest,
  utf8,
} from "../src";

describe("sigv4", () => {
  it("matches the AWS documented GET Object example", async () => {
    const headers = await signRequest({
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
      headers: { range: "bytes=0-9" },
      credentials: { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", region: "us-east-1" },
      date: new Date("2013-05-24T00:00:00Z"),
    });
    expect(headers.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, "
        + "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, "
        + "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
  });
});

describe("encryption", () => {
  it("round-trips, compresses, and binds the object name", async () => {
    const keys = await deriveKeys("pass", newKdfParams(1000));
    const text = utf8("岗位 JD ".repeat(500));
    const sealed = await seal(keys, text, "objects/ab/cd");
    expect(sealed.length).toBeLessThan(text.length);
    expect(new TextDecoder().decode(await open(keys, sealed, "objects/ab/cd"))).toBe("岗位 JD ".repeat(500));
    await expect(open(keys, sealed, "objects/ab/ce")).rejects.toMatchObject({ code: "decrypt" });
    const tampered = sealed.slice();
    tampered[tampered.length - 1] ^= 1;
    await expect(open(keys, tampered, "objects/ab/cd")).rejects.toBeInstanceOf(SyncError);
  });

  it("keyed content ids are stable per key and differ across passphrases", async () => {
    const kdf = newKdfParams(1000);
    const a = await deriveKeys("one", kdf);
    const a2 = await deriveKeys("one", kdf);
    const b = await deriveKeys("two", kdf);
    const data = utf8("same plaintext");
    expect(await contentId(a, data)).toBe(await contentId(a2, data));
    expect(await contentId(a, data)).not.toBe(await contentId(b, data));
  });
});

describe("chunker", () => {
  const params = { min: 2048, avg: 8192, max: 32768 };

  it("cuts deterministically and an append only touches the tail", () => {
    const data = randomBytes(200_000);
    const parts = chunk(data, params);
    expect(parts.length).toBeGreaterThan(5);
    expect(parts.reduce((sum, part) => sum + part.length, 0)).toBe(data.length);
    expect(parts.every((part) => part.length <= params.max)).toBe(true);
    const grown = new Uint8Array(data.length + 100);
    grown.set(data);
    const after = chunk(grown, params);
    const same = after.filter((part, i) => parts[i] && part.length === parts[i].length).length;
    expect(same).toBeGreaterThanOrEqual(parts.length - 1);
  });
});
