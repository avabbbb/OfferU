// Sync service: config (device-local), status, one-at-a-time runs, optional
// auto-sync timer. Same object in the browser (IDB-backed config + store) and
// the Node companion (0600 config file + SQLite store).

import { CoreError } from "../types";
import type { RepoKeys } from "./crypto";
import { loadState, SyncEngine, type SyncableStore, type SyncPolicy } from "./engine";
import { S3Client, type S3Fetch } from "./s3";
import type { SyncConfig, SyncConfigStore, SyncFileStore, SyncRunResult, SyncStatus } from "./types";

export type SyncServiceDeps = {
  store: SyncableStore;
  files?: SyncFileStore | null;
  config: SyncConfigStore;
  fetch: S3Fetch;
  now?: () => Date;
  policy?: Partial<SyncPolicy>;
  kdfIterations?: number;
  defaultDeviceName?: string;
};

/** Public view of the config: secrets never leave the device's storage layer. Snake case like the rest of the API. */
export type SyncConfigView = {
  configured: boolean;
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  force_path_style: boolean;
  access_key_id: string;
  has_secret: boolean;
  has_passphrase: boolean;
  device_name: string;
  auto_minutes: number;
  sync_on_start: boolean;
};

export type SyncConfigInput = Partial<{
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  force_path_style: boolean;
  access_key_id: string;
  /** Empty / absent = keep the saved one. */
  secret_access_key: string;
  session_token: string;
  passphrase: string;
  device_name: string;
  auto_minutes: number;
  sync_on_start: boolean;
}>;

function mask(value: string): string {
  if (!value) return "";
  return value.length <= 8 ? `${value.slice(0, 2)}…` : `${value.slice(0, 4)}…${value.slice(-4)}`;
}

export function normalizePrefix(prefix: string | undefined): string {
  const trimmed = (prefix ?? "offeru").trim().replace(/^\/+/, "").replace(/\/+$/, "");
  return trimmed ? `${trimmed}/` : "";
}

export function repoIdOf(config: Pick<SyncConfig, "endpoint" | "bucket" | "prefix">): string {
  return `${config.endpoint.replace(/\/+$/, "")}|${config.bucket}|${config.prefix}`;
}

export class SyncService {
  private running: Promise<SyncRunResult> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly keyCache = new Map<string, RepoKeys>();
  private lastRunAt: string | null = null;
  private lastOkAt: string | null = null;
  private lastError: string | null = null;
  private lastResult: SyncRunResult | null = null;

