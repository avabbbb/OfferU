// Storage adapter: a flat key -> bytes store with ETags and conditional PUT.
// S3BlobStore talks to any S3-compatible endpoint through fetch + SigV4.

import type { Bytes } from "./bytes";
import { PreconditionFailed, SyncError } from "./errors";
import { encodeRfc3986, signRequest } from "./sigv4";

export type PutCondition = { ifMatch?: string; ifNoneMatch?: "*" };

export interface BlobStore {
  get(key: string): Promise<{ body: Bytes; etag: string } | null>;
  /** ETag if the key exists, otherwise null. */
  head(key: string): Promise<string | null>;
  /** Returns the new ETag. Throws PreconditionFailed when the condition does not hold. */
  put(key: string, body: Uint8Array, condition?: PutCondition): Promise<string>;
  delete(key: string): Promise<void>;
  /** Stable identity of the target (endpoint/bucket/prefix), used to notice a re-pointed repo. */
  readonly location: string;
}

export type S3Config = {
  /** e.g. https://<account>.r2.cloudflarestorage.com, http://127.0.0.1:9000. Omit for AWS (s3.<region>.amazonaws.com). */
  endpoint?: string;
  bucket: string;
  /** "auto" for R2; the bucket region for AWS; anything (often us-east-1) for MinIO. */
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** Key prefix inside the bucket, e.g. "offeru/". */
  prefix?: string;
  /** https://endpoint/bucket/key instead of https://bucket.endpoint/key. Default: true with a custom endpoint, false for AWS. */
  pathStyle?: boolean;
};

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function normalizePrefix(prefix: string | undefined): string {
  const trimmed = (prefix ?? "").trim().replace(/^\/+|\/+$/g, "");
  return trimmed ? `${trimmed}/` : "";
}

