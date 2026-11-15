// Runtime-agnostic sync controller: the same class runs on the Node companion
// (settings in sync.json, state in sync-state.json) and inside the page in the
// web build (settings + state in IndexedDB). Only the two small stores differ;
// they are injected. No node:* imports here (the browser bundle includes it).

import type { CoreStore } from "@offeru/core";
import {
  BUNDLE_EXTENSION,
  RemoteRepo,
  S3BlobStore,
  SyncEngine,
  SyncError,
  diagnoseS3,
  emptyProgress,
  exportBundle,
  importBundle,
  isSyncError,
  listConflicts,
  resolveConflict,
  type Diagnosis,
  type FetchLike,
  type S3Config,
  type SyncProgress,
  type SyncResult,
  type SyncStateStore,
} from "@offeru/sync";

import type { SyncController, SyncStatusView } from "./routes/sync";

export type SyncProvider = "r2" | "s3" | "minio" | "other";

/** Everything needed to reach the bucket and open the repo. */
export type StoredSyncSettings = S3Config & { passphrase: string; provider?: SyncProvider };

/**
 * Where settings live. `secretAccessKey` / `passphrase` may come back empty when
 * the runtime keeps them only for the session (browser, "don't remember").
 */
export interface SyncSettingsStore {
  load(): Promise<StoredSyncSettings | null>;
  save(settings: StoredSyncSettings, options: { remember: boolean }): Promise<void>;
  clear(): Promise<void>;
  /** stored = persisted (file / encrypted at rest); session = memory only until reload */
  readonly secretsMode?: () => Promise<"stored" | "session">;
}

const PROVIDERS = new Set<SyncProvider>(["r2", "s3", "minio", "other"]);

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function mask(value: string): string {
  if (!value) return "";
  return value.length <= 6 ? "••••" : `${value.slice(0, 4)}••••${value.slice(-2)}`;
}

