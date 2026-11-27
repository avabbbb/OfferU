import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { CoreStore } from "@offeru/core";
import {
  RemoteRepo,
  S3BlobStore,
  SyncEngine,
  SyncError,
  isSyncError,
  pairingUrl,
  sealPairing,
  type FetchLike,
  type S3Config,
  type SyncResult,
  type SyncState,
  type SyncStateStore,
} from "@offeru/sync";

import type { SyncController, SyncStatusView } from "./routes/sync";

/**
 * Node companion side of sync: settings and state live next to the SQLite
 * file, never anywhere else. sync.json holds the bucket credentials and the
 * passphrase (chmod 600); sync-state.json holds the three-way base and id map.
 */
type StoredConfig = S3Config & { passphrase: string };

class FileStateStore implements SyncStateStore {
  constructor(private readonly path: string) {}

  async load(): Promise<SyncState | null> {
    return existsSync(this.path) ? JSON.parse(readFileSync(this.path, "utf8")) as SyncState : null;
  }

  async save(state: SyncState): Promise<void> {
    writeFileSync(this.path, JSON.stringify(state));
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function mask(value: string): string {
  return value.length <= 6 ? "••••" : `${value.slice(0, 4)}••••${value.slice(-2)}`;
}

export class CompanionSync implements SyncController {
  private readonly configPath: string;
  private readonly state: FileStateStore;
  private running: Promise<{ result: unknown; status: SyncStatusView }> | null = null;
  private engine: { key: string; engine: SyncEngine } | null = null;
  private lastResult: SyncResult | null = null;
  private lastError: SyncStatusView["last_error"] = null;

  constructor(
    private readonly store: CoreStore,
    dir: string,
    private readonly options: { fetch?: FetchLike; kdfIterations?: number } = {},
  ) {
    mkdirSync(dir, { recursive: true });
    this.configPath = join(dir, "sync.json");
    this.state = new FileStateStore(join(dir, "sync-state.json"));
  }

  private readConfig(): StoredConfig | null {
    return existsSync(this.configPath) ? JSON.parse(readFileSync(this.configPath, "utf8")) as StoredConfig : null;
  }

  private blobs(config: StoredConfig): S3BlobStore {
    return new S3BlobStore(config, this.options.fetch);
  }

  private engineFor(config: StoredConfig): SyncEngine {
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
        }),
      };
    }
    return this.engine.engine;
  }

  async status(): Promise<SyncStatusView> {
    const config = this.readConfig();
    const state = await this.state.load();
    let pending: number | null = null;
    if (config) pending = (await this.engineFor(config).status()).pending;
    return {
      configured: Boolean(config),
      config: config
        ? {
          endpoint: config.endpoint ?? "",
          bucket: config.bucket,
          region: config.region,
          prefix: config.prefix ?? "",
          pathStyle: config.pathStyle ?? Boolean(config.endpoint),
          accessKeyId: mask(config.accessKeyId),
        }
        : null,
      syncing: Boolean(this.running),
      device: state?.device ?? null,
      last_sync_at: state?.last_sync_at ?? null,
      pending,
      last_result: this.lastResult,
      last_error: this.lastError,
    };
  }

  /** Validates by opening the repo (initializes an empty bucket, checks the passphrase on an existing one). */
  async configure(input: Record<string, unknown>): Promise<SyncStatusView> {
    if (input.clear === true) {
      rmSync(this.configPath, { force: true });
      this.engine = null;
      this.lastError = null;
      return this.status();
    }
    const previous = this.readConfig();
    const config: StoredConfig = {
      endpoint: text(input.endpoint) || undefined,
      bucket: text(input.bucket),
      region: text(input.region) || "auto",
      accessKeyId: text(input.accessKeyId) || previous?.accessKeyId || "",
      secretAccessKey: text(input.secretAccessKey) || previous?.secretAccessKey || "",
      prefix: text(input.prefix) || "offeru",
      pathStyle: typeof input.pathStyle === "boolean" ? input.pathStyle : undefined,
      passphrase: typeof input.passphrase === "string" && input.passphrase ? input.passphrase : previous?.passphrase ?? "",
    };
    if (config.passphrase.length < 8) throw new SyncError("config", "同步口令至少 8 个字符；它加密你的全部数据，丢了就解不开");
    await RemoteRepo.open(this.blobs(config), config.passphrase, { iterations: this.options.kdfIterations });
    writeFileSync(this.configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
    try {
      chmodSync(this.configPath, 0o600);
    } catch {
      // Windows: ACLs, not modes
    }
    this.engine = null;
    this.lastError = null;
    return this.status();
  }

  /**
   * `offeru sync pair`: a link for the web version carrying this bucket's settings, sealed with
   * the sync passphrase (packages/sync/src/pair.ts). Offline: configure already checked the bucket.
   * null when sync is not set up yet.
   */
  async pairing(origin: string, options: { now?: Date; ttlMs?: number } = {}): Promise<{ url: string; expires_at: string } | null> {
    const config = this.readConfig();
    if (!config) return null;
    const { passphrase, sessionToken: _token, ...bucket } = config;
    const { code, expires_at } = await sealPairing(bucket, passphrase, { ...options, iterations: this.options.kdfIterations });
    return { url: pairingUrl(origin, code), expires_at };
  }

  syncNow(): Promise<{ result: unknown; status: SyncStatusView }> {
    this.running ??= this.run().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async run(): Promise<{ result: unknown; status: SyncStatusView }> {
    const config = this.readConfig();
    if (!config) throw new SyncError("config", "还没有设置同步：先填存储桶和口令");
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
}
