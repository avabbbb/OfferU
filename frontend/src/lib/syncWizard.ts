// 云同步设置向导的纯逻辑（无 React、无网络）：服务商预设、R2 账户 ID → Endpoint、
// 连接码、CORS 规则、错误码 → 中文说明、向导步骤。组件只渲染这里的状态。

import type { CheckId, CheckStatus, Diagnosis } from "@offeru/sync";

export type SyncProvider = "r2" | "s3" | "minio" | "other";

export type SyncForm = {
  provider: SyncProvider;
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix: string;
  pathStyle: boolean;
  passphrase: string;
  /** 浏览器里：用本机设备密钥加密记住 Secret 和口令；关掉 = 只存在本次会话 */
  remember: boolean;
};

export type ProviderPreset = {
  id: SyncProvider;
  label: string;
  description: string;
  endpoint: string;
  endpointHint: string;
  region: string;
  regionHint: string;
  pathStyle: boolean;
  /** 哪里建密钥 / 粘 CORS */
  keyHelp: string;
  corsWhere: string;
};

export const PROVIDERS: ProviderPreset[] = [
  {
    id: "r2",
    label: "Cloudflare R2",
    description: "免出站流量费，有免费额度",
    endpoint: "",
    endpointHint: "填账户 ID 自动生成：https://<账户ID>.r2.cloudflarestorage.com",
    region: "auto",
    regionHint: "R2 固定填 auto",
    pathStyle: true,
    keyHelp: "R2 › Manage API tokens › Create API token，权限选 Object Read & Write，并只勾选这个存储桶。",
    corsWhere: "R2 › 你的存储桶 › Settings › CORS Policy › Add CORS policy",
  },
  {
    id: "s3",
    label: "AWS S3",
    description: "Endpoint 留空，填存储桶所在区域",
    endpoint: "",
    endpointHint: "AWS 留空即可（自动用 s3.<区域>.amazonaws.com）",
    region: "us-east-1",
    regionHint: "存储桶所在区域，例如 ap-east-1、us-east-1",
    pathStyle: false,
    keyHelp: "IAM 用户只给这个桶前缀下的 GetObject / PutObject / DeleteObject，再加限定前缀的 ListBucket。",
    corsWhere: "S3 › 你的存储桶 › Permissions › Cross-origin resource sharing (CORS) › Edit",
  },
  {
    id: "minio",
    label: "MinIO",
    description: "自建，适合 NAS / 家里的服务器",
    endpoint: "http://127.0.0.1:9000",
    endpointHint: "MinIO 的 S3 API 地址（不是 9001 控制台端口）",
    region: "us-east-1",
    regionHint: "随意，常用 us-east-1",
    pathStyle: true,
    keyHelp: "MinIO 控制台 › Access Keys › Create，策略只允许这个桶。",
    corsWhere: "MinIO：mc admin config set <别名> api cors_allow_origin=\"<下面的来源>\"",
  },
  {
    id: "other",
    label: "其他 S3 兼容",
    description: "需要支持 SigV4 和条件写（If-Match）",
    endpoint: "",
    endpointHint: "服务商文档里的 S3 API Endpoint",
    region: "auto",
    regionHint: "按服务商文档填写",
    pathStyle: true,
    keyHelp: "建一个只能读写这个桶的 Access Key。",
    corsWhere: "服务商控制台里存储桶的 CORS 设置",
  },
];

export function preset(id: SyncProvider): ProviderPreset {
  return PROVIDERS.find((item) => item.id === id) ?? PROVIDERS[3];
}

export const EMPTY_SYNC_FORM: SyncForm = {
  provider: "r2", endpoint: "", bucket: "", region: "auto", accessKeyId: "", secretAccessKey: "", prefix: "offeru", pathStyle: true, passphrase: "", remember: true,
};

/** 切服务商：只覆盖和服务商有关的字段，存储桶 / 前缀 / 密钥不动。 */
export function applyProvider(form: SyncForm, id: SyncProvider): SyncForm {
  const next = preset(id);
  return { ...form, provider: id, endpoint: next.endpoint, region: next.region, pathStyle: next.pathStyle };
}

const R2_ACCOUNT = /^[0-9a-f]{32}$/i;

