// S3 / R2 端到端加密同步：设置页只通过这里调同步。
//   桌面版 / 连本机后端：/api/sync/* 由 companion 回答，凭据存在那台机器的数据目录。
//   网页版（local-web）：/api/sync/* 由页面内的同一个 SyncService 回答（lib/local/backend.ts），
//                        设置存 IndexedDB，Secret 和口令按「记住」选项加密保存或只留在本次会话。
//   展示站（showcase）：没有页面内后端，这里直接调同一个 SyncService，同步的是演示数据。
// 三种形态接口完全一样；错误保留后端的 code（sync_auth 等），界面据此给出说明。

import type { ConflictView, Diagnosis, SyncProgress, SyncResult } from "@offeru/sync";
import { SyncService } from "@offeru/backend/syncService";

import { resolveApiBase } from "@/lib/apiBase";
import { bridgeActive, bridgeHeaders } from "@/lib/bridge";
import { demoStore } from "@/lib/demo/store";
import { indexedDbSyncStores } from "@/lib/local/sync";
import { safeClientErrorMessage } from "@/lib/safe-error";
import { SHOWCASE } from "@/lib/showcase";
import type { SyncForm, SyncProvider } from "@/lib/syncWizard";

export type { ConflictView, Diagnosis, SyncProgress };
export { EMPTY_SYNC_FORM, type SyncForm } from "@/lib/syncWizard";

export type SyncConfigView = {
  provider: SyncProvider;
  endpoint: string;
  bucket: string;
  region: string;
  prefix: string;
  pathStyle: boolean;
  accessKeyId: string;
};

export type SyncResultView = Pick<SyncResult, "at" | "pulled" | "pushed" | "conflicts" | "resurrected" | "uploaded" | "downloaded" | "skipped">;

export type SyncStatusView = {
  configured: boolean;
  config: SyncConfigView | null;
  secrets: "stored" | "session" | "missing" | null;
  needs_secret: boolean;
  syncing: boolean;
  progress: SyncProgress | null;
  device: string | null;
  last_sync_at: string | null;
  pending: number | null;
  last_result: SyncResultView | null;
  last_error: { code: string; message: string; at: string } | null;
};

export class SyncClientError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) {
    super(message);
    this.name = "SyncClientError";
  }
}

export interface SyncApi {
  status(): Promise<SyncStatusView>;
  configure(form: SyncForm): Promise<SyncStatusView>;
  disconnect(): Promise<SyncStatusView>;
  test(form: SyncForm): Promise<Diagnosis>;
  now(): Promise<{ result: SyncResultView; status: SyncStatusView }>;
  conflicts(): Promise<{ conflicts: ConflictView[] }>;
  resolve(id: number, keep: "mine" | "theirs"): Promise<{ applied: boolean; conflicts: ConflictView[] }>;
  exportBackup(passphrase: string): Promise<{ blob: Blob; filename: string; records: number }>;
  importBackup(file: File, passphrase: string): Promise<{ result: SyncResultView }>;
}

/** 浏览器直连存储桶（网页版 / 展示站）：需要 CORS，测试连接会单独检查。 */
export function browserSyncMode(): boolean {
  return SHOWCASE && !bridgeActive();
}

export function syncRunsInBrowser(): boolean {
  return browserSyncMode() || import.meta.env.VITE_OFFERU_MODE === "local-web";
}

export function syncApi(): SyncApi {
  return browserSyncMode() ? showcaseSync() : httpSync;
}

// ---- HTTP（companion 或网页版页面内后端） ----

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${resolveApiBase()}${path}`, {
      ...init,
      headers: { ...(init.body instanceof FormData ? {} : { "Content-Type": "application/json" }), ...bridgeHeaders(), ...(init.headers ?? {}) },
      redirect: "error",
    });
  } catch {
    throw new SyncClientError("无法连接本地后端，请确认 OfferU 后端已启动。", "backend_down", 0);
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { detail?: string; code?: string };
    const code = payload.code ?? (response.status === 404 ? "unsupported" : "");
    throw new SyncClientError(safeClientErrorMessage(payload.detail, `同步接口返回 ${response.status}`), code, response.status);
  }
  return response;
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  return (await call(path, init)).json() as Promise<T>;
}

const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

const httpSync: SyncApi = {
  status: () => json("/api/sync/status"),
  configure: (form) => json("/api/sync/configure", post(form)),
  disconnect: () => json("/api/sync/configure", post({ clear: true })),
  test: (form) => json("/api/sync/test", post(form)),
  now: () => json("/api/sync/now", { method: "POST" }),
  conflicts: () => json("/api/sync/conflicts"),
  resolve: (id, keep) => json(`/api/sync/conflicts/${id}/resolve`, post({ keep })),
  async exportBackup(passphrase) {
    const response = await call("/api/sync/export", post({ passphrase }));
    const disposition = response.headers.get("content-disposition") ?? "";
    const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? "offeru-backup.offeru";
    return { blob: await response.blob(), filename, records: Number(response.headers.get("x-offeru-records") ?? 0) };
  },
  importBackup(file, passphrase) {
    const form = new FormData();
    form.set("file", file);
    form.set("passphrase", passphrase);
    return json("/api/sync/import", { method: "POST", body: form });
  },
};

// ---- 展示站：直接调 SyncService（同步演示数据） ----

let showcase: SyncApi | null = null;

function showcaseSync(): SyncApi {
  if (showcase) return showcase;
  const stores = indexedDbSyncStores("offeru-demo-sync");
  const service = new SyncService(demoStore, stores.settings, stores.state, { browser: true });
  const wrap = async <T>(run: () => Promise<T>): Promise<T> => {
    await demoStore.ready();
    try {
      return await run();
    } catch (error) {
      const code = (error as { name?: string; code?: string }).name === "SyncError" ? `sync_${(error as { code: string }).code}` : "";
      throw new SyncClientError(safeClientErrorMessage(error, "同步失败"), code, 0);
    }
  };
  showcase = {
    status: () => wrap(() => service.status() as Promise<SyncStatusView>),
    configure: (form) => wrap(() => service.configure(form) as Promise<SyncStatusView>),
    disconnect: () => wrap(() => service.configure({ clear: true }) as Promise<SyncStatusView>),
    test: (form) => wrap(() => service.test(form)),
    now: () => wrap(() => service.syncNow() as Promise<{ result: SyncResultView; status: SyncStatusView }>),
    conflicts: () => wrap(() => service.conflicts()),
    resolve: (id, keep) => wrap(() => service.resolveConflict(id, keep, "你")),
    exportBackup: (passphrase) => wrap(async () => {
      const { bytes, filename, records } = await service.exportBackup(passphrase);
      return { blob: new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "application/vnd.offeru.backup" }), filename, records };
    }),
    importBackup: (file, passphrase) => wrap(async () => service.importBackup(new Uint8Array(await file.arrayBuffer()), passphrase)),
  };
  return showcase;
}
