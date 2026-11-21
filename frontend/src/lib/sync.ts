import { request } from "@/lib/api";

// S3 数据同步（backend-ts /api/sync/*）。凭证与口令只存在本机：伴侣端写数据目录里的 0600 文件，
// 网页版存浏览器本地；GET 永远不回传 Secret 和口令。

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

export type SyncConfigInput = Partial<Omit<SyncConfigView, "configured" | "has_secret" | "has_passphrase">> & {
  secret_access_key?: string;
  passphrase?: string;
};

export type SyncConflict = { kind: "record" | "file"; what: string; kept: "local" | "remote"; copy: string };

export type SyncRunResult = {
  ok: true;
  at: string;
  snapshot: string | null;
  pulled: number;
  pushed: number;
  uploaded_objects: number;
  conflicts: SyncConflict[];
  attempts: number;
  gc?: { snapshots_deleted: number; objects_deleted: number; snapshots_kept: number };
};

export type SyncStatus = {
  configured: boolean;
  running: boolean;
  device_id: string | null;
  last_run_at: string | null;
  last_ok_at: string | null;
  last_error: string | null;
  last_result: SyncRunResult | null;
  auto_minutes: number;
};

export const syncApi = {
  config: () => request<SyncConfigView>("/api/sync/config"),
  saveConfig: (input: SyncConfigInput) => request<SyncConfigView>("/api/sync/config", { method: "PUT", body: JSON.stringify(input) }),
  clearConfig: () => request<{ ok: true }>("/api/sync/config", { method: "DELETE" }),
  status: () => request<SyncStatus>("/api/sync/status"),
  run: (options: { gc?: boolean } = {}) => request<SyncRunResult>("/api/sync/run", { method: "POST", body: JSON.stringify(options) }),
};

/** 桶的 CORS 规则（浏览器直连 S3 才需要；本机伴侣不需要）。ETag 要暴露，条件写靠它。 */
export function corsExample(origin: string): { r2: string; s3: string } {
  const origins = [origin || "https://你的 OfferU 网址"];
  const rule = {
    AllowedOrigins: origins,
    AllowedMethods: ["GET", "PUT", "DELETE", "HEAD"],
    AllowedHeaders: ["authorization", "content-type", "x-amz-date", "x-amz-content-sha256", "x-amz-security-token", "if-match", "if-none-match"],
    ExposeHeaders: ["ETag"],
    MaxAgeSeconds: 3600,
  };
  return {
    r2: JSON.stringify([rule], null, 2),
    s3: JSON.stringify({ CORSRules: [rule] }, null, 2),
  };
}

export function describeSyncResult(result: SyncRunResult): string {
  const parts = [`拉取 ${result.pulled} 项`, `推送 ${result.pushed} 项`];
  if (result.conflicts.length) parts.push(`${result.conflicts.length} 处冲突已保留副本`);
  return parts.join("，");
}
