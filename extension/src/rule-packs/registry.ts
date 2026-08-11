// =============================================
// SiteRuleRegistry：加载、校验、不可变与版本哈希
// 同一个 id+version 的内容必须不可变；发现同版本不同内容就失败。
// =============================================

import type { SiteRulePackV1 } from "./contracts.js";
import { validatePack, type ValidationError } from "./validator.js";

export interface PackLoadFailure {
  packId: string | null;
  errors: ValidationError[];
}

export interface LoadSummary {
  loaded: SiteRulePackV1[];
  failures: PackLoadFailure[];
  /** 校验通过但标记为 disabled 的 pack */
  disabled: SiteRulePackV1[];
}

/** FNV-1a 32 位字符串哈希（同步、无依赖，用于内容指纹） */
export function contentHash(json: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    hash ^= json.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export class SiteRuleRegistry {
  private readonly byId = new Map<string, SiteRulePackV1>();
  private readonly versionHashes = new Map<string, string>();

  /** 校验并注册一个 pack；返回错误列表（空 = 成功） */
  add(input: unknown): ValidationError[] {
    const result = validatePack(input);
    if (!result.ok) {
      const id = extractId(input);
      return result.errors;
    }
    const pack = result.pack;
    const canonical = JSON.stringify(pack);
    const hash = contentHash(canonical);
    const key = `${pack.id}@${pack.version}`;
    const existing = this.versionHashes.get(key);
    if (existing !== undefined && existing !== hash) {
      return [{ path: "$.version", code: "immutable-version-violation", message: `same id+version with different content is rejected (${pack.id}@${pack.version})` }];
    }
    if (existing === hash) return [];
    if (this.byId.has(pack.id)) {
      return [{ path: "$.id", code: "duplicate-pack-id", message: `pack id "${pack.id}" is already registered` }];
    }
    this.versionHashes.set(key, hash);
    this.byId.set(pack.id, deepFreeze(pack));
    return [];
  }

  /** 批量注册；单条失败不影响其他条目 */
  loadPacks(packs: unknown[]): LoadSummary {
    const loaded: SiteRulePackV1[] = [];
    const failures: PackLoadFailure[] = [];
    const disabled: SiteRulePackV1[] = [];
    for (const input of packs) {
      const errors = this.add(input);
      if (errors.length > 0) {
        failures.push({ packId: extractId(input), errors });
      } else {
        const pack = input as SiteRulePackV1;
        if (pack.status === "disabled") disabled.push(pack);
        else loaded.push(pack);
      }
    }
    return { loaded, failures, disabled };
  }

  get(id: string): SiteRulePackV1 | undefined {
    return this.byId.get(id);
  }

  all(): SiteRulePackV1[] {
    return [...this.byId.values()];
  }

  /** 与构建/加载时相同的内容指纹 */
  hashOf(id: string, version: string): string | undefined {
    return this.versionHashes.get(`${id}@${version}`);
  }
}

function extractId(input: unknown): string | null {
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    const id = (input as Record<string, unknown>).id;
    return typeof id === "string" && id.length > 0 ? id : null;
  }
  return null;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}
