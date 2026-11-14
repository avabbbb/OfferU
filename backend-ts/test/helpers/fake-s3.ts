// In-memory S3 for sync tests: path-style GET/PUT/DELETE/ListObjectsV2,
// ETags, If-Match / If-None-Match (412), SigV4 verification (403 on a bad
// signature), and fault injection to simulate an interrupted upload.

import { signRequest, type S3Fetch } from "@offeru/core";

type Stored = { body: Uint8Array; etag: string; lastModified: Date };

export class FakeS3 {
  readonly objects = new Map<string, Stored>();
  readonly log: Array<{ method: string; key: string; status: number }> = [];
  /** Throw a network error on the Nth PUT from now (1-based); 0 = never. */
  failOnPut = 0;
  /** Run before a PUT is applied (lets a test slip in a concurrent write). */
  beforePut: ((key: string) => Promise<void> | void) | null = null;
  pageSize = 1000;
  clock: () => Date = () => new Date();
  private counter = 0;

  constructor(readonly bucket = "offeru-test", readonly credentials = { accessKeyId: "AKTEST", secretAccessKey: "secret-test", region: "auto" }) {}

  putCount(prefix: string): number {
    return this.log.filter((entry) => entry.method === "PUT" && entry.status === 200 && entry.key.startsWith(prefix)).length;
  }

  keys(prefix = ""): string[] {
    return [...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort();
  }

  /** Age every object (for GC grace tests). */
  age(ms: number): void {
    for (const value of this.objects.values()) value.lastModified = new Date(value.lastModified.getTime() - ms);
  }

  fetch: S3Fetch = async (url, init) => {
    const parsed = new URL(url);
    const [, bucket, ...rest] = parsed.pathname.split("/");
    const key = rest.map(decodeURIComponent).join("/");
    const respond = (status: number, body: string | Uint8Array = "", headers: Record<string, string> = {}) => {
      this.log.push({ method: init.method, key, status });
      const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
      return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
        arrayBuffer: async () => bytes.slice().buffer as ArrayBuffer,
        text: async () => new TextDecoder().decode(bytes),
      };
    };

    if (!(await this.verify(url, init))) return respond(403, "<Error><Code>SignatureDoesNotMatch</Code></Error>");
    if (decodeURIComponent(bucket) !== this.bucket) return respond(404, "<Error><Code>NoSuchBucket</Code></Error>");

    if (init.method === "GET" && parsed.searchParams.get("list-type") === "2") {
      const prefix = parsed.searchParams.get("prefix") ?? "";
      const all = this.keys(prefix);
      const start = Number(parsed.searchParams.get("continuation-token") ?? 0);
      const page = all.slice(start, start + this.pageSize);
      const truncated = start + this.pageSize < all.length;
      const xml = `<?xml version="1.0"?><ListBucketResult><IsTruncated>${truncated}</IsTruncated>${page.map((k) => {
        const o = this.objects.get(k)!;
        return `<Contents><Key>${k.replace(/&/g, "&amp;")}</Key><LastModified>${o.lastModified.toISOString()}</LastModified><ETag>&quot;${o.etag}&quot;</ETag><Size>${o.body.length}</Size></Contents>`;
      }).join("")}${truncated ? `<NextContinuationToken>${start + this.pageSize}</NextContinuationToken>` : ""}</ListBucketResult>`;
      return respond(200, xml);
    }

    const current = this.objects.get(key);
    if (init.method === "GET") {
      if (!current) return respond(404, "<Error><Code>NoSuchKey</Code></Error>");
      return respond(200, current.body, { etag: `"${current.etag}"` });
    }
    if (init.method === "DELETE") {
      this.objects.delete(key);
      return respond(204);
    }
    if (init.method === "PUT") {
      if (this.failOnPut > 0) {
        this.failOnPut -= 1;
        if (this.failOnPut === 0) {
          this.log.push({ method: "PUT", key, status: 0 });
          throw new TypeError("network connection lost");
        }
      }
      await this.beforePut?.(key);
      const latest = this.objects.get(key);
      const ifMatch = init.headers["if-match"];
      const ifNoneMatch = init.headers["if-none-match"];
      if (ifNoneMatch === "*" && latest) return respond(412, "<Error><Code>PreconditionFailed</Code></Error>");
      if (ifMatch && (!latest || (ifMatch !== "*" && ifMatch.replace(/"/g, "") !== latest.etag))) {
        return respond(412, "<Error><Code>PreconditionFailed</Code></Error>");
      }
      this.counter += 1;
      const etag = `etag-${this.counter}`;
      this.objects.set(key, { body: init.body ? init.body.slice() : new Uint8Array(), etag, lastModified: this.clock() });
      return respond(200, "", { etag: `"${etag}"` });
    }
    return respond(405);
  };

  private async verify(url: string, init: { method: string; headers: Record<string, string>; body?: Uint8Array }): Promise<boolean> {
    const auth = init.headers.authorization ?? "";
    const stamp = init.headers["x-amz-date"];
    if (!auth.startsWith(`AWS4-HMAC-SHA256 Credential=${this.credentials.accessKeyId}/`) || !stamp) return false;
    const date = new Date(`${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`);
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(init.headers)) {
      if (!["authorization", "x-amz-date", "x-amz-content-sha256"].includes(name)) headers[name] = value;
    }
    const expected = await signRequest(this.credentials, { method: init.method, url, headers, body: init.body, date });
    return expected.authorization === auth;
  }
}
