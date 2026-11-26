// /api/sync/* for the web build (local-web): the same @offeru/sync engine as the desktop companion,
// running in the page against the user's own bucket (needs the bucket's CORS to allow this origin,
// see docs/sync.md). Settings + state live in this browser's IndexedDB, next to the records they
// sync — the same trust level as the companion's sync.json next to offeru.db — so a refresh does
// not ask for the passphrase again and the page can pull what the Agent pushed (#/sync/pair).
import localforage from "localforage";
import type { CoreStore } from "@offeru/core";
import type { SyncController, SyncStatusView } from "@offeru/backend/routes/sync";
import {
  RemoteRepo,
  S3BlobStore,
  SyncEngine,
  SyncError,
  isSyncError,
  type FetchLike,
  type S3Config,
  type SyncResult,
  type SyncState,
  type SyncStateStore,
} from "@offeru/sync";

type StoredConfig = S3Config & { passphrase: string };

const CONFIG_KEY = "config:v1";
const STATE_KEY = "state:v1";

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function mask(value: string): string {
  return value.length <= 6 ? "••••" : `${value.slice(0, 4)}••••${value.slice(-2)}`;
}

export class BrowserSyncController implements SyncController {
  private readonly box: LocalForage;
  private readonly state: SyncStateStore;
  private running: Promise<{ result: SyncResult; status: SyncStatusView }> | null = null;
  private engine: { key: string; engine: SyncEngine } | null = null;
  private lastResult: SyncResult | null = null;
  private lastError: SyncStatusView["last_error"] = null;

  constructor(
    private readonly store: CoreStore,
    private readonly options: { fetch?: FetchLike; kdfIterations?: number; name?: string; box?: LocalForage } = {},
  ) {
    this.box = options.box ?? localforage.createInstance({ name: options.name ?? "offeru-local-sync", storeName: "s3" });
    this.state = {
      load: async () => (await this.box.getItem<SyncState>(STATE_KEY)) ?? null,
      save: async (state) => { await this.box.setItem(STATE_KEY, state); },
    };
  }

  private readConfig(): Promise<StoredConfig | null> {
    return this.box.getItem<StoredConfig>(CONFIG_KEY);
  }

  private blobs(config: StoredConfig): S3BlobStore {
    return new S3BlobStore(config, this.options.fetch);
  }

  private engineFor(config: StoredConfig): SyncEngine {
    const key = JSON.stringify(config);
    if (this.engine?.key !== key) {
      this.engine = {
        key,
        engine: new SyncEngine({ store: this.store, blobs: this.blobs(config), state: this.state, passphrase: config.passphrase, kdfIterations: this.options.kdfIterations }),
      };
    }
    return this.engine.engine;
  }

  async configured(): Promise<boolean> {
    return Boolean(await this.readConfig());
  }

  async status(): Promise<SyncStatusView> {
    const config = await this.readConfig();
    const state = await this.state.load();
    const pending = config ? (await this.engineFor(config).status()).pending : null;
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

  /** Same rules as the companion: opens the repo first (initializes an empty bucket, checks the passphrase). */
  async configure(input: Record<string, unknown>): Promise<SyncStatusView> {
    if (input.clear === true) {
      await this.box.removeItem(CONFIG_KEY);
      this.engine = null;
      this.lastError = null;
      return this.status();
    }
    const previous = await this.readConfig();
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
    await this.box.setItem(CONFIG_KEY, config);
    this.engine = null;
    this.lastError = null;
    return this.status();
  }

  syncNow(): Promise<{ result: SyncResult; status: SyncStatusView }> {
    this.running ??= this.run().finally(() => { this.running = null; });
    return this.running;
  }

  private async run(): Promise<{ result: SyncResult; status: SyncStatusView }> {
    const config = await this.readConfig();
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

/**
 * Keeps the page close to what the Agent pushed: one quiet sync when the page opens and when the
 * tab comes back into view (at most every `minGapMs`). Failures stay in /api/sync/status
 * (设置 › 数据 › 云同步 shows them); nothing pops up.
 */
export function startAutoSync(sync: BrowserSyncController, onPulled: () => void, minGapMs = 60_000): () => void {
  let last = 0;
  const tick = async () => {
    if (Date.now() - last < minGapMs || !(await sync.configured())) return;
    last = Date.now();
    try {
      const { result } = await sync.syncNow();
      if (result.pulled > 0) onPulled();
    } catch {
      // recorded in status().last_error
    }
  };
  const onVisible = () => { if (document.visibilityState === "visible") void tick(); };
  document.addEventListener("visibilitychange", onVisible);
  void tick();
  return () => document.removeEventListener("visibilitychange", onVisible);
}