  constructor(private readonly deps: SyncServiceDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  async getConfig(): Promise<SyncConfigView> {
    const config = await this.deps.config.load();
    return {
      configured: Boolean(config && isComplete(config)),
      endpoint: config?.endpoint ?? "",
      region: config?.region ?? "auto",
      bucket: config?.bucket ?? "",
      prefix: config?.prefix ?? "offeru/",
      force_path_style: config?.forcePathStyle ?? true,
      access_key_id: mask(config?.accessKeyId ?? ""),
      has_secret: Boolean(config?.secretAccessKey),
      has_passphrase: Boolean(config?.passphrase),
      device_name: config?.deviceName || this.deps.defaultDeviceName || "",
      auto_minutes: config?.autoMinutes ?? 0,
      sync_on_start: config?.syncOnStart ?? false,
    };
  }

  /** Merge input over the saved config. `{ clear: true }` style removal goes through clearConfig(). */
  async saveConfig(input: SyncConfigInput): Promise<SyncConfigView> {
    const saved = await this.deps.config.load();
    const pick = (value: string | undefined, fallback: string) => (typeof value === "string" ? value.trim() : fallback);
    const keep = (value: string | undefined, fallback: string) => (typeof value === "string" && value.trim() ? value.trim() : fallback);
    const next: SyncConfig = {
      endpoint: pick(input.endpoint, saved?.endpoint ?? "").replace(/\/+$/, ""),
      region: pick(input.region, saved?.region ?? "auto") || "auto",
      bucket: pick(input.bucket, saved?.bucket ?? ""),
      prefix: normalizePrefix(input.prefix ?? saved?.prefix ?? "offeru"),
      accessKeyId: keep(input.access_key_id && !input.access_key_id.includes("…") ? input.access_key_id : undefined, saved?.accessKeyId ?? ""),
      secretAccessKey: keep(input.secret_access_key, saved?.secretAccessKey ?? ""),
      sessionToken: keep(input.session_token, saved?.sessionToken ?? "") || undefined,
      // The passphrase is never trimmed: spaces may be part of it.
      passphrase: typeof input.passphrase === "string" && input.passphrase ? input.passphrase : saved?.passphrase ?? "",
      forcePathStyle: typeof input.force_path_style === "boolean" ? input.force_path_style : saved?.forcePathStyle ?? true,
      deviceName: pick(input.device_name, saved?.deviceName ?? this.deps.defaultDeviceName ?? "").slice(0, 40),
      autoMinutes: clampMinutes(input.auto_minutes ?? saved?.autoMinutes ?? 0),
      syncOnStart: typeof input.sync_on_start === "boolean" ? input.sync_on_start : saved?.syncOnStart ?? false,
    };
    if (next.endpoint) {
      let url: URL;
      try {
        url = new URL(next.endpoint);
      } catch {
        throw new CoreError("S3 endpoint 不是合法地址（例：https://<账号ID>.r2.cloudflarestorage.com）");
      }
      if (url.protocol !== "https:" && url.protocol !== "http:") throw new CoreError("S3 endpoint 要以 https:// 开头");
    }
    if (next.bucket && !/^[a-z0-9][a-z0-9.\-_]{1,62}$/i.test(next.bucket)) throw new CoreError("桶名不合法");
    if (next.passphrase && next.passphrase.length < 8) throw new CoreError("同步口令至少 8 个字符");
    await this.deps.config.save(next);
    this.keyCache.clear();
    this.scheduleAuto(next);
    return this.getConfig();
  }

  async clearConfig(): Promise<void> {
    await this.deps.config.save(null);
    this.keyCache.clear();
    this.stopAuto();
  }

  async status(): Promise<SyncStatus> {
    const config = await this.deps.config.load();
    let deviceId: string | null = null;
    try {
      deviceId = (await loadState(this.deps.store)).device_id;
    } catch { /* store without sync meta */ }
    return {
      configured: Boolean(config && isComplete(config)),
      running: Boolean(this.running),
      device_id: deviceId,
      last_run_at: this.lastRunAt,
      last_ok_at: this.lastOkAt,
      last_error: this.lastError,
      last_result: this.lastResult,
      auto_minutes: config?.autoMinutes ?? 0,
    };
  }

  /** Run now. A second call while one is running joins the running one. */
  run(options: { gc?: boolean } = {}): Promise<SyncRunResult> {
    if (this.running) return this.running;
    const job = this.runOnce(options).finally(() => {
      this.running = null;
    });
    this.running = job;
    return job;
  }

  private async runOnce(options: { gc?: boolean }): Promise<SyncRunResult> {
    const config = await this.deps.config.load();
    if (!config || !isComplete(config)) throw new CoreError("还没配置数据同步（S3 endpoint、桶、Access Key、Secret、同步口令）", "invalid");
    this.lastRunAt = this.now().toISOString();
    const engine = new SyncEngine({
      store: this.deps.store,
      files: this.deps.files,
      s3: new S3Client({
        endpoint: config.endpoint,
        bucket: config.bucket,
        forcePathStyle: config.forcePathStyle,
        region: config.region || "auto",
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
        sessionToken: config.sessionToken,
        fetch: this.deps.fetch,
      }),
      prefix: config.prefix,
      passphrase: config.passphrase,
      deviceName: config.deviceName || this.deps.defaultDeviceName || "device",
      repoId: repoIdOf(config),
      now: this.deps.now,
      policy: this.deps.policy,
      kdfIterations: this.deps.kdfIterations,
      keyCache: this.keyCache,
    });
    try {
      const result = await engine.run(options);
      this.lastOkAt = result.at;
      this.lastError = null;
      this.lastResult = result;
      return result;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  /** Start the timer (and the on-start run) from the saved config. Errors land in status, never thrown. */
  async start(): Promise<void> {
    const config = await this.deps.config.load();
    if (!config || !isComplete(config)) return;
    this.scheduleAuto(config);
    if (config.syncOnStart) this.run().catch(() => undefined);
  }

  private scheduleAuto(config: SyncConfig): void {
    this.stopAuto();
    if (!isComplete(config) || config.autoMinutes <= 0) return;
    this.timer = setInterval(() => {
      this.run().catch(() => undefined);
    }, config.autoMinutes * 60_000);
    (this.timer as { unref?: () => void }).unref?.();
  }

  stopAuto(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

function clampMinutes(value: number): number {
  const n = Math.floor(Number(value) || 0);
  if (n <= 0) return 0;
  return Math.min(Math.max(n, 5), 24 * 60);
}

function isComplete(config: SyncConfig): boolean {
  return Boolean(config.endpoint && config.bucket && config.accessKeyId && config.secretAccessKey && config.passphrase);
}