/**
 * R2 账户 ID → Endpoint。也接受直接粘贴 R2 控制台的「S3 API」地址
 * （https://<id>.r2.cloudflarestorage.com/<bucket>，可能带 .eu 管辖区），顺带取出存储桶名。
 */
export function r2FromInput(input: string): { endpoint: string; accountId: string; bucket?: string } | null {
  const value = input.trim();
  if (R2_ACCOUNT.test(value)) return { accountId: value.toLowerCase(), endpoint: `https://${value.toLowerCase()}.r2.cloudflarestorage.com` };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const match = /^([0-9a-f]{32})((?:\.[a-z]+)?)\.r2\.cloudflarestorage\.com$/i.exec(url.hostname);
  if (!match) return null;
  const accountId = match[1].toLowerCase();
  const bucket = url.pathname.split("/").filter(Boolean)[0];
  return { accountId, endpoint: `https://${accountId}${match[2].toLowerCase()}.r2.cloudflarestorage.com`, ...(bucket ? { bucket } : {}) };
}

// ---- 连接码：只含找到存储桶所需的非机密信息 ----

const LINK_PREFIX = "offeru-sync:";

type LinkPayload = { v: 1; p: SyncProvider; e: string; b: string; r: string; x: string; s: boolean };

function base64url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unbase64url(text: string): string {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
  const binary = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

/** Endpoint + 存储桶 + 区域 + 前缀 + 路径风格。永远不含 Access Key、Secret、口令。 */
export function encodeLinkCode(config: Pick<SyncForm, "provider" | "endpoint" | "bucket" | "region" | "prefix" | "pathStyle">): string {
  const payload: LinkPayload = { v: 1, p: config.provider, e: config.endpoint, b: config.bucket, r: config.region, x: config.prefix, s: config.pathStyle };
  return LINK_PREFIX + base64url(JSON.stringify(payload));
}

export function decodeLinkCode(code: string): Pick<SyncForm, "provider" | "endpoint" | "bucket" | "region" | "prefix" | "pathStyle"> {
  const trimmed = code.trim();
  if (!trimmed.startsWith(LINK_PREFIX)) throw new Error("这不是 OfferU 连接码：应以 offeru-sync: 开头");
  let payload: LinkPayload;
  try {
    payload = JSON.parse(unbase64url(trimmed.slice(LINK_PREFIX.length))) as LinkPayload;
  } catch {
    throw new Error("连接码不完整：请整段复制");
  }
  if (payload.v !== 1 || typeof payload.b !== "string" || !payload.b) throw new Error("连接码版本不支持，请先升级 OfferU");
  return {
    provider: PROVIDERS.some((item) => item.id === payload.p) ? payload.p : "other",
    endpoint: String(payload.e ?? ""),
    bucket: payload.b,
    region: String(payload.r || "auto"),
    prefix: String(payload.x || "offeru"),
    pathStyle: Boolean(payload.s),
  };
}

// ---- CORS ----

export const CORS_METHODS = ["GET", "PUT", "HEAD", "DELETE"];
export const CORS_HEADERS = ["authorization", "content-type", "x-amz-date", "x-amz-content-sha256", "x-amz-security-token", "if-match", "if-none-match"];

/** R2 和 S3 控制台都接受的 CORS JSON（数组形式），来源只放实际打开 OfferU 的地址。 */
export function corsPolicy(origins: string[]): string {
  const unique = [...new Set(origins.map((origin) => origin.trim().replace(/\/+$/, "")).filter(Boolean))];
  return JSON.stringify([{
    AllowedOrigins: unique,
    AllowedMethods: CORS_METHODS,
    AllowedHeaders: CORS_HEADERS,
    ExposeHeaders: ["ETag"],
    MaxAgeSeconds: 3600,
  }], null, 2);
}

// ---- 错误码 → 说明 ----

const ERROR_TITLES: Record<string, string> = {
  sync_config: "设置不完整",
  sync_passphrase: "同步口令不对",
  sync_auth: "存储桶拒绝访问",
  sync_network: "连不上存储桶",
  sync_http: "存储服务返回了意外的错误",
  sync_locked: "另一台设备正在同步",
  sync_conflict: "其他设备同时在同步",
  sync_format: "数据格式不对",
  sync_decrypt: "数据校验失败",
  unsupported: "当前后端不支持同步",
};

const ERROR_HINTS: Record<string, string> = {
  sync_passphrase: "要用第一台设备设置的同步口令（备份文件则是导出时设置的口令）。",
  sync_auth: "检查 Access Key、Secret 和权限范围；点「测试连接」能看出具体是哪一项。",
  sync_network: "检查网络和 Endpoint；网页版还需要给存储桶配置 CORS。点「测试连接」能看出是哪一层。",
  sync_locked: "等一两分钟再点「立即同步」；锁会自动过期。",
  sync_conflict: "稍后再试一次。",
  sync_format: "这个前缀下可能不是 OfferU 的数据，或数据来自更新版本的 OfferU。",
  sync_decrypt: "桶里的对象被改动或损坏，不要手动编辑存储桶里的文件。",
  unsupported: "需要用 TS 后端（backend-ts）或网页版启动 OfferU。",
};

export function describeSyncError(code: string | undefined, detail: string): { title: string; hint: string; detail: string } {
  const key = code ?? "";
  return { title: ERROR_TITLES[key] ?? "同步失败", hint: ERROR_HINTS[key] ?? "", detail };
}

export const CHECK_ORDER: CheckId[] = ["config", "network", "cors", "clock", "auth", "bucket", "write", "conditional", "repo"];

export function checkTone(status: CheckStatus): "green" | "red" | "yellow" | "gray" {
  return status === "ok" ? "green" : status === "fail" ? "red" : status === "warn" ? "yellow" : "gray";
}

/** 第一个失败的检查；CORS 失败时界面要展示 CORS 规则。 */
export function firstFailure(diagnosis: Diagnosis | null) {
  return diagnosis?.checks.find((check) => check.status === "fail") ?? null;
}

export function needsCorsHelp(diagnosis: Diagnosis | null): boolean {
  return Boolean(diagnosis?.checks.some((check) => (check.id === "cors" && check.status === "fail") || check.code === "etag_hidden"));
}

// ---- 向导 ----

export type WizardStep = "provider" | "bucket" | "keys" | "test" | "passphrase";
export const WIZARD_STEPS: { id: WizardStep; label: string }[] = [
  { id: "provider", label: "服务商" },
  { id: "bucket", label: "存储桶" },
  { id: "keys", label: "密钥" },
  { id: "test", label: "测试连接" },
  { id: "passphrase", label: "同步口令" },
];

export type WizardState = {
  step: WizardStep;
  form: SyncForm;
  accountId: string;
  diagnosis: Diagnosis | null;
  confirm: string;
  /** 已保存过（编辑模式）：Secret / 口令留空表示沿用 */
  editing: boolean;
};

export type WizardAction =
  | { type: "provider"; provider: SyncProvider }
  | { type: "field"; key: keyof SyncForm; value: SyncForm[keyof SyncForm] }
  | { type: "account"; value: string }
  | { type: "link"; code: string }
  | { type: "tested"; diagnosis: Diagnosis | null }
  | { type: "confirm"; value: string }
  | { type: "go"; step: WizardStep }
  | { type: "next" }
  | { type: "back" };

export function initialWizard(saved?: Partial<SyncForm> | null): WizardState {
  const editing = Boolean(saved?.bucket);
  return {
    step: editing ? "bucket" : "provider",
    form: { ...EMPTY_SYNC_FORM, ...(saved ?? {}), secretAccessKey: "", passphrase: "", accessKeyId: editing ? "" : saved?.accessKeyId ?? "" },
    accountId: "",
    diagnosis: null,
    confirm: "",
    editing,
  };
}

const ORDER = WIZARD_STEPS.map((step) => step.id);

/** 当前步能否继续；不能时给出一句原因（显示在按钮旁）。 */
export function canAdvance(state: WizardState): { ok: boolean; reason?: string } {
  const { form } = state;
  switch (state.step) {
    case "provider":
      return { ok: true };
    case "bucket": {
      if (!form.bucket.trim()) return { ok: false, reason: "填存储桶名称" };
      if (form.provider !== "s3" && !form.endpoint.trim()) return { ok: false, reason: form.provider === "r2" ? "填账户 ID 或 Endpoint" : "填 Endpoint" };
      if (form.endpoint.trim() && !/^https?:\/\/[^\s/]+/i.test(form.endpoint.trim())) return { ok: false, reason: "Endpoint 要以 https:// 或 http:// 开头" };
      if (!form.region.trim()) return { ok: false, reason: "填区域" };
      return { ok: true };
    }
    case "keys":
      if (state.editing) return { ok: true };
      if (!form.accessKeyId.trim() || !form.secretAccessKey.trim()) return { ok: false, reason: "填 Access Key ID 和 Secret" };
      return { ok: true };
    case "test":
      if (!state.diagnosis) return { ok: false, reason: "先测试连接" };
      if (!state.diagnosis.ok) return { ok: false, reason: "先解决标红的一项" };
      return { ok: true };
    case "passphrase": {
      if (state.editing && !form.passphrase) return { ok: true };
      if (form.passphrase.length < 8) return { ok: false, reason: "口令至少 8 位" };
      if (state.diagnosis?.repo !== "existing" && state.confirm !== form.passphrase) return { ok: false, reason: "两次输入的口令不一致" };
      return { ok: true };
    }
  }
}

export function wizardReducer(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case "provider":
      return { ...state, form: applyProvider(state.form, action.provider), accountId: "", diagnosis: null };
    case "field": {
      const form = { ...state.form, [action.key]: action.value } as SyncForm;
      // 改了连接参数，之前的测试结果作废
      const stale = !["passphrase", "remember"].includes(action.key);
      return { ...state, form, diagnosis: stale ? null : state.diagnosis };
    }
    case "account": {
      const parsed = r2FromInput(action.value);
      if (!parsed) return { ...state, accountId: action.value };
      return {
        ...state,
        accountId: action.value,
        diagnosis: null,
        form: { ...state.form, endpoint: parsed.endpoint, bucket: parsed.bucket ?? state.form.bucket },
      };
    }
    case "link": {
      const decoded = decodeLinkCode(action.code);
      return { ...state, form: { ...state.form, ...decoded }, diagnosis: null, step: "keys" };
    }
    case "tested":
      return { ...state, diagnosis: action.diagnosis };
    case "confirm":
      return { ...state, confirm: action.value };
    case "go":
      return { ...state, step: action.step };
    case "next": {
      if (!canAdvance(state).ok) return state;
      const index = ORDER.indexOf(state.step);
      return index < ORDER.length - 1 ? { ...state, step: ORDER[index + 1] } : state;
    }
    case "back": {
      const index = ORDER.indexOf(state.step);
      return index > 0 ? { ...state, step: ORDER[index - 1] } : state;
    }
  }
}

