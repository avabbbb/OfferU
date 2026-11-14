import { nowIso, todayIso } from "../labels";
import type { CoreContext, CoreStore, StoredRecord } from "../types";
import { CoreError } from "../types";

export const USER_ACTOR = "你";

export type Args = Record<string, unknown>;

export function userContext(actor = USER_ACTOR): CoreContext {
  return { actor, now: nowIso(), today: todayIso() };
}

export const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export const charLength = (value: string): number => [...value].length;

/** Pydantic-style string field: type, max length (code points), optional required. */
export function stringField(args: Args, name: string, options: { max?: number; min?: number; fallback?: string; required?: boolean } = {}): string {
  const value = args[name];
  if (value === undefined || value === null) {
    if (options.required) throw new CoreError(`${name} 不能为空`);
    return options.fallback ?? "";
  }
  if (typeof value !== "string") throw new CoreError(`${name} 必须是字符串`);
  if (options.max !== undefined && charLength(value) > options.max) throw new CoreError(`${name} 最长 ${options.max} 个字符`);
  if (options.min !== undefined && charLength(value) < options.min) throw new CoreError(`${name} 至少 ${options.min} 个字符`);
  return value;
}

export function optionalPositiveInt(args: Args, name: string): number | null {
  const value = args[name];
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) throw new CoreError(`${name} 必须是正整数`);
  return value;
}

export function onlyKeys(args: Args, allowed: string[]): void {
  const extra = Object.keys(args).filter((key) => !allowed.includes(key));
  if (extra.length) throw new CoreError(`不支持的字段: ${extra.join(", ")}`);
}

/** Docs of one kind carrying a `topic` marker (interview data reuses doc kinds; see migration notes). */
export async function topicDocs(store: CoreStore, kind: string, topic: string): Promise<StoredRecord[]> {
  return (await store.all("doc")).filter((doc) => doc.kind === kind && doc.topic === topic);
}
