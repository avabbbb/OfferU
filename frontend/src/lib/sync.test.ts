import { describe, expect, it } from "vitest";
import { corsExample, describeSyncResult } from "./sync";

describe("sync settings helpers", () => {
  it("builds R2 and S3 CORS rules that expose ETag and allow conditional writes", () => {
    const { r2, s3 } = corsExample("https://offeru.example");
    const rule = JSON.parse(r2)[0];
    expect(rule.AllowedOrigins).toEqual(["https://offeru.example"]);
    expect(rule.AllowedMethods).toEqual(expect.arrayContaining(["GET", "PUT", "DELETE"]));
    expect(rule.ExposeHeaders).toContain("ETag");
    expect(rule.AllowedHeaders).toEqual(expect.arrayContaining(["if-match", "if-none-match", "authorization"]));
    expect(JSON.parse(s3).CORSRules[0]).toEqual(rule);
  });

  it("summarizes a run", () => {
    expect(describeSyncResult({ ok: true, at: "", snapshot: null, pulled: 2, pushed: 1, uploaded_objects: 1, conflicts: [], attempts: 1 }))
      .toBe("拉取 2 项，推送 1 项");
  });
});
