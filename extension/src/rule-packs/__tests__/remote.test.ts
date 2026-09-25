import { describe, it, expect, beforeEach, vi } from "vitest";
import { fetchRemoteRulePacks } from "../remote.js";
import { SiteRuleRegistry } from "../registry.js";
import bossPack from "../packs/portal.boss-job-detail.json";
import signedBundle from "../fixtures/remote-bundle.json";

// 固定的已签名测试 fixture 覆盖 canonicalize 与真实公钥验签；测试不依赖构建输出。
const realBundle = signedBundle as {
  schemaVersion: string;
  bundleVersion: number;
  packages: Record<string, unknown>[];
  signature: string;
};

const memStore: Record<string, unknown> = {};

beforeEach(() => {
  for (const key of Object.keys(memStore)) delete memStore[key];
  memStore["offeru_remote_rule_version_v1"] = 0;
  memStore["offeru_remote_rule_fuse_v1"] = 0;
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        async get(key: string) {
          return { [key]: memStore[key] ?? 0 };
        },
        async set(items: Record<string, unknown>) {
          for (const [k, v] of Object.entries(items)) memStore[k] = v;
        },
      },
    },
  });
});

function registryWithBuiltin(): SiteRuleRegistry {
  const registry = new SiteRuleRegistry();
  registry.loadPacks([bossPack]);
  return registry;
}

describe("fetchRemoteRulePacks (ADR-0050)", () => {
  it("applies a valid signed bundle and merges built-in pack", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        async json() {
          return realBundle;
        },
      })),
    );
    const registry = registryWithBuiltin();
    const summary = await fetchRemoteRulePacks(registry);
    expect(summary.applied).toBe(true);
    expect(summary.bundleVersion).toBe(realBundle.bundleVersion);
    expect(summary.loadedPackIds).toContain(bossPack.id);
    expect(summary.reason).toBeUndefined();
  });

  it("rejects tampered package content (signature mismatch)", async () => {
    const tampered = structuredClone(realBundle);
    tampered.packages[0].version = "9.9.9-tampered";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        async json() {
          return tampered;
        },
      })),
    );
    const summary = await fetchRemoteRulePacks(registryWithBuiltin());
    expect(summary.applied).toBe(false);
    expect(summary.reason).toBe("signature_mismatch");
  });

  it("skips when bundle version is not newer (anti-replay)", async () => {
    memStore["offeru_remote_rule_version_v1"] = realBundle.bundleVersion;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        async json() {
          return realBundle;
        },
      })),
    );
    const summary = await fetchRemoteRulePacks(registryWithBuiltin());
    expect(summary.applied).toBe(false);
    expect(summary.reason).toBe("version_not_newer");
  });

  it("opens circuit after consecutive failures", async () => {
    memStore["offeru_remote_rule_fuse_v1"] = 3;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("should not be called");
      }),
    );
    const summary = await fetchRemoteRulePacks(registryWithBuiltin());
    expect(summary.reason).toBe("circuit_open");
    expect(summary.applied).toBe(false);
  });

  it("falls back silently on network failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const summary = await fetchRemoteRulePacks(registryWithBuiltin());
    expect(summary.applied).toBe(false);
    expect(summary.reason).toContain("fetch failed");
  });
});
