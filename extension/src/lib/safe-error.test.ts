import { describe, expect, it } from "vitest";
import { safeExtensionDebugPayload, safeExtensionError } from "./safe-error.js";

describe("safeExtensionError", () => {
  it("redacts credentials, PII, and local endpoint details", () => {
    const value = safeExtensionError(
      new Error(
        "POST http://127.0.0.1:8080/api failed api_key=sk-test-1234567890 user=ava@example.com phone=13812345678",
      ),
    );

    expect(value).not.toContain("8080");
    expect(value).not.toContain("sk-test-1234567890");
    expect(value).not.toContain("ava@example.com");
    expect(value).not.toContain("13812345678");
    expect(value).toContain("[local endpoint]");
    expect(value).toContain("[redacted]");
    expect(value).toContain("[email]");
    expect(value).toContain("[phone]");
  });

  it("bounds unknown and empty errors", () => {
    expect(safeExtensionError({})).toBe("操作失败");
    expect(safeExtensionError(new Error("x".repeat(500)))).toHaveLength(240);
  });

  it("keeps only safe telemetry in debug payloads", () => {
    expect(safeExtensionDebugPayload({ filledCount: 2, value: "private resume text" })).toEqual({
      filledCount: 2,
      value: "[redacted]",
    });
  });
});
