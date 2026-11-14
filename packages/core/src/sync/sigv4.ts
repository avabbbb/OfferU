// AWS Signature Version 4 for S3-compatible stores, over WebCrypto only.
// No SDK: runs in the browser, Cloudflare Workers, and Node alike.

import { hex, hmacRaw, sha256Hex, utf8 } from "./bytes";

export type S3Credentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** "auto" for Cloudflare R2; e.g. "us-east-1" for AWS. */
  region: string;
  service?: string;
};

export type SignInput = {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: Uint8Array;
  /** Override the payload hash (e.g. "UNSIGNED-PAYLOAD"). Default: SHA-256 of body. */
  payloadHash?: string;
  /** For tests; default now. */
  date?: Date;
};

/** RFC 3986 encoding as SigV4 wants it (unreserved chars stay, everything else %XX). */
export function uriEncode(value: string, keepSlash = false): string {
  let out = "";
  for (const byte of utf8(value)) {
    const ch = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-_.~]/.test(ch) || (keepSlash && ch === "/")) out += ch;
    else out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

function amzDate(date: Date): { stamp: string; day: string } {
  const stamp = date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return { stamp, day: stamp.slice(0, 8) };
}

/**
 * Returns the headers to send (lower-case names). `host` is signed but not
 * returned, because fetch sets it itself and browsers forbid setting it.
 */
export async function signRequest(credentials: S3Credentials, input: SignInput): Promise<Record<string, string>> {
  const url = new URL(input.url);
  const { stamp, day } = amzDate(input.date ?? new Date());
  const payloadHash = input.payloadHash ?? await sha256Hex(input.body ?? new Uint8Array());
  const service = credentials.service ?? "s3";

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.headers ?? {})) headers[name.toLowerCase()] = String(value).trim().replace(/\s+/g, " ");
  headers["x-amz-date"] = stamp;
  headers["x-amz-content-sha256"] = payloadHash;
  if (credentials.sessionToken) headers["x-amz-security-token"] = credentials.sessionToken;

  const signed: Record<string, string> = { ...headers, host: url.host };
  const names = Object.keys(signed).sort();
  const canonicalHeaders = names.map((name) => `${name}:${signed[name]}\n`).join("");
  const signedHeaders = names.join(";");

  // url.pathname is already percent-encoded by URL; decode then re-encode per segment.
  const path = url.pathname.split("/").map((segment) => uriEncode(decodeURIComponent(segment))).join("/") || "/";
  const query = [...url.searchParams.entries()]
    .map(([key, value]) => [uriEncode(key), uriEncode(value)] as const)
    .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");

  const canonicalRequest = [input.method.toUpperCase(), path, query, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${day}/${credentials.region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", stamp, scope, await sha256Hex(utf8(canonicalRequest))].join("\n");

  let key = await hmacRaw(utf8(`AWS4${credentials.secretAccessKey}`), utf8(day));
  key = await hmacRaw(key, utf8(credentials.region));
  key = await hmacRaw(key, utf8(service));
  key = await hmacRaw(key, utf8("aws4_request"));
  const signature = hex(await hmacRaw(key, utf8(stringToSign)));

  headers.authorization = `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return headers;
}
