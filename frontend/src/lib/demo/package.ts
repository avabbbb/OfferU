import type { DemoState } from "./seed";

export const DEMO_PACKAGE_FORMAT = "offeru.demo-package";
export const DEMO_PACKAGE_VERSION = 1;

export type DemoPackage = {
  app: "offeru";
  format: typeof DEMO_PACKAGE_FORMAT;
  version: typeof DEMO_PACKAGE_VERSION;
  scope: "demo-core";
  exported_at: string;
  data: DemoState;
};

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export function buildDemoPackage(state: DemoState, now = new Date()): DemoPackage {
  return {
    app: "offeru",
    format: DEMO_PACKAGE_FORMAT,
    version: DEMO_PACKAGE_VERSION,
    scope: "demo-core",
    exported_at: now.toISOString(),
    data: clone(state),
  };
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> // JSON boundary; fields are checked below
    : null;
}

export function parseDemoPackage(raw: unknown): DemoPackage {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error("数据包不是有效 JSON。");
    }
  }
  const pkg = recordOf(value);
  if (!pkg || pkg.app !== "offeru" || pkg.format !== DEMO_PACKAGE_FORMAT) {
    throw new Error("这不是 OfferU 演示数据包。");
  }
  if (pkg.version !== DEMO_PACKAGE_VERSION) {
    throw new Error("数据包版本不支持，请先更新页面。");
  }
  if (pkg.scope !== "demo-core") {
    throw new Error("数据包范围不支持。");
  }
  const data = recordOf(pkg.data);
  if (!data || data.version !== 1 || !Array.isArray(data.records) || !Array.isArray(data.changes)
    || typeof data.nextRecordId !== "number" || typeof data.nextChangeId !== "number") {
    throw new Error("数据包内容不完整或已损坏。");
  }
  for (const record of data.records) {
    const item = recordOf(record);
    if (!item || typeof item.id !== "number" || typeof item.type !== "string" || typeof item.updated_at !== "string") {
      throw new Error("数据包里有格式不对的记录。");
    }
  }
  for (const change of data.changes) {
    const item = recordOf(change);
    if (!item || typeof item.id !== "number" || typeof item.at !== "string") {
      throw new Error("数据包里有格式不对的改动。");
    }
  }
  return clone(value as DemoPackage);
}

export function packageFilename(now = new Date()): string {
  const stamp = now.toISOString().slice(0, 16).replace(/[-:T]/g, "");
  return `offeru-demo-${stamp}.json`;
}

export function downloadJson(filename: string, payload: unknown): void {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
