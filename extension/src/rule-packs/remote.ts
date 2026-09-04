// =============================================
// 远程规则包拉取与验签（ADR-0050）
// =============================================
// 从 CF Pages 拉取签名 bundle：ECDSA P-256 验签 → schema 校验 →
// 版本递增才应用 → 熔断回滚。拉取/验签失败一律静默回退内置规则。

import type { SiteRuleRegistry } from "./registry.js";
import { validatePack } from "./validator.js";
import { safeExtensionError } from "../lib/safe-error.js";

export const REMOTE_RULE_BUNDLE_URL =
  "https://offeru-rule-packs.pages.dev/bundle.json";

// 发布者公钥（由 scripts/sign-rule-pack.mjs 首次运行生成，
// 灵机一动换钥时同步更新；私钥只存发布者本机）
const BUNDLE_PUBLIC_KEY_JWK: JsonWebKey = {
  kty: "EC",
  x: "_tvh4XAFL3Z5KYBTxZ-2Oejf6Jgtdg3Uq_A-N2Nd13k",
  y: "75HjPlZ7KIhfjQKCTzBKGyvPQ1P9o1DiUVWwtO906Cc",
  crv: "P-256",
};

const VERSION_CACHE_KEY = "offeru_remote_rule_version_v1";
const FUSE_CACHE_KEY = "offeru_remote_rule_fuse_v1";
const FUSE_MAX_FAILURES = 3;
const FETCH_TIMEOUT_MS = 10_000;

export interface RemoteRuleLoadSummary {
  tried: boolean;
  applied: boolean;
  reason?: string;
  bundleVersion?: number;
  loadedPackIds: string[];
  rejectedPackIds: string[];
}

function packIdOf(value: unknown): string {
  return value && typeof value === "object" && "id" in value && typeof value.id === "string"
    ? value.id
    : "(unknown)";
}

/** 规范化 JSON（递归键排序）——必须与 scripts/sign-rule-pack.mjs 一致 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${canonicalize(record[k])}`)
    .join(",")}}`;
}

function base64urlToBytes(input: string): Uint8Array<ArrayBuffer> {
  const binary = atob(input.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function verifySignature(
  payloadBytes: Uint8Array<ArrayBuffer>,
  signature: string,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      BUNDLE_PUBLIC_KEY_JWK,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      base64urlToBytes(signature),
      payloadBytes,
    );
  } catch {
    return false;
  }
}

async function readCacheKey(key: string): Promise<number> {
  try {
    const stored = await chrome.storage.local.get(key);
    return Number(stored[key] || 0);
  } catch {
    return 0;
  }
}

async function writeCacheKey(key: string, value: number): Promise<void> {
  try {
    await chrome.storage.local.set({ [key]: value });
  } catch {
    // 存储不可用时忽略：不影响本次加载
  }
}

/**
 * 拉取并应用远程规则包。
 * - 熔断：连续 3 次失败后跳过（避免每个页面重复请求坏源）；
 * - 验签失败/版本不增 → 不应用，用内置规则；
 * - 单个包 schema 校验失败不影响其他包。
 */
export async function fetchRemoteRulePacks(
  registry: SiteRuleRegistry,
): Promise<RemoteRuleLoadSummary> {
  const summary: RemoteRuleLoadSummary = {
    tried: true,
    applied: false,
    loadedPackIds: [],
    rejectedPackIds: [],
  };
  try {
    const fuse = await readCacheKey(FUSE_CACHE_KEY);
    if (fuse >= FUSE_MAX_FAILURES) {
      summary.reason = "circuit_open";
      return summary;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(REMOTE_RULE_BUNDLE_URL, {
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      summary.reason = `http_${response.status}`;
      await writeCacheKey(FUSE_CACHE_KEY, fuse + 1);
      return summary;
    }
    const bundle = (await response.json()) as {
      schemaVersion?: string;
      bundleVersion?: number;
      packages?: unknown[];
      signature?: string;
    };
    if (!bundle.signature || !Array.isArray(bundle.packages)) {
      summary.reason = "malformed_bundle";
      await writeCacheKey(FUSE_CACHE_KEY, fuse + 1);
      return summary;
    }

    // 验签：覆盖除 signature 外的全部字段的规范化字节
    const payload = {
      schemaVersion: bundle.schemaVersion,
      bundleVersion: bundle.bundleVersion,
      packages: bundle.packages,
    };
    const encoded = new TextEncoder().encode(canonicalize(payload));
    // TS 5.5 lib 对 TextEncoder 返回 Uint8Array<ArrayBufferLike>；
    // 复制到独立 ArrayBuffer 以满足 crypto.subtle 的 BufferSource 约束。
    const payloadBytes = new Uint8Array(new ArrayBuffer(encoded.byteLength)) as Uint8Array<ArrayBuffer>;
    payloadBytes.set(encoded);
    const valid = await verifySignature(payloadBytes, bundle.signature);
    if (!valid) {
      summary.reason = "signature_mismatch";
      await writeCacheKey(FUSE_CACHE_KEY, fuse + 1);
      return summary;
    }

    // 版本递增检查（防重放与回退）
    const appliedVersion = await readCacheKey(VERSION_CACHE_KEY);
    const newVersion = Number(bundle.bundleVersion || 0);
    if (newVersion <= appliedVersion) {
      summary.reason = "version_not_newer";
      return summary;
    }

    // schema 校验：逐包加载，坏包不阻断好包
    const accepted: unknown[] = [];
    for (const pack of bundle.packages) {
      const result = validatePack(pack);
      if (result.ok) {
        accepted.push(result.pack);
        summary.loadedPackIds.push(packIdOf(result.pack));
      } else {
        summary.rejectedPackIds.push(
          `${packIdOf(pack)}(${result.errors[0]?.code || "invalid"})`,
        );
      }
    }
    if (accepted.length > 0) {
      registry.loadPacks(accepted);
      summary.applied = true;
      summary.bundleVersion = newVersion;
      await writeCacheKey(VERSION_CACHE_KEY, newVersion);
      await writeCacheKey(FUSE_CACHE_KEY, 0);
    } else {
      summary.reason = "no_valid_packs";
      await writeCacheKey(FUSE_CACHE_KEY, fuse + 1);
    }
    return summary;
  } catch (error) {
    summary.reason = safeExtensionError(error, "远程规则包暂不可用");
    return summary;
  }
}
