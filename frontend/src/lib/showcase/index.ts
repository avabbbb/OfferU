// 展示站（VITE_SHOWCASE=true，GitHub Pages）没有 Python 后端：
// - 读：回放真实后端录下的响应（snapshot.json，由 scripts/showcase/refresh.sh 重录，接口改了重录即可，不用手写假接口）；
// - 改（PUT/PATCH）：合并进对应的读响应，存在浏览器 IndexedDB（localforage），刷新后还在；
// - 新增、删除、AI 这类必须有后端的操作：直接报错提示下载桌面版，不假装成功。
import localforage from "localforage";

export const SHOWCASE = process.env.VITE_SHOWCASE === "true";
export const SHOWCASE_UNSUPPORTED = "展示版只能浏览和修改已有内容，新增、删除和 AI 功能请下载桌面版体验。";

type Json = Record<string, unknown>;
const edits = localforage.createInstance({ name: "offeru-showcase", storeName: "edits" });
let snapshot: Promise<Record<string, unknown>> | null = null;
const loadSnapshot = () => (snapshot ??= import("./snapshot.json").then((module) => module.default as Record<string, unknown>));

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

function keyOf(path: string): string {
  const url = new URL(path, "http://showcase.local");
  return url.pathname + url.search;
}

async function read(key: string): Promise<unknown> {
  const edited = await edits.getItem(key);
  if (edited !== null) return edited;
  const recorded = await loadSnapshot();
  if (key in recorded) return recorded[key];
  // 同一个接口换了查询参数（日期范围、分页）时用录到的那份，比空白页有用。
  const pathname = key.split("?")[0];
  const sibling = Object.keys(recorded).find((candidate) => candidate.split("?")[0] === pathname);
  if (sibling) return recorded[sibling];
  throw new Error(SHOWCASE_UNSUPPORTED);
}

async function write(key: string, body: unknown): Promise<unknown> {
  const current = await read(key);
  const patch = isObject(body) ? Object.fromEntries(Object.entries(body).filter(([field]) => field !== "expected_revision")) : body;
  const next = isObject(current) && isObject(patch) ? { ...current, ...patch } : patch;
  await edits.setItem(key, next);
  // 简历编辑器读的是工作区，改简历时把工作区里那份一起改掉，刷新后才看得到。
  const resume = key.match(/^\/api\/resume\/(\d+)$/);
  if (resume) {
    const workspaceKey = `/api/resume/workspace/${resume[1]}`;
    const workspace = await read(workspaceKey).catch(() => null);
    if (isObject(workspace) && isObject(workspace.resume)) await edits.setItem(workspaceKey, { ...workspace, resume: next });
  }
  return next;
}

export async function showcaseHandle(path: string, options?: RequestInit): Promise<unknown> {
  const method = String(options?.method || "GET").toUpperCase();
  const key = keyOf(path);
  if (method === "GET") return read(key);
  if (method === "POST" && key === "/api/agent/data/demo/reset") {
    await edits.clear();
    return { reset: true, scope: "showcase_edits" };
  }
  if (method === "PUT" || method === "PATCH") {
    return write(key, typeof options?.body === "string" ? JSON.parse(options.body) : {});
  }
  throw new Error(SHOWCASE_UNSUPPORTED);
}
