export type SyncErrorCode =
  | "config"      // missing / invalid settings
  | "passphrase"  // wrong passphrase (key check failed)
  | "decrypt"     // object failed authentication
  | "format"      // unknown repo format / corrupt object
  | "auth"        // bucket rejected credentials (401/403)
  | "network"     // fetch failed (offline, DNS, CORS)
  | "http"        // other unexpected status
  | "locked"      // another device holds the sync lock
  | "conflict"    // refs/latest kept moving; gave up after retries
  | "expired";    // a pairing link past its expiry

export class SyncError extends Error {
  readonly code: SyncErrorCode;
  readonly status?: number;

  constructor(code: SyncErrorCode, message: string, status?: number) {
    super(message);
    this.name = "SyncError";
    this.code = code;
    this.status = status;
  }
}

export function isSyncError(value: unknown): value is SyncError {
  return value instanceof Error && value.name === "SyncError" && typeof (value as SyncError).code === "string";
}

/** Thrown by BlobStore.put when an If-Match / If-None-Match condition fails. */
export class PreconditionFailed extends Error {
  constructor(key: string) {
    super(`条件写入失败：${key}`);
    this.name = "PreconditionFailed";
  }
}
