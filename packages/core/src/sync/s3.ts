// Minimal S3 client: GET / PUT (with If-Match / If-None-Match) / DELETE / ListObjectsV2.
// Talks to any S3-compatible endpoint (Cloudflare R2, AWS S3, MinIO, OSS/COS in
// S3 mode) through an injected fetch, so it runs in the browser too (the
// bucket then needs a CORS rule; see docs/sync.md).

import { CoreError } from "../types";
import { signRequest, uriEncode, type S3Credentials } from "./sigv4";

export type S3Fetch = (url: string, init: {
  method: string;
  headers: Record<string, string>;
  body?: Uint8Array;
}) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}>;

export type S3Location = {
  /** e.g. https://<account>.r2.cloudflarestorage.com, https://s3.us-east-1.amazonaws.com, http://127.0.0.1:9000 */
  endpoint: string;
  bucket: string;
  /** Path-style (endpoint/bucket/key). Default true: R2 and MinIO accept it, it avoids TLS issues with dotted bucket names. */
  forcePathStyle?: boolean;
};

export type S3ClientConfig = S3Location & S3Credentials & { fetch: S3Fetch };

export type S3Object = { body: Uint8Array; etag: string | null };
export type S3ListItem = { key: string; etag: string | null; size: number; lastModified: string };

/** A conditional write lost the race: someone else wrote first. */
export class PreconditionFailed extends Error {
  constructor() {
    super("precondition failed");
    this.name = "PreconditionFailed";
  }
}

export class S3Client {
  constructor(private readonly config: S3ClientConfig) {}

  url(key: string, query?: Record<string, string>): string {
    const endpoint = this.config.endpoint.replace(/\/+$/, "");
    const encodedKey = uriEncode(key, true);
    let base: string;
    if (this.config.forcePathStyle === false) {
      const parsed = new URL(endpoint);
      base = `${parsed.protocol}//${this.config.bucket}.${parsed.host}${parsed.pathname.replace(/\/+$/, "")}/${encodedKey}`;
    } else {
      base = `${endpoint}/${uriEncode(this.config.bucket)}/${encodedKey}`;
    }
    if (!query) return base;
    const search = Object.entries(query).map(([k, v]) => `${uriEncode(k)}=${uriEncode(v)}`).join("&");
    return `${base}?${search}`;
  }

  private async send(method: string, key: string, options: { headers?: Record<string, string>; body?: Uint8Array; query?: Record<string, string> } = {}) {
    const url = this.url(key, options.query);
    const headers = await signRequest(this.config, { method, url, headers: options.headers, body: options.body });
    try {
      return await this.config.fetch(url, { method, headers, body: options.body });
    } catch (cause) {
      throw new CoreError(
        `连不上 S3（${new URL(url).host}）：检查 endpoint、网络，浏览器里直连还需要桶的 CORS 规则。${cause instanceof Error ? cause.message : ""}`.trim(),
        "invalid",
      );
    }
  }

  private async fail(response: Awaited<ReturnType<S3Fetch>>, what: string): Promise<never> {
    const body = await response.text().catch(() => "");
    const code = /<Code>([^<]+)<\/Code>/.exec(body)?.[1] ?? "";
    if (response.status === 401 || response.status === 403) {
      throw new CoreError(`S3 拒绝了请求（${what}，HTTP ${response.status}${code ? ` ${code}` : ""}）：检查 Access Key、Secret 和桶权限`, "forbidden");
    }
    if (response.status === 404 && code === "NoSuchBucket") throw new CoreError("S3 桶不存在：检查 bucket 名称和 endpoint", "invalid");
    throw new CoreError(`S3 ${what} 失败（HTTP ${response.status}${code ? ` ${code}` : ""}）`, "invalid");
  }

  /** null when the key does not exist. */
  async get(key: string): Promise<S3Object | null> {
    const response = await this.send("GET", key);
    if (response.status === 404) return null;
    if (!response.ok) return this.fail(response, `读取 ${key}`);
    return { body: new Uint8Array(await response.arrayBuffer()), etag: response.headers.get("etag") };
  }

  /**
   * PUT. `ifMatch` = overwrite only that version; `ifNoneMatch: true` = create only.
   * Throws PreconditionFailed when the condition does not hold.
   */
  async put(key: string, body: Uint8Array, options: { ifMatch?: string; ifNoneMatch?: boolean; contentType?: string } = {}): Promise<string | null> {
    const headers: Record<string, string> = { "content-type": options.contentType ?? "application/octet-stream" };
    if (options.ifMatch) headers["if-match"] = options.ifMatch;
    if (options.ifNoneMatch) headers["if-none-match"] = "*";
    const response = await this.send("PUT", key, { headers, body });
    if (response.status === 412 || response.status === 409) throw new PreconditionFailed();
    if (!response.ok) return this.fail(response, `写入 ${key}`);
    return response.headers.get("etag");
  }

  async delete(key: string): Promise<void> {
    const response = await this.send("DELETE", key);
    if (!response.ok && response.status !== 404) await this.fail(response, `删除 ${key}`);
  }

  /** ListObjectsV2 over every page. */
  async list(prefix: string): Promise<S3ListItem[]> {
    const items: S3ListItem[] = [];
    let token: string | undefined;
    for (;;) {
      const query: Record<string, string> = { "list-type": "2", prefix };
      if (token) query["continuation-token"] = token;
      const response = await this.send("GET", "", { query });
      if (!response.ok) await this.fail(response, `列出 ${prefix}`);
      const xml = await response.text();
      for (const block of xml.match(/<Contents>[\s\S]*?<\/Contents>/g) ?? []) {
        const field = (name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(block)?.[1] ?? "";
        items.push({ key: xmlDecode(field("Key")), etag: xmlDecode(field("ETag")) || null, size: Number(field("Size") || 0), lastModified: field("LastModified") });
      }
      const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
      token = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1];
      if (!truncated || !token) return items;
      token = xmlDecode(token);
    }
  }
}

function xmlDecode(text: string): string {
  return text
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, "&");
}
