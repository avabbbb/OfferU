// Minimal AWS Signature Version 4 for S3-compatible endpoints (AWS S3,
// Cloudflare R2, MinIO, ...). WebCrypto only, so it runs in browsers and Workers.

import { type Bytes, copy, toHex, utf8 } from "./bytes";

export type SigV4Credentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region: string;
  service?: string;
};

/** RFC 3986 encoding as S3 expects for each path segment / query component. */
export function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

async function hmac(key: Uint8Array, data: string): Promise<Bytes> {
  const imported = await crypto.subtle.importKey("raw", copy(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", imported, utf8(data)));
}

async function sha256(data: Uint8Array): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", copy(data))));
}

function amzDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

/**
 * Returns the headers to send (x-amz-date, x-amz-content-sha256, authorization,
 * plus the caller's). `host` is signed but not returned: browsers forbid
 * setting it and fetch derives the same value from the URL.
 */
export async function signRequest(input: {
  method: string;
  url: URL;
  headers?: Record<string, string>;
  body?: Uint8Array;
  credentials: SigV4Credentials;
  date?: Date;
}): Promise<Record<string, string>> {
  const { method, url, credentials } = input;
  const service = credentials.service ?? "s3";
  const stamp = amzDate(input.date ?? new Date());
  const day = stamp.slice(0, 8);
  const payloadHash = await sha256(input.body ?? new Uint8Array(0));

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.headers ?? {})) headers[name.toLowerCase()] = value;
  headers["x-amz-date"] = stamp;
  headers["x-amz-content-sha256"] = payloadHash;
  if (credentials.sessionToken) headers["x-amz-security-token"] = credentials.sessionToken;

  const signed: Record<string, string> = { ...headers, host: url.host };
  const names = Object.keys(signed).sort();
  const canonicalHeaders = names.map((name) => `${name}:${signed[name].trim().replace(/\s+/g, " ")}\n`).join("");
  const signedHeaders = names.join(";");
  const query = [...url.searchParams.entries()]
    .map(([key, value]) => [encodeRfc3986(key), encodeRfc3986(value)] as const)
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  // url.pathname is already percent-encoded by the caller (one pass, S3 style).
  const canonicalRequest = [method.toUpperCase(), url.pathname || "/", query, canonicalHeaders, signedHeaders, payloadHash].join("\n");

  const scope = `${day}/${credentials.region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", stamp, scope, await sha256(utf8(canonicalRequest))].join("\n");
  let key = await hmac(utf8(`AWS4${credentials.secretAccessKey}`), day);
  key = await hmac(key, credentials.region);
  key = await hmac(key, service);
  key = await hmac(key, "aws4_request");
  const signature = toHex(await hmac(key, stringToSign));

  headers.authorization = `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return headers;
}