// ---- 进度 ----

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export type ProgressLike = {
  phase: string;
  download: { done: number; total: number; bytes: number };
  upload: { done: number; total: number; bytes: number; skipped: number };
};

const PHASE_TEXT: Record<string, string> = {
  connect: "连接存储桶、校验口令…",
  lock: "等待同步锁…",
  download: "下载",
  merge: "合并本机和远端的改动…",
  upload: "上传",
  commit: "提交快照…",
  done: "完成",
};

/** 一行进度文字和 0–1 的比例（不确定时为 null）。 */
export function progressLine(progress: ProgressLike | null): { text: string; ratio: number | null } {
  if (!progress) return { text: "", ratio: null };
  if (progress.phase === "download" && progress.download.total) {
    const { done, total, bytes } = progress.download;
    return { text: `下载 ${done} / ${total} 个加密对象 · ${formatBytes(bytes)}`, ratio: done / total };
  }
  if (progress.phase === "upload" && progress.upload.total) {
    const { done, total, bytes, skipped } = progress.upload;
    const finished = done + skipped;
    return { text: `上传 ${finished} / ${total} 个加密对象 · ${formatBytes(bytes)}${skipped ? `（${skipped} 个已在桶里，跳过）` : ""}`, ratio: finished / total };
  }
  return { text: PHASE_TEXT[progress.phase] ?? "同步中…", ratio: null };
}
