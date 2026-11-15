// "测试连接": separate the things that usually go wrong when someone points
// OfferU at their own bucket, so the UI can say which one and how to fix it.
//
//   network  DNS / offline / wrong endpoint host
//   cors     (browser only) the bucket has no CORS rule for this origin, or does
//            not expose ETag
//   clock    SigV4 refuses requests more than 15 minutes off (RequestTimeTooSkewed)
//   auth     401/403: unknown key id, wrong secret, key not allowed on this bucket
//   bucket   NoSuchBucket / wrong region
//   write    the key can write (PUT + DELETE of a probe object under the prefix)
//   conditional  the server honours If-None-Match (needed for the lock and refs/latest)
//   repo     empty prefix (will be initialized) or an existing OfferU repo; with a
//            passphrase, whether it opens it
//
// Every check reads one or two responses; nothing outside <prefix>diagnostics/ is written.

import { fromUtf8, randomId, utf8 } from "./bytes";
import { type FetchLike, type S3Config, S3BlobStore, s3ErrorCode, validateS3Config } from "./blobstore";
import { deriveKeys, verifyKeyCheck } from "./crypto";
import { isSyncError } from "./errors";
import { CONFIG_KEY, type RepoConfig } from "./repo";

export type CheckId = "config" | "network" | "cors" | "clock" | "auth" | "bucket" | "write" | "conditional" | "repo";
export type CheckStatus = "ok" | "fail" | "warn" | "skip";
export type DiagnosisCheck = { id: CheckId; status: CheckStatus; detail: string; code?: string };

export type Diagnosis = {
  ok: boolean;
  checks: DiagnosisCheck[];
  /** empty = nothing under the prefix yet (first device); existing = an OfferU repo is there */
  repo: "empty" | "existing" | "unknown";
  passphrase: "ok" | "wrong" | "unchecked";
  /** server clock minus ours, when the server's Date header was readable */
  skewMs: number | null;
};

export const CHECK_TITLES: Record<CheckId, string> = {
  config: "填写",
  network: "网络 / DNS",
  cors: "浏览器跨域（CORS）",
  clock: "本机时间",
  auth: "密钥",
  bucket: "存储桶",
  write: "写入权限",
  conditional: "条件写",
  repo: "同步数据",
};

const SKEW_LIMIT_MS = 15 * 60_000;

export type DiagnoseOptions = {
  fetch?: FetchLike;
  /** running in a browser: fetch failures may be CORS, and a no-cors probe tells them apart */
  browser?: boolean;
  passphrase?: string;
  now?: () => number;
  /** default true; false skips the write / conditional probes */
  write?: boolean;
};

function causeText(error: unknown): string {
  const cause = (error as { cause?: { code?: string; message?: string } })?.cause;
  return [cause?.code, cause?.message, error instanceof Error ? error.message : String(error)].filter(Boolean).join(" ");
}

function authDetail(status: number, code: string): { check: CheckId; detail: string } {
  switch (code) {
    case "RequestTimeTooSkewed":
      return { check: "clock", detail: "本机时间和存储服务相差超过 15 分钟，签名被拒绝。把系统时间设成自动同步后再试。" };
    case "InvalidAccessKeyId":
      return { check: "auth", detail: "Access Key ID 不存在：检查有没有复制完整、是不是这个服务商的密钥。" };
    case "SignatureDoesNotMatch":
      return { check: "auth", detail: "签名不匹配：通常是 Secret Access Key 填错；区域或 Endpoint 和密钥不对应也会这样。" };
    case "AuthorizationHeaderMalformed":
      return { check: "bucket", detail: "区域不对：R2 填 auto，AWS 填存储桶所在区域（如 ap-east-1）。" };
    case "AccessDenied":
      return { check: "auth", detail: "密钥没有这个存储桶的权限：R2 选「Object Read & Write」并包含这个桶；AWS 给前缀下的 GetObject / PutObject / DeleteObject 和 ListBucket。" };
    default:
      return { check: "auth", detail: `存储桶拒绝访问（${status}${code ? ` ${code}` : ""}）：检查 Access Key、Secret 和权限范围。` };
  }
}

