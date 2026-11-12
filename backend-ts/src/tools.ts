import {
  changesView,
  deleteRecord,
  getRecord,
  listRecords,
  nowIso,
  overview,
  saveRecord,
  searchRecords,
  todayIso,
  undoChange,
} from "@offeru/core";
import type { CoreContext, CoreStore } from "@offeru/core";

import { SqliteCoreStore } from "./store";

export const SUPPORTED_TOOLS = [
  "overview",
  "list",
  "get",
  "save",
  "delete",
  "undo",
  "changes",
  "search",
] as const;

type Args = Record<string, unknown>;

function context(actor: string): CoreContext {
  return { actor, now: nowIso(), today: todayIso() };
}

function argsOf(value: unknown): Args {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Args : {};
}

/** The shared core behind HTTP, CLI, and (later) MCP. No route logic lives here. */
export function callTool(name: string, rawArgs: unknown, store: CoreStore, actor = "你"): unknown {
  const args = argsOf(rawArgs);
  const ctx = context(actor);
  switch (name) {
    case "overview": return overview(store, ctx);
    case "list": return listRecords(store, args);
    case "get": return getRecord(store, args);
    case "save": return saveRecord(store, args, ctx);
    case "delete": return deleteRecord(store, args, ctx);
    case "undo": return undoChange(store, args, ctx);
    case "changes": return changesView(store, typeof args.limit === "number" ? args.limit : 20);
    case "search": return searchRecords(store, args);
    default:
      throw new Error(`TS backend 暂不支持工具「${name}」；当前支持：${SUPPORTED_TOOLS.join(", ")}`);
  }
}

export function openStore(path: string): SqliteCoreStore {
  return new SqliteCoreStore(path);
}
