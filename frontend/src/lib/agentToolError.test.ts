import { describe, expect, it } from "vitest";
import { isToolFailure, parseToolError, plainToolErrorText } from "./agentToolError";

const failure = {
  ok: false,
  error: { code: "invalid_args", message: "缺少 job_id", retryable: true, suggestedAction: "先查一下岗位列表" },
};

describe("parseToolError", () => {
  it("reads a direct failure object", () => {
    const view = parseToolError(failure);
    expect(view).toEqual({
      code: "invalid_args",
      codeLabel: "参数不对",
      message: "缺少 job_id",
      suggestedAction: "先查一下岗位列表",
      retryable: true,
      needsUser: false,
    });
  });

  it("reads a JSON string, details, and content[0].text", () => {
    expect(parseToolError(JSON.stringify(failure))?.code).toBe("invalid_args");
    expect(parseToolError({ details: failure })?.message).toBe("缺少 job_id");
    expect(parseToolError({ content: [{ type: "text", text: JSON.stringify(failure) }] })?.retryable).toBe(true);
  });

  it("marks read_only / forbidden / unsupported as needing the user", () => {
    for (const code of ["read_only", "forbidden", "unsupported"]) {
      expect(parseToolError({ ok: false, error: { code, message: "x" } })?.needsUser).toBe(true);
    }
    expect(parseToolError({ ok: false, error: { code: "not_found", message: "x" } })?.needsUser).toBe(false);
  });

  it("keeps unknown codes as-is, defaults missing code to internal, accepts suggested_action", () => {
    expect(parseToolError({ ok: false, error: { code: "weird", message: "m" } })?.codeLabel).toBe("weird");
    const view = parseToolError({ ok: false, error: { message: "m", suggested_action: "重试" } });
    expect(view?.code).toBe("internal");
    expect(view?.codeLabel).toBe("内部错误");
    expect(view?.suggestedAction).toBe("重试");
    expect(view?.retryable).toBe(false);
  });

  it("returns null for successes and unrecognised shapes", () => {
    expect(parseToolError({ ok: true, data: 1 })).toBeNull();
    expect(parseToolError({ ok: false, error: { code: "x" } })).toBeNull();
    expect(parseToolError("ERROR: boom")).toBeNull();
    expect(parseToolError("{not json")).toBeNull();
    expect(parseToolError(null)).toBeNull();
    expect(parseToolError([failure])).toBeNull();
  });
});

describe("plainToolErrorText", () => {
  it("strips the ERROR: prefix from strings and content text", () => {
    expect(plainToolErrorText("ERROR: 网络超时")).toBe("网络超时");
    expect(plainToolErrorText({ content: [{ text: "ERROR: 没有权限" }] })).toBe("没有权限");
  });

  it("never shows raw JSON and falls back to a generic line", () => {
    expect(plainToolErrorText('{"ok":false}')).toBe("工具执行失败");
    expect(plainToolErrorText({ ok: false })).toBe("工具执行失败");
    expect(plainToolErrorText("")).toBe("工具执行失败");
  });

  it("truncates long text to 200 chars", () => {
    const text = plainToolErrorText("a".repeat(500));
    expect(text).toHaveLength(200);
    expect(text.endsWith("…")).toBe(true);
  });
});

describe("isToolFailure", () => {
  it("detects structured, flagged and ERROR: failures", () => {
    expect(isToolFailure(failure)).toBe(true);
    expect(isToolFailure({ ok: false })).toBe(true);
    expect(isToolFailure({ isError: true })).toBe(true);
    expect(isToolFailure("ERROR: boom")).toBe(true);
    expect(isToolFailure({ content: [{ text: "ERROR: boom" }] })).toBe(true);
  });

  it("does not flag successes", () => {
    expect(isToolFailure({ ok: true })).toBe(false);
    expect(isToolFailure("done")).toBe(false);
    expect(isToolFailure(undefined)).toBe(false);
  });
});
