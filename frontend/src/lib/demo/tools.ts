import { nowIso, todayIso } from "../domain/labels";
import {
  changesView,
  deleteRecord,
  getRecord,
  listRecords,
  overview,
  saveRecord,
  searchRecords,
  undoChange,
} from "../domain/operations";
import type { CoreContext } from "../domain/types";
import { demoStore } from "./store";

export const DEMO_TOOL_NAMES = new Set([
  "overview",
  "list",
  "get",
  "save",
  "delete",
  "undo",
  "changes",
  "search",
]);

export const DEMO_UNSUPPORTED = "演示版暂时只支持查看、编辑、删除、撤销和搜索；AI、邮箱、文件和外置 Agent 请在本机运行 OfferU。";

function context(actor: string): CoreContext {
  return { actor, now: nowIso(), today: todayIso() };
}

function argsOf(value: Record<string, unknown> | undefined): Record<string, unknown> {
  return value && typeof value === "object" ? value : {};
}

export async function demoTool<T = unknown>(name: string, rawArgs: Record<string, unknown> = {}, actor = "你"): Promise<T> {
  await demoStore.ready();
  const args = argsOf(rawArgs);
  const ctx = context(actor);
  try {
    switch (name) {
      case "overview":
        return overview(demoStore, ctx) as T;
      case "list":
        return listRecords(demoStore, args) as T;
      case "get":
        return getRecord(demoStore, args) as T;
      case "save":
        return saveRecord(demoStore, args, ctx) as T;
      case "delete":
        return deleteRecord(demoStore, args, ctx) as T;
      case "undo":
        return undoChange(demoStore, args, ctx) as T;
      case "changes":
        return changesView(demoStore, typeof args.limit === "number" ? args.limit : 20) as T;
      case "search":
        return searchRecords(demoStore, args) as T;
      default:
        throw new Error(DEMO_UNSUPPORTED);
    }
  } finally {
    await demoStore.flush();
  }
}
