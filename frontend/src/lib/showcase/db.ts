// =============================================
// Showcase 本地数据层 — 纯前端可运行的 OfferU
// =============================================
// VITE_SHOWCASE=true 构建时启用：所有 API 请求由本地 IndexedDB
// （localforage）承载，增删改查真实持久化，不依赖 Python 后端。
// 该模式服务于静态展示站（CF Pages / GitHub Pages）。

import localforage from "localforage";

export const SHOWCASE = process.env.VITE_SHOWCASE === "true";

export const SHOWCASE_DB_NAME = "offeru-showcase";

const db = localforage.createInstance({
  name: SHOWCASE_DB_NAME,
  storeName: "tables",
});

export type TableName =
  | "jobs"
  | "pools"
  | "profile"
  | "resumes"
  | "workspace"
  | "calendar_events"
  | "progress_candidates"
  | "agent_runs";

export async function readTable<T>(name: TableName, fallback: T): Promise<T> {
  const value = await db.getItem<T>(name);
  return value ?? fallback;
}

export async function writeTable<T>(name: TableName, value: T): Promise<void> {
  await db.setItem(name, value);
}

export async function clearAll(): Promise<void> {
  await db.clear();
}
