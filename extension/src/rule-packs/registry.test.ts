// =============================================
// registry 测试：重复 id、内容不可变、disabled、深冻结
// =============================================

import { describe, expect, it } from "vitest";
import { SiteRuleRegistry, contentHash } from "./registry.js";
import { validatePack } from "./validator.js";
import jobDetailPack from "./packs/fixture.acme-job-detail.json";
import applicationFormPack from "./packs/fixture.acme-application-form.json";

function clone<T>(value: T): T {
  return structuredClone(value);
}

describe("SiteRuleRegistry", () => {
  it("loads the two synthetic packs", () => {
    const registry = new SiteRuleRegistry();
    const summary = registry.loadPacks([clone(jobDetailPack), clone(applicationFormPack)]);
    expect(summary.failures).toEqual([]);
    expect(summary.loaded.map((p) => p.id).sort()).toEqual([
      "fixture.acme-application-form",
      "fixture.acme-job-detail",
    ]);
    expect(registry.get("fixture.acme-job-detail")).toBeDefined();
  });

  it("rejects duplicate pack ids", () => {
    const registry = new SiteRuleRegistry();
    registry.add(clone(jobDetailPack));
    const duplicateId = clone(jobDetailPack);
    duplicateId.version = "0.1.1";
    const errors = registry.add(duplicateId);
    expect(errors.map((e) => e.code)).toContain("duplicate-pack-id");
  });

  it("rejects same id+version with different content", () => {
    const registry = new SiteRuleRegistry();
    registry.add(clone(jobDetailPack));
    const modified = clone(jobDetailPack);
    modified.displayName = "changed content under same version";
    const errors = registry.add(modified);
    expect(errors.map((e) => e.code)).toContain("immutable-version-violation");
  });

  it("accepts same id+version with identical content (idempotent)", () => {
    const registry = new SiteRuleRegistry();
    expect(registry.add(clone(jobDetailPack))).toEqual([]);
    expect(registry.add(clone(jobDetailPack))).toEqual([]);
  });

  it("separates disabled packs from loadable ones", () => {
    const disabled = clone(applicationFormPack);
    disabled.status = "disabled";
    const registry = new SiteRuleRegistry();
    const summary = registry.loadPacks([clone(jobDetailPack), disabled]);
    expect(summary.loaded.map((p) => p.id)).toEqual(["fixture.acme-job-detail"]);
    expect(summary.disabled.map((p) => p.id)).toEqual(["fixture.acme-application-form"]);
  });

  it("deep-freezes registered packs", () => {
    const registry = new SiteRuleRegistry();
    registry.add(clone(jobDetailPack));
    const pack = registry.get("fixture.acme-job-detail")!;
    expect(Object.isFrozen(pack)).toBe(true);
    expect(Object.isFrozen(pack.pages[0])).toBe(true);
    expect(Object.isFrozen(pack.pages[0].match.signals[0])).toBe(true);
  });

  it("reports per-pack validation failures in loadPacks", () => {
    const registry = new SiteRuleRegistry();
    const bad = clone(jobDetailPack);
    (bad as Record<string, unknown>).script = "evil";
    const summary = registry.loadPacks([bad, clone(applicationFormPack)]);
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0].packId).toBe("fixture.acme-job-detail");
    expect(summary.loaded.map((p) => p.id)).toEqual(["fixture.acme-application-form"]);
  });
});

describe("contentHash", () => {
  it("is stable for identical input and different for changed input", () => {
    expect(contentHash('{"a":1}')).toBe(contentHash('{"a":1}'));
    expect(contentHash('{"a":1}')).not.toBe(contentHash('{"a":2}'));
  });

  it("matches validator acceptance of the fixture packs", () => {
    expect(validatePack(clone(jobDetailPack)).ok).toBe(true);
  });
});