export async function diagnoseS3(config: S3Config, options: DiagnoseOptions = {}): Promise<Diagnosis> {
  const now = options.now ?? (() => Date.now());
  const checks: DiagnosisCheck[] = [];
  const out: Diagnosis = { ok: false, checks, repo: "unknown", passphrase: "unchecked", skewMs: null };
  const add = (id: CheckId, status: CheckStatus, detail: string, code?: string) => {
    checks.push({ id, status, detail, ...(code ? { code } : {}) });
  };
  const done = () => {
    out.ok = checks.every((check) => check.status !== "fail");
    return out;
  };

  let blobs: S3BlobStore;
  try {
    validateS3Config(config);
    blobs = new S3BlobStore(config, options.fetch);
  } catch (error) {
    add("config", "fail", error instanceof Error ? error.message : String(error));
    return done();
  }
  const fetchImpl = options.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init));

  // 1. One signed GET of the repo config: answers network, CORS, clock, auth, bucket and repo at once.
  let response: Response;
  try {
    response = await blobs.rawRequest("GET", CONFIG_KEY);
  } catch (error) {
    if (options.browser) {
      // A signed cross-origin request that throws is either unreachable or blocked by CORS.
      // A no-cors request carries no custom headers, needs no preflight, and only fails when the host is unreachable.
      let reachable = false;
      try {
        await fetchImpl(new URL(blobs.baseUrl).origin + "/", { method: "GET", mode: "no-cors" } as RequestInit);
        reachable = true;
      } catch {
        reachable = false;
      }
      if (reachable) {
        add("network", "ok", "能连上存储服务。");
        add("cors", "fail", "浏览器拦下了请求：存储桶还没有允许这个网页访问。把下面的 CORS 规则粘到存储桶设置里，保存后再测。", "cors_blocked");
      } else {
        add("network", "fail", "连不上 Endpoint：检查网址拼写（R2 是 https://<账户ID>.r2.cloudflarestorage.com）、网络或代理。");
      }
      return done();
    }
    const text = causeText(error);
    const dns = /ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(text);
    add("network", "fail", dns
      ? "域名解析失败：Endpoint 的主机名不存在，检查拼写和账户 ID。"
      : `连不上 Endpoint（${text || "网络错误"}）：检查网址、端口、网络或代理。`, dns ? "dns" : "network");
    return done();
  }
  add("network", "ok", "能连上存储服务。");
  if (options.browser) add("cors", "ok", "浏览器可以直接访问这个存储桶。");

  const dateHeader = response.headers.get("date");
  if (dateHeader && !Number.isNaN(Date.parse(dateHeader))) out.skewMs = Date.parse(dateHeader) - now();
  const text = response.ok ? "" : await response.text().catch(() => "");
  const code = s3ErrorCode(text);

  const clockBad = code === "RequestTimeTooSkewed" || (out.skewMs !== null && Math.abs(out.skewMs) > SKEW_LIMIT_MS);
  if (clockBad) {
    const minutes = out.skewMs !== null ? `（相差约 ${Math.round(Math.abs(out.skewMs) / 60_000)} 分钟）` : "";
    add("clock", "fail", `本机时间和存储服务相差超过 15 分钟${minutes}，签名会被拒绝。把系统时间设成自动同步后再试。`, "skew");
    return done();
  }
  add("clock", "ok", out.skewMs !== null ? `时间误差 ${Math.round(Math.abs(out.skewMs) / 1000)} 秒，没问题。` : "签名时间被接受。");

  if (response.status === 404 && code === "NoSuchBucket") {
    add("auth", "ok", "密钥有效。");
    add("bucket", "fail", `存储桶「${config.bucket}」不存在：先在控制台创建，或检查名字和 Endpoint 的账户是否一致。`, "NoSuchBucket");
    return done();
  }
  if (response.status === 301 || code === "PermanentRedirect" || code === "AuthorizationHeaderMalformed") {
    add("auth", "ok", "密钥有效。");
    add("bucket", "fail", "区域不对：R2 填 auto，AWS 填存储桶所在区域，或打开 / 关闭路径风格地址再试。", code || "redirect");
    return done();
  }
  if (response.status === 401 || response.status === 403) {
    const mapped = authDetail(response.status, code);
    add(mapped.check, "fail", mapped.detail, code || String(response.status));
    return done();
  }
  if (!response.ok && response.status !== 404) {
    add("bucket", "fail", `存储桶返回 ${response.status}${code ? ` ${code}` : ""}，不像 S3 兼容接口：检查 Endpoint。`, code || String(response.status));
    return done();
  }
  add("auth", "ok", "密钥有效，可以读取。");
  add("bucket", "ok", `存储桶「${config.bucket}」存在。`);

  let repoConfig: RepoConfig | null = null;
  if (response.ok) {
    try {
      repoConfig = JSON.parse(fromUtf8(new Uint8Array(await response.arrayBuffer()))) as RepoConfig;
    } catch {
      repoConfig = null;
    }
  }

  // 2. Write probe: PUT a throwaway object twice with If-None-Match: *, then delete it.
  if (options.write !== false) {
    const key = `diagnostics/${randomId(8)}`;
    try {
      const first = await blobs.rawRequest("PUT", key, utf8("offeru diagnostics"), { "content-type": "text/plain", "if-none-match": "*" });
      const etag = first.headers.get("etag");
      if (!first.ok) {
        const putCode = s3ErrorCode(await first.text().catch(() => ""));
        add("write", "fail", first.status === 403
          ? "密钥是只读的：同步需要写入（R2 选「Object Read & Write」，AWS 给 PutObject / DeleteObject）。"
          : `写入失败（${first.status}${putCode ? ` ${putCode}` : ""}）。`, putCode || String(first.status));
        return done();
      }
      if (!etag) {
        add("write", "fail", options.browser
          ? "能写入，但浏览器读不到 ETag：CORS 规则里要有 \"ExposeHeaders\": [\"ETag\"]。"
          : "能写入，但服务没有返回 ETag，无法安全地做多设备同步。", "etag_hidden");
        await blobs.rawRequest("DELETE", key).catch(() => undefined);
        return done();
      }
      add("write", "ok", "可以写入和删除。");
      const second = await blobs.rawRequest("PUT", key, utf8("offeru diagnostics"), { "content-type": "text/plain", "if-none-match": "*" });
      await second.body?.cancel();
      if (second.status === 412 || second.status === 409) add("conditional", "ok", "支持条件写，多台设备同时同步不会互相覆盖。");
      else add("conditional", "warn", "这个服务忽略了 If-None-Match：多台设备同时同步可能互相覆盖。只用一台设备同步，或换 R2 / S3 / MinIO。", "no_conditional");
      const removed = await blobs.rawRequest("DELETE", key);
      await removed.body?.cancel();
      if (!removed.ok && removed.status !== 404) {
        checks[checks.findIndex((check) => check.id === "write")] = { id: "write", status: "warn", detail: `可以写入，但删除被拒绝（${removed.status}）：桶里会留下 ${key}，可以手动删。` };
      }
    } catch (error) {
      if (options.browser) {
        add("cors", "fail", "读取可以，但写入被浏览器拦下：CORS 规则的 AllowedMethods 要有 PUT / DELETE，AllowedHeaders 要有 if-match / if-none-match。", "cors_write");
        checks.splice(checks.findIndex((check) => check.id === "cors"), 1);
        return done();
      }
      add("write", "fail", `写入时连接中断：${causeText(error)}`);
      return done();
    }
  }

  // 3. What is under the prefix, and does the passphrase open it.
  if (!response.ok) {
    out.repo = "empty";
    add("repo", "ok", "这个前缀下还没有同步数据：第一次连接会用你的口令初始化。");
    return done();
  }
  if (!repoConfig || repoConfig.format !== "offeru-sync") {
    add("repo", "fail", `前缀下的 ${CONFIG_KEY} 不是 OfferU 同步配置：换一个前缀。`, "format");
    return done();
  }
  out.repo = "existing";
  if (!options.passphrase) {
    add("repo", "ok", "这里已经有 OfferU 同步数据：用当初设置的同步口令连接。");
    return done();
  }
  try {
    await verifyKeyCheck(await deriveKeys(options.passphrase, repoConfig.kdf), repoConfig.check);
    out.passphrase = "ok";
    add("repo", "ok", "已有同步数据，口令正确。");
  } catch (error) {
    if (!isSyncError(error)) throw error;
    out.passphrase = "wrong";
    add("repo", "fail", "已有同步数据，但口令不对：要用第一台设备设置的同步口令。", "passphrase");
  }
  return done();
}
