// S3 / R2 端到端加密同步：设置页只通过这里调同步。
// 本机模式（有 TS 后端）走 /api/sync/*，凭据存在后端那台机器上；
// 展示站（没有后端）在浏览器里跑同一个 @offeru/sync 引擎，同步 IndexedDB 里的演示数据，
// Secret 和口令只放内存（刷新后要重填），和 WebDAV 那套一致。

import localforage from "localforage";
import { S3BlobStore, SyncEngine, type S3Config, type SyncResult, type SyncState, type SyncStateStore, isSyncError } from "@offeru/sync";

import { request } from "@/lib/api";
import { bridgeActive } from "@/lib/bridge";
import { demoStore } from "@/lib/demo/store";
import { SHOWCASE } from "@/lib/showcase";

export type SyncForm = {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix: string;
  pathStyle: boolean;
  passphrase: string;
};

export type SyncConfigView = Omit<SyncForm, "secretAccessKey" | "passphrase">;

export type SyncResultView = Pick<SyncResult, "at" | "pulled" | "pushed" | "conflicts" | "resurrected" | "uploaded">;

export type SyncStatusView = {
  configured: boolean;
  config: SyncConfigView | null;
  syncing: boolean;
  device: string | null;
  last_sync_at: string | null;
  pending: number | null;
  last_result: SyncResultView | null;
  last_error: { code: string; message: string; at: string } | null;
  /** 浏览器模式下 Secret / 口令只在内存里，刷新后需要重填 */
  needs_secret?: boolean;
};

export const EMPTY_SYNC_FORM: SyncForm = {
  endpoint: "", bucket: "", region: "auto", accessKeyId: "", secretAccessKey: "", prefix: "offeru", pathStyle: true, passphrase: "",
};

export function browserSyncMode(): boolean {
  return SHOWCASE && !bridgeActive();
}

export function syncApi() {
  return browserSyncMode() ? browserSync : companionSync;
}

const companionSync = {
  status: () => request<SyncStatusView>("/api/sync/status"),
  configure: (form: SyncForm) => request<SyncStatusView>("/api/sync/configure", { method: "POST", body: JSON.stringify(form) }),
  disconnect: () => request<SyncStatusView>("/api/sync/configure", { method: "POST", body: JSON.stringify({ clear: true }) }),
  now: () => request<{ result: SyncResultView; status: SyncStatusView }>("/api/sync/now", { method: "POST" }),
};

// ---- 浏览器模式 ----

const box = localforage.createInstance({ name: "offeru-demo-sync", storeName: "s3" });
const CONFIG_KEY = "s3:v1";
const STATE_KEY = "s3-state:v1";
let secrets: { secretAccessKey: string; passphrase: string } | null = null;
let lastResult: SyncResultView | null = null;
let lastError: SyncStatusView["last_error"] = null;
let running: Promise<{ result: SyncResultView; status: SyncStatusView }> | null = null;

const stateStore: SyncStateStore = {
  load: async () => (await box.getItem<SyncState>(STATE_KEY)) ?? null,
  save: async (state) => {
    await box.setItem(STATE_KEY, state);
  },
};

function s3Config(config: SyncConfigView, secret: string): S3Config {
  return {
    endpoint: config.endpoint || undefined,
    bucket: config.bucket,
    region: config.region || "auto",
    accessKeyId: config.accessKeyId,
    secretAccessKey: secret,
    prefix: config.prefix,
    pathStyle: config.pathStyle,
  };
}

function engineFor(config: SyncConfigView, secret: { secretAccessKey: string; passphrase: string }): SyncEngine {
  return new SyncEngine({ store: demoStore, blobs: new S3BlobStore(s3Config(config, secret.secretAccessKey)), state: stateStore, passphrase: secret.passphrase });
}

const browserSync = {
  async status(): Promise<SyncStatusView> {
    await demoStore.ready();
    const config = await box.getItem<SyncConfigView>(CONFIG_KEY);
    const state = await stateStore.load();
    return {
      configured: Boolean(config),
      config,
      syncing: Boolean(running),
      device: state?.device ?? null,
      last_sync_at: state?.last_sync_at ?? null,
      pending: config && secrets ? (await engineFor(config, secrets).status()).pending : null,
      last_result: lastResult,
      last_error: lastError,
      needs_secret: Boolean(config) && !secrets,
    };
  },
  async configure(form: SyncForm): Promise<SyncStatusView> {
    const { secretAccessKey, passphrase, ...config } = form;
    const secret = { secretAccessKey: secretAccessKey || secrets?.secretAccessKey || "", passphrase: passphrase || secrets?.passphrase || "" };
    if (secret.passphrase.length < 8) throw new Error("同步口令至少 8 个字符；它加密你的全部数据，丢了就解不开");
    await demoStore.ready();
    await engineFor(config, secret).connect();
    secrets = secret;
    lastError = null;
    await box.setItem(CONFIG_KEY, config);
    return browserSync.status();
  },
  async disconnect(): Promise<SyncStatusView> {
    secrets = null;
    await box.removeItem(CONFIG_KEY);
    return browserSync.status();
  },
  now(): Promise<{ result: SyncResultView; status: SyncStatusView }> {
    running ??= (async () => {
      try {
        const config = await box.getItem<SyncConfigView>(CONFIG_KEY);
        if (!config) throw new Error("还没有设置同步：先填存储桶和口令");
        if (!secrets) throw new Error("页面刷新过，Secret 和口令只存在内存里：请在下面重新填写后保存");
        await demoStore.ready();
        lastResult = await engineFor(config, secrets).sync();
        lastError = null;
        return lastResult;
      } catch (error) {
        if (isSyncError(error)) lastError = { code: error.code, message: error.message, at: new Date().toISOString() };
        throw error;
      } finally {
        running = null;
      }
    })().then(async (result) => ({ result, status: await browserSync.status() }));
    return running;
  },
};
