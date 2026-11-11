import { describe, expect, it } from "vitest";

import { buildDemoPackage, parseDemoPackage } from "./package";
import { buildDemoState } from "./seed";

describe("demo data package", () => {
  it("round-trips records and changes without agent secrets", () => {
    const state = buildDemoState();
    const pkg = buildDemoPackage(state, new Date("2026-11-11T12:00:00Z"));
    const parsed = parseDemoPackage(JSON.stringify(pkg));
    expect(parsed.exported_at).toBe("2026-11-11T12:00:00.000Z");
    expect(parsed.data.records).toHaveLength(state.records.length);
    expect(parsed.data.changes).toEqual([]);
    expect(JSON.stringify(parsed)).not.toContain("apiKey");
  });

  it("rejects a foreign or truncated file", () => {
    expect(() => parseDemoPackage("{}")).toThrow(/不是 OfferU/);
    expect(() => parseDemoPackage({ app: "offeru", format: "offeru.demo-package", version: 1, scope: "demo-core", data: {} })).toThrow(/不完整/);
  });
});