export function validateS3Config(config: S3Config): void {
  if (!config.bucket?.trim()) throw new SyncError("config", "请填写存储桶名称");
  if (!config.region?.trim()) throw new SyncError("config", "请填写区域（R2 填 auto）");
  if (!config.accessKeyId?.trim() || !config.secretAccessKey?.trim()) throw new SyncError("config", "请填写 Access Key 和 Secret");
  if (config.endpoint) {
    let url: URL;
    try {
      url = new URL(config.endpoint);
    } catch {
      throw new SyncError("config", "Endpoint 不是合法地址");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new SyncError("config", "Endpoint 要以 https:// 开头");
  }
}

export function s3ErrorCode(text: string): string {
  return /<Code>([^<]+)<\/Code>/.exec(text)?.[1] ?? "";
}

export class S3BlobStore implements BlobStore {
  readonly location: string;
  private readonly base: string;
  private readonly prefix: string;

  constructor(private readonly config: S3Config, private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init)) {
    validateS3Config(config);
    this.prefix = normalizePrefix(config.prefix);
    const bucket = config.bucket.trim();
    const endpoint = (config.endpoint?.trim() || `https://s3.${config.region.trim()}.amazonaws.com`).replace(/\/+$/, "");
    const pathStyle = config.pathStyle ?? Boolean(config.endpoint);
    if (pathStyle) {
      this.base = `${endpoint}/${encodeRfc3986(bucket)}`;
    } else {
      const url = new URL(endpoint);
      this.base = `${url.protocol}//${bucket}.${url.host}${url.pathname.replace(/\/+$/, "")}`;
    }
    this.location = `${this.base}/${this.prefix}`;
  }

  private url(key: string): URL {
    const path = `${this.prefix}${key}`.split("/").map(encodeRfc3986).join("/");
    return new URL(`${this.base}/${path}`);
  }

  /** Bucket root (https://endpoint/bucket or https://bucket.endpoint), used by diagnostics. */
  get baseUrl(): string {
    return this.base;
  }

  /** One signed request, no error mapping: fetch failures propagate as-is. Diagnostics use it. */
  async rawRequest(method: string, key: string, body?: Uint8Array, extra: Record<string, string> = {}): Promise<Response> {
    const url = this.url(key);
    const headers = await signRequest({
      method,
      url,
      headers: extra,
      body,
      credentials: {
        accessKeyId: this.config.accessKeyId.trim(),
        secretAccessKey: this.config.secretAccessKey.trim(),
        sessionToken: this.config.sessionToken,
        region: this.config.region.trim(),
      },
    });
    return this.fetchImpl(url.toString(), { method, headers, body: body as RequestInit["body"] });
  }

  private async send(method: string, key: string, body?: Uint8Array, extra: Record<string, string> = {}): Promise<Response> {
    try {
      return await this.rawRequest(method, key, body, extra);
    } catch (cause) {
      throw new SyncError(
        "network",
        `连不上存储桶（${method} ${key}）。检查网络、Endpoint，浏览器里使用还要给存储桶配置 CORS。${cause instanceof Error ? ` ${cause.message}` : ""}`,
      );
    }
  }

  private async fail(response: Response, method: string, key: string): Promise<never> {
    const text = method === "HEAD" ? "" : await response.text().catch(() => "");
    const code = s3ErrorCode(text);
    if (response.status === 401 || response.status === 403) {
      throw new SyncError("auth", `存储桶拒绝访问（${response.status}${code ? ` ${code}` : ""}）：检查 Access Key / Secret / 区域 / 存储桶权限`, response.status);
    }
    if (response.status === 404 && code === "NoSuchBucket") throw new SyncError("config", "存储桶不存在", 404);
    throw new SyncError("http", `存储桶返回 ${response.status}${code ? ` ${code}` : ""}（${method} ${key}）`, response.status);
  }

  async get(key: string): Promise<{ body: Bytes; etag: string } | null> {
    const response = await this.send("GET", key);
    if (response.status === 404) {
      const code = s3ErrorCode(await response.text().catch(() => ""));
      if (code === "NoSuchBucket") throw new SyncError("config", "存储桶不存在", 404);
      return null;
    }
    if (!response.ok) return this.fail(response, "GET", key);
    return { body: new Uint8Array(await response.arrayBuffer()), etag: response.headers.get("etag") ?? "" };
  }

  async head(key: string): Promise<string | null> {
    const response = await this.send("HEAD", key);
    // AWS answers 403 instead of 404 for a missing key when the policy lacks s3:ListBucket.
    // Credentials were already proven by the config GET; a real auth problem fails on the PUT.
    if (response.status === 404 || response.status === 403) return null;
    if (!response.ok) return this.fail(response, "HEAD", key);
    return response.headers.get("etag") ?? "";
  }

  async put(key: string, body: Uint8Array, condition: PutCondition = {}): Promise<string> {
    const extra: Record<string, string> = { "content-type": "application/octet-stream" };
    if (condition.ifMatch) extra["if-match"] = condition.ifMatch;
    if (condition.ifNoneMatch) extra["if-none-match"] = condition.ifNoneMatch;
    const response = await this.send("PUT", key, body, extra);
    // 412 PreconditionFailed; S3 answers 409 ConditionalRequestConflict to racing conditional
    // writes, and 404 NoSuchKey to If-Match on a key that is gone.
    const conditional = Boolean(condition.ifMatch || condition.ifNoneMatch);
    if (response.status === 412 || (conditional && response.status === 409) || (condition.ifMatch && response.status === 404)) {
      await response.body?.cancel();
      throw new PreconditionFailed(key);
    }
    if (!response.ok) return this.fail(response, "PUT", key);
    await response.body?.cancel();
    return response.headers.get("etag") ?? "";
  }

  async delete(key: string): Promise<void> {
    const response = await this.send("DELETE", key);
    if (!response.ok && response.status !== 404) return this.fail(response, "DELETE", key);
    await response.body?.cancel();
  }
}
