// In-memory S3 for tests: a fetch() that speaks just enough of the S3 REST API
// (GET / HEAD / PUT / DELETE, ETag, If-Match / If-None-Match on PUT) to drive
// S3BlobStore end to end, signer included. Path-style URLs only.

import { type Bytes, sha256Hex } from "./bytes";
import type { FetchLike } from "./blobstore";

type Stored = { body: Bytes; etag: string };

export type RequestLog = { method: string; key: string; status: number };

export class MemoryS3 {
  readonly objects = new Map<string, Stored>();
  readonly log: RequestLog[] = [];
  /** Called before each request is handled; tests use it to inject races. */
  beforeRequest?: (method: string, key: string) => void | Promise<void>;
  /** Server clock; requests whose x-amz-date is more than 15 minutes off get RequestTimeTooSkewed. */
  now: () => number = () => Date.now();
  /** The key can read but not write (PUT / DELETE answer 403 AccessDenied). */
  readOnly = false;
  /** false = ignore If-Match / If-None-Match like a server without conditional writes. */
  conditionalWrites = true;
  private version = 0;

  constructor(readonly bucket = "offeru-test", readonly accessKeyId = "test-access-key") {}

  readonly fetch: FetchLike = async (input, init = {}) => {
    const url = new URL(input);
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    const parts = url.pathname.split("/").slice(1).map(decodeURIComponent);
    const bucket = parts.shift();
    const key = parts.join("/");
    await this.beforeRequest?.(method, key);
    const response = await this.handle(method, bucket, key, headers, init.body);
    response.headers.set("date", new Date(this.now()).toUTCString());
    this.log.push({ method, key, status: response.status });
    return response;
  };

  /** Requests whose key starts with `prefix` since the last reset (e.g. PUT objects/). */
  count(method: string, prefix = ""): number {
    return this.log.filter((entry) => entry.method === method && entry.key.startsWith(prefix) && entry.status < 300).length;
  }

  resetLog(): void {
    this.log.length = 0;
  }

  keys(prefix = ""): string[] {
    return [...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort();
  }

  private error(status: number, code: string): Response {
    return new Response(`<?xml version="1.0"?><Error><Code>${code}</Code></Error>`, { status, headers: { "content-type": "application/xml" } });
  }

  private async handle(method: string, bucket: string | undefined, key: string, headers: Headers, body: unknown): Promise<Response> {
    if (bucket !== this.bucket) return this.error(404, "NoSuchBucket");
    const auth = headers.get("authorization") ?? "";
    if (!auth.startsWith("AWS4-HMAC-SHA256 ") || !auth.includes(`Credential=${this.accessKeyId}/`)) return this.error(403, "AccessDenied");
    const stamp = headers.get("x-amz-date");
    if (!stamp) return this.error(403, "AccessDenied");
    const sent = Date.parse(stamp.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, "$1-$2-$3T$4:$5:$6Z"));
    if (Math.abs(sent - this.now()) > 15 * 60_000) return this.error(403, "RequestTimeTooSkewed");
    if (this.readOnly && (method === "PUT" || method === "DELETE")) return this.error(403, "AccessDenied");
    const existing = this.objects.get(key);

    if (method === "GET" || method === "HEAD") {
      if (!existing) return method === "HEAD" ? new Response(null, { status: 404 }) : this.error(404, "NoSuchKey");
      return new Response(method === "HEAD" ? null : existing.body.slice(), { status: 200, headers: { etag: existing.etag } });
    }
    if (method === "DELETE") {
      this.objects.delete(key);
      return new Response(null, { status: 204 });
    }
    if (method === "PUT") {
      const bytes = body instanceof Uint8Array ? new Uint8Array(body) as Bytes : new Uint8Array(0) as Bytes;
      if (headers.get("x-amz-content-sha256") !== await sha256Hex(bytes)) return this.error(400, "XAmzContentSHA256Mismatch");
      const ifNoneMatch = this.conditionalWrites ? headers.get("if-none-match") : null;
      const ifMatch = this.conditionalWrites ? headers.get("if-match") : null;
      if (ifNoneMatch === "*" && existing) return this.error(412, "PreconditionFailed");
      if (ifMatch && !existing) return this.error(404, "NoSuchKey");
      if (ifMatch && existing && existing.etag !== ifMatch) return this.error(412, "PreconditionFailed");
      this.version += 1;
      const etag = `"${(await sha256Hex(bytes)).slice(0, 24)}${this.version.toString(16).padStart(8, "0")}"`;
      this.objects.set(key, { body: bytes, etag });
      return new Response(null, { status: 200, headers: { etag } });
    }
    return this.error(405, "MethodNotAllowed");
  }
}