function stamp(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export class SyncService implements SyncController {
  private running: Promise<{ result: unknown; status: SyncStatusView }> | null = null;
  private engine: { key: string; engine: SyncEngine } | null = null;
  private lastResult: SyncResult | null = null;
  private lastError: SyncStatusView["last_error"] = null;
  private progress: SyncProgress | null = null;

  constructor(
    private readonly store: CoreStore,
    private readonly settings: SyncSettingsStore,
    private readonly state: SyncStateStore,
    private readonly options: { fetch?: FetchLike; kdfIterations?: number; browser?: boolean; now?: () => Date } = {},
  ) {}

  private blobs(config: StoredSyncSettings): S3BlobStore {
    return new S3BlobStore(config, this.options.fetch);
  }

  private ready(config: StoredSyncSettings | null): config is StoredSyncSettings {
    return Boolean(config && config.secretAccessKey && config.passphrase);
  }

  private engineFor(config: StoredSyncSettings): SyncEngine {
    const key = JSON.stringify(config);
    if (this.engine?.key !== key) {
      this.engine = {
        key,
        engine: new SyncEngine({
          store: this.store,
          blobs: this.blobs(config),
          state: this.state,
          passphrase: config.passphrase,
          kdfIterations: this.options.kdfIterations,
          now: this.options.now,
          onProgress: (progress) => {
            this.progress = progress;
          },
        }),
      };
    }
    return this.engine.engine;
  }

  async status(): Promise<SyncStatusView> {
    const config = await this.settings.load();
    const state = await this.state.load();
    const ready = this.ready(config);
    const pending = ready ? (await this.engineFor(config).status()).pending : null;
    return {
      configured: Boolean(config),
      config: config
        ? {
          provider: config.provider ?? (config.endpoint ? "other" : "s3"),
          endpoint: config.endpoint ?? "",
          bucket: config.bucket,
          region: config.region,
          prefix: config.prefix ?? "",
          pathStyle: config.pathStyle ?? Boolean(config.endpoint),
          accessKeyId: mask(config.accessKeyId),
        }
        : null,
      secrets: config ? (ready ? (await this.settings.secretsMode?.()) ?? "stored" : "missing") : null,
      needs_secret: Boolean(config) && !ready,
      syncing: Boolean(this.running),
      progress: this.running ? this.progress ?? emptyProgress() : null,
      device: state?.device ?? null,
      last_sync_at: state?.last_sync_at ?? null,
      pending,
      last_result: this.lastResult,
      last_error: this.lastError,
    };
  }

  /** Form input merged over what is saved: blank secret / passphrase / key id = keep the saved one. */
  private async merged(input: Record<string, unknown>): Promise<StoredSyncSettings> {
    const previous = await this.settings.load();
    const provider = text(input.provider) as SyncProvider;
    return {
      provider: PROVIDERS.has(provider) ? provider : previous?.provider,
      endpoint: text(input.endpoint) || undefined,
      bucket: text(input.bucket),
      region: text(input.region) || "auto",
      accessKeyId: text(input.accessKeyId) || previous?.accessKeyId || "",
      secretAccessKey: text(input.secretAccessKey) || previous?.secretAccessKey || "",
      prefix: text(input.prefix) || "offeru",
      pathStyle: typeof input.pathStyle === "boolean" ? input.pathStyle : undefined,
      passphrase: typeof input.passphrase === "string" && input.passphrase ? input.passphrase : previous?.passphrase ?? "",
    };
  }

  /** Validates by opening the repo (initializes an empty bucket, checks the passphrase on an existing one). */
  async configure(input: Record<string, unknown>): Promise<SyncStatusView> {
    if (input.clear === true) {
      await this.settings.clear();
      this.engine = null;
      this.lastError = null;
      this.lastResult = null;
      return this.status();
    }
    const config = await this.merged(input);
    if (config.passphrase.length < 8) throw new SyncError("config", "同步口令至少 8 个字符；它加密你的全部数据，丢了就解不开");
    await RemoteRepo.open(this.blobs(config), config.passphrase, { iterations: this.options.kdfIterations });
    await this.settings.save(config, { remember: input.remember !== false });
    this.engine = null;
    this.lastError = null;
    return this.status();
  }

  /** 测试连接: never saves anything; blank secrets fall back to the saved ones. */
  async test(input: Record<string, unknown>): Promise<Diagnosis> {
    const config = await this.merged(input);
    return diagnoseS3(config, {
      fetch: this.options.fetch,
      browser: this.options.browser,
      passphrase: config.passphrase || undefined,
    });
  }

  syncNow(): Promise<{ result: unknown; status: SyncStatusView }> {
    this.running ??= this.run().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async run(): Promise<{ result: unknown; status: SyncStatusView }> {
    const config = await this.settings.load();
    if (!config) throw new SyncError("config", "还没有设置同步：先填存储桶和口令");
    if (!this.ready(config)) throw new SyncError("config", "页面刷新过，Secret 和口令只保存在当时的会话里：请重新填写后保存");
    this.progress = emptyProgress();
    try {
      this.lastResult = await this.engineFor(config).sync();
      this.lastError = null;
    } catch (error) {
      if (isSyncError(error)) this.lastError = { code: error.code, message: error.message, at: new Date().toISOString() };
      throw error;
    }
    const result = this.lastResult;
    this.running = null;
    return { result, status: await this.status() };
  }

  async conflicts() {
    return { conflicts: await listConflicts(this.store, await this.state.load()) };
  }

  async resolveConflict(id: number, keep: "mine" | "theirs", actor: string) {
    if (keep !== "mine" && keep !== "theirs") throw new SyncError("config", "keep 只能是 mine 或 theirs");
    const out = await resolveConflict(this.store, await this.state.load(), id, keep, { actor, now: (this.options.now?.() ?? new Date()).toISOString() });
    return { applied: out.applied, ...(await this.conflicts()) };
  }

  /** Encrypted single-file backup of every local record. Needs no bucket. */
  async exportBackup(passphrase: string): Promise<{ bytes: Uint8Array; filename: string; records: number }> {
    const now = this.options.now?.() ?? new Date();
    const { bytes, records } = await exportBundle({ store: this.store, passphrase, kdfIterations: this.options.kdfIterations });
    return { bytes, filename: `offeru-backup-${stamp(now)}${BUNDLE_EXTENSION}`, records };
  }

  async importBackup(bytes: Uint8Array, passphrase: string): Promise<{ result: SyncResult }> {
    if (!passphrase) throw new SyncError("config", "请输入导出这个备份时设置的口令");
    return { result: await importBundle({ store: this.store, bytes, passphrase }) };
  }
}
