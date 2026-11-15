import { describe, expect, it } from "vitest";
import type { Diagnosis } from "@offeru/sync";

import {
  EMPTY_SYNC_FORM,
  canAdvance,
  corsPolicy,
  decodeLinkCode,
  describeSyncError,
  encodeLinkCode,
  initialWizard,
  needsCorsHelp,
  progressLine,
  r2FromInput,
  wizardReducer,
  type WizardAction,
  type WizardState,
} from "./syncWizard";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const run = (state: WizardState, ...actions: WizardAction[]) => actions.reduce(wizardReducer, state);
const passed: Diagnosis = { ok: true, checks: [{ id: "network", status: "ok", detail: "" }], repo: "empty", passphrase: "unchecked", skewMs: 0 };

describe("sync wizard", () => {
  it("R2 path: provider preset, account id -> endpoint, keys, test gate, passphrase confirm", () => {
    let state = initialWizard();
    expect(state.step).toBe("provider");
    state = run(state, { type: "provider", provider: "r2" }, { type: "next" });
    expect(state.step).toBe("bucket");
    expect(state.form).toMatchObject({ region: "auto", pathStyle: true });
    expect(canAdvance(state)).toEqual({ ok: false, reason: "填存储桶名称" });

    state = run(state, { type: "account", value: ACCOUNT }, { type: "field", key: "bucket", value: "offeru" });
    expect(state.form.endpoint).toBe(`https://${ACCOUNT}.r2.cloudflarestorage.com`);
    state = run(state, { type: "next" });
    expect(state.step).toBe("keys");
    expect(run(state, { type: "next" }).step).toBe("keys"); // blocked without keys
    state = run(state, { type: "field", key: "accessKeyId", value: "AKID" }, { type: "field", key: "secretAccessKey", value: "SECRET" }, { type: "next" });
    expect(state.step).toBe("test");
    expect(canAdvance(state).reason).toBe("先测试连接");

    state = run(state, { type: "tested", diagnosis: { ...passed, ok: false } });
    expect(canAdvance(state).reason).toBe("先解决标红的一项");
    state = run(state, { type: "tested", diagnosis: passed }, { type: "next" });
    expect(state.step).toBe("passphrase");
    state = run(state, { type: "field", key: "passphrase", value: "long enough pass" });
    expect(canAdvance(state).reason).toBe("两次输入的口令不一致");
    state = run(state, { type: "confirm", value: "long enough pass" });
    expect(canAdvance(state).ok).toBe(true);
    // the passphrase does not invalidate the test, connection fields do
    expect(state.diagnosis).not.toBeNull();
    expect(run(state, { type: "field", key: "bucket", value: "other" }).diagnosis).toBeNull();
  });

  it("existing repo needs no confirmation; AWS needs no endpoint; back walks one step", () => {
    let state = run(initialWizard(), { type: "provider", provider: "s3" });
    expect(state.form).toMatchObject({ endpoint: "", pathStyle: false, region: "us-east-1" });
    state = run(state, { type: "next" }, { type: "field", key: "bucket", value: "b" });
    expect(canAdvance(state).ok).toBe(true);
    state = { ...state, step: "passphrase", diagnosis: { ...passed, repo: "existing" } };
    state = run(state, { type: "field", key: "passphrase", value: "the first device pass" });
    expect(canAdvance(state).ok).toBe(true);
    expect(run(state, { type: "back" }).step).toBe("test");
  });

  it("editing a saved setup starts at the bucket step and allows blank secrets", () => {
    const state = initialWizard({ ...EMPTY_SYNC_FORM, bucket: "b", endpoint: "https://e.example", accessKeyId: "AKID••••" });
    expect(state).toMatchObject({ step: "bucket", editing: true });
    expect(state.form.accessKeyId).toBe("");
    expect(canAdvance({ ...state, step: "keys" }).ok).toBe(true);
    expect(canAdvance({ ...state, step: "passphrase" }).ok).toBe(true);
  });

  it("R2 helper accepts an account id or the dashboard S3 API url", () => {
    expect(r2FromInput(ACCOUNT.toUpperCase())?.endpoint).toBe(`https://${ACCOUNT}.r2.cloudflarestorage.com`);
    expect(r2FromInput(`https://${ACCOUNT}.eu.r2.cloudflarestorage.com/my-bucket`)).toEqual({
      accountId: ACCOUNT, endpoint: `https://${ACCOUNT}.eu.r2.cloudflarestorage.com`, bucket: "my-bucket",
    });
    expect(r2FromInput("not an id")).toBeNull();
    expect(r2FromInput("https://example.com")).toBeNull();
  });

  it("link code carries only non-secret settings and roundtrips into the wizard", () => {
    const form = { ...EMPTY_SYNC_FORM, endpoint: `https://${ACCOUNT}.r2.cloudflarestorage.com`, bucket: "我的桶", accessKeyId: "AKIDSECRET", secretAccessKey: "SUPERSECRET", passphrase: "my passphrase" };
    const code = encodeLinkCode(form);
    expect(code.startsWith("offeru-sync:")).toBe(true);
    const decoded = new TextDecoder().decode(Uint8Array.from(atob(code.slice("offeru-sync:".length).replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)));
    for (const secret of ["AKIDSECRET", "SUPERSECRET", "my passphrase"]) {
      expect(code).not.toContain(secret);
      expect(decoded).not.toContain(secret);
    }
    expect(decodeLinkCode(code)).toEqual({ provider: "r2", endpoint: form.endpoint, bucket: "我的桶", region: "auto", prefix: "offeru", pathStyle: true });
    const state = run(initialWizard(), { type: "link", code: `  ${code} ` });
    expect(state.step).toBe("keys");
    expect(state.form.bucket).toBe("我的桶");
    expect(() => decodeLinkCode("hello")).toThrow("offeru-sync:");
    expect(() => decodeLinkCode("offeru-sync:@@@")).toThrow("不完整");
  });

  it("CORS JSON allows the current origin, the S3 headers and exposes ETag", () => {
    const [rule] = JSON.parse(corsPolicy(["https://offeru.avabbbb.com/", "https://offeru.avabbbb.com"]));
    expect(rule.AllowedOrigins).toEqual(["https://offeru.avabbbb.com"]);
    expect(rule.AllowedMethods).toEqual(["GET", "PUT", "HEAD", "DELETE"]);
    expect(rule.AllowedHeaders).toEqual(expect.arrayContaining(["authorization", "if-match", "if-none-match", "x-amz-content-sha256"]));
    expect(rule.ExposeHeaders).toEqual(["ETag"]);
    expect(needsCorsHelp({ ...passed, checks: [{ id: "cors", status: "fail", detail: "" }] })).toBe(true);
    expect(needsCorsHelp({ ...passed, checks: [{ id: "write", status: "fail", detail: "", code: "etag_hidden" }] })).toBe(true);
    expect(needsCorsHelp(passed)).toBe(false);
  });

  it("error codes map to Chinese titles and fixes", () => {
    expect(describeSyncError("sync_auth", "存储桶拒绝访问（403）")).toMatchObject({ title: "存储桶拒绝访问", detail: "存储桶拒绝访问（403）" });
    expect(describeSyncError("sync_network", "x").hint).toContain("CORS");
    expect(describeSyncError("sync_passphrase", "x").title).toBe("同步口令不对");
    expect(describeSyncError(undefined, "x").title).toBe("同步失败");
  });

  it("progress line counts objects and bytes, skipped included", () => {
    expect(progressLine(null)).toEqual({ text: "", ratio: null });
    const base = { download: { done: 0, total: 0, bytes: 0 }, upload: { done: 0, total: 0, bytes: 0, skipped: 0 } };
    expect(progressLine({ ...base, phase: "upload", upload: { done: 3, total: 10, bytes: 2048, skipped: 2 } })).toEqual({
      text: "上传 5 / 10 个加密对象 · 2.0 KB（2 个已在桶里，跳过）", ratio: 0.5,
    });
    expect(progressLine({ ...base, phase: "download", download: { done: 1, total: 4, bytes: 10 } }).ratio).toBe(0.25);
    expect(progressLine({ ...base, phase: "merge" }).ratio).toBeNull();
  });
});
