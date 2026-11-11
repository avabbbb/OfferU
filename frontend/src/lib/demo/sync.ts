import localforage from "localforage";

import { buildDemoPackage, parseDemoPackage, type DemoPackage } from "./package";
import type { DemoState } from "./seed";

export type WebDavConfig = {
  url: string;
  remoteDir: string;
  username: string;
};

type StoredWebDavConfig = WebDavConfig;
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const configStore = localforage.createInstance({ name: "offeru-demo-sync", storeName: "config" });
const CONFIG_KEY = "webdav:v1";
const BACKUP_KEY = "pre-import:v1";
export const WEBDAV_FILE = "offeru-demo.json";

let memoryPassword = "";

export class WebDavError extends Error {
  constructor(public readonly code: "config" | "auth" | "network" | "http" | "payload", message: string, public readonly status?: number) {
    super(message);
    this.name = "WebDavError";
  }
}

export async function loadWebDavConfig(): Promise<WebDavConfig & { password: string }> {
  const stored = await configStore.getItem<StoredWebDavConfig>(CONFIG_KEY);
  return {
    url: stored?.url || "",
    remoteDir: stored?.remoteDir || "offeru",
    username: stored?.username || "",
    password: memoryPassword,
  };
}

export async function saveWebDavConfig(config: WebDavConfig & { password?: string }): Promise<void> {
  memoryPassword = config.password || "";
  await configStore.setItem(CONFIG_KEY, { url: config.url.trim(), remoteDir: config.remoteDir.trim() || "offeru", username: config.username });
}

function assertConfig(config: WebDavConfig): void {
  let parsed: URL;
  try {
    parsed = new URL(config.url.trim());
  } catch {
    throw new WebDavError("config", "WebDAV 地址无效。");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new WebDavError("config", "WebDAV 地址要以 http 或 https 开头。");
  }
}

export function joinWebDavUrl(base: string, ...parts: string[]): string {
  const root = base.trim().replace(/\/+$/, "");
  const path = parts
    .flatMap((part) => part.split("/"))
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return path ? `${root}/${path}` : root;
}

function basicAuth(username: string, password: string): string {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

async function davRequest(
  fetchImpl: FetchLike,
  config: WebDavConfig & { password?: string },
  method: string,
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (config.username || config.password) headers.set("Authorization", basicAuth(config.username, config.password || ""));
  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, method, headers });
  } catch (cause) {
    throw new WebDavError("network", "无法连接 WebDAV。检查网络，以及服务端是否放行 CORS、基本认证和 PROPFIND/MKCOL/PUT 方法。" + (cause instanceof Error ? ` ${cause.message}` : ""));
  }
  if (response.status === 401 || response.status === 403) {
    throw new WebDavError("auth", "WebDAV 用户名或密码错误，或没有该目录权限。", response.status);
  }
  return response;
}

function dirUrl(config: WebDavConfig): string {
  return `${joinWebDavUrl(config.url, config.remoteDir)}/`;
}

export async function testWebDav(
  config: WebDavConfig & { password?: string },
  fetchImpl: FetchLike = fetch,
): Promise<{ dirCreated: boolean }> {
  assertConfig(config);
  const dir = dirUrl(config);
  const probe = await davRequest(fetchImpl, config, "PROPFIND", dir, { headers: { Depth: "0" } });
  if (probe.status === 207 || probe.ok) return { dirCreated: false };
  if (probe.status !== 404) throw new WebDavError("http", `WebDAV 返回 ${probe.status}。`, probe.status);
  const created = await davRequest(fetchImpl, config, "MKCOL", dir);
  if (created.status === 201 || created.ok) return { dirCreated: true };
  if (created.status === 409) throw new WebDavError("http", "上级目录不存在，请先在网盘里建好。", 409);
  throw new WebDavError("http", `创建 WebDAV 目录失败：${created.status}。`, created.status);
}

export async function uploadDemoSnapshot(
  config: WebDavConfig & { password?: string },
  state: DemoState,
  fetchImpl: FetchLike = fetch,
): Promise<{ payload: DemoPackage; bytes: number }> {
  assertConfig(config);
  await testWebDav(config, fetchImpl);
  const payload = buildDemoPackage(state);
  const body = JSON.stringify(payload, null, 2);
  const response = await davRequest(fetchImpl, config, "PUT", joinWebDavUrl(config.url, config.remoteDir, WEBDAV_FILE), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body,
  });
  if (!response.ok) throw new WebDavError("http", `上传同步快照失败：${response.status}。`, response.status);
  return { payload, bytes: new TextEncoder().encode(body).byteLength };
}

export async function downloadDemoSnapshot(
  config: WebDavConfig & { password?: string },
  fetchImpl: FetchLike = fetch,
): Promise<DemoPackage | null> {
  assertConfig(config);
  const response = await davRequest(fetchImpl, config, "GET", joinWebDavUrl(config.url, config.remoteDir, WEBDAV_FILE));
  if (response.status === 404) return null;
  if (!response.ok) throw new WebDavError("http", `读取同步快照失败：${response.status}。`, response.status);
  try {
    return parseDemoPackage(await response.text());
  } catch (cause) {
    throw new WebDavError("payload", cause instanceof Error ? cause.message : "远程快照格式不对。");
  }
}

export async function rememberPreImportSnapshot(state: DemoState): Promise<void> {
  await configStore.setItem(BACKUP_KEY, JSON.parse(JSON.stringify(state)) as DemoState);
}

export async function loadPreImportSnapshot(): Promise<DemoState | null> {
  return configStore.getItem<DemoState>(BACKUP_KEY);
}

export async function clearPreImportSnapshot(): Promise<void> {
  await configStore.removeItem(BACKUP_KEY);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
