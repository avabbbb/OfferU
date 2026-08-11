// =============================================
// OfferU Extension — Background Service Worker
// =============================================
// 管理岗位购物车存储、状态分层与后端同步
// =============================================

import type {
  ClipboardCopyResponse,
  ExtractedJob,
  ExtensionSettings,
  SmartFillAiMapping,
  SmartFillAiSettings,
  SmartFillAiTransform,
  SmartFillCatalogItem,
  SmartFillFieldCandidate,
  SmartFillRuntimeStats,
  SmartFillRunLogEntry,
  Message,
  MergeResponse,
  PageAgentCollectViaResponse,
  RemoveResponse,
  StatusResponse,
  SyncResponse,
} from "./types.js";
import type { CollectResult } from "./page-agent/collect.js";
import { HttpOfferUControl } from "./background/offeru-control-http.js";
import type { SyncJobCandidate } from "./framework/workflow.js";
import {
  JOBS_SCHEMA_VERSION,
  JOBS_STORAGE_KEY,
  sanitizeVersionedJobsStore,
  type VersionedJobsStore,
} from "./background/storage.js";
import {
  buildSyncPlan,
  isJobReadyToSync,
  retainUnsyncedJobsByHashKeys,
} from "./background/sync-contract.js";
import {
  hasDirectChannelConfig,
  resolveChannelOrder,
  type SmartFillChannel,
} from "./background/smartfill-channel.js";
import { toExtractedJob } from "./background/page-agent-collect.js";
import {
  buildRuntimeCatalog,
  buildSmartFillCatalogSignature,
  selectAuthoritativeCatalog,
} from "./background/smartfill-catalog-contract.js";
import {
  buildSmartFillProfileFieldValues,
  countSmartFillAvailableFields,
  normalizeSmartFillProfile,
  selectCriticalSmartFillProfile,
  type SmartFillProfileFieldValue,
  type SmartFillProfileNormalized,
} from "./background/smartfill-profile.js";

const DEFAULT_SETTINGS: ExtensionSettings = {
  serverUrl: "http://127.0.0.1:8765",
};

const SETTINGS_KEY = "settings";
const SMART_FILL_SETTINGS_KEY = "smartFillSettingsV1";
const SMART_FILL_RUNTIME_KEY = "smartFillRuntimeV1";
const SMART_FILL_MAP_CACHE_KEY = "smartFillAiMapCacheV1";
const OFFSCREEN_CLIPBOARD_DOCUMENT = "offscreen/clipboard.html";
const OFFSCREEN_WRITE_TIMEOUT_MS = 12000;
const SMART_FILL_REQUEST_TIMEOUT_MS = 90000;
const SMART_FILL_MAP_CACHE_TTL_MS = 5 * 60 * 1000;
const SMART_FILL_MAP_CACHE_MAX_ENTRIES = 24;
const SMART_FILL_DEBUG_FLAG_KEY = "smartFillDebug";
const SMART_FILL_DEBUG_CACHE_TTL_MS = 2500;

const DEFAULT_SMART_FILL_SETTINGS: SmartFillAiSettings = {
  enabled: false,
  provider: "openai-compatible",
  baseUrl: "",
  apiKey: "",
  model: "",
  enableFallback: true,
  cacheTtlSeconds: 300,
  cacheMaxEntries: 24,
  cacheCrossDomainReuse: false,
};

interface SmartFillMapCacheEntry {
  key: string;
  createdAt: number;
  expiresAt: number;
  mappings: SmartFillAiMapping[];
  channel: SmartFillChannel;
  fallbackUsed: boolean;
  runId?: string;
}

interface SmartFillMapCacheStore {
  version: number;
  entries: Record<string, SmartFillMapCacheEntry>;
}

let creatingOffscreenDocument: Promise<void> | null = null;
const pendingClipboardRequests = new Map<string, (result: ClipboardCopyResponse) => void>();
let smartFillDebugEnabledCache = false;
let smartFillDebugCacheAt = 0;

function buildOffscreenRequestId(): string {
  return `copy-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function getOffscreenApi(): {
  createDocument: (options: {
    url: string;
    reasons: string[];
    justification: string;
  }) => Promise<void>;
} | null {
  return (chrome as typeof chrome & {
    offscreen?: {
      createDocument: (options: {
        url: string;
        reasons: string[];
        justification: string;
      }) => Promise<void>;
    };
  }).offscreen || null;
}

async function hasOffscreenDocument(documentUrl: string): Promise<boolean> {
  const runtimeWithContexts = chrome.runtime as typeof chrome.runtime & {
    getContexts?: (options: {
      contextTypes?: string[];
      documentUrls?: string[];
    }) => Promise<Array<{ contextType?: string; documentUrl?: string }>>;
  };

  if (!runtimeWithContexts.getContexts) {
    return false;
  }

  const contexts = await runtimeWithContexts.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [documentUrl],
  });

  return contexts.length > 0;
}

async function ensureOffscreenClipboardDocument(): Promise<void> {
  const offscreenApi = getOffscreenApi();
  if (!offscreenApi) {
    throw new Error("当前浏览器不支持 offscreen 剪贴板能力");
  }

  const documentUrl = chrome.runtime.getURL(OFFSCREEN_CLIPBOARD_DOCUMENT);
  if (await hasOffscreenDocument(documentUrl)) {
    return;
  }

  if (!creatingOffscreenDocument) {
    creatingOffscreenDocument = offscreenApi
      .createDocument({
        url: OFFSCREEN_CLIPBOARD_DOCUMENT,
        reasons: ["CLIPBOARD"],
        justification: "Write exported resume image to clipboard from extension context",
      })
      .finally(() => {
        creatingOffscreenDocument = null;
      });
  }

  await creatingOffscreenDocument;
}

function waitForOffscreenResult(requestId: string): Promise<ClipboardCopyResponse> {
  return new Promise<ClipboardCopyResponse>((resolve) => {
    const timer = setTimeout(() => {
      pendingClipboardRequests.delete(requestId);
      resolve({ ok: false, error: "离屏复制超时" });
    }, OFFSCREEN_WRITE_TIMEOUT_MS);

    pendingClipboardRequests.set(requestId, (result) => {
      clearTimeout(timer);
      pendingClipboardRequests.delete(requestId);
      resolve(result);
    });
  });
}

async function copyImageToClipboardViaOffscreen(imageUrl: string): Promise<ClipboardCopyResponse> {
  if (!imageUrl) {
    return { ok: false, error: "缺少图片地址" };
  }

  try {
    await ensureOffscreenClipboardDocument();

    const requestId = buildOffscreenRequestId();
    const waitResult = waitForOffscreenResult(requestId);

    chrome.runtime.sendMessage({
      type: "OFFSCREEN_WRITE_IMAGE",
      requestId,
      imageUrl,
    } as Message);

    return await waitResult;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message || "离屏复制失败" };
  }
}

function normalizeUrl(url: string): string {
  if (!url) return "";
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}

function normalizePostedAt(value: string | null | undefined): string | null {
  const text = (value || "").trim();
  return text || null;
}

function sanitizeJob(job: ExtractedJob): ExtractedJob {
  const url = normalizeUrl(job.url || "");
  const applyUrl = normalizeUrl(job.apply_url || url);
  const rawDescription = (job.raw_description || "").trim();

  return {
    ...job,
    title: (job.title || "").trim(),
    company: (job.company || "").trim(),
    location: (job.location || "").trim(),
    salary_text: (job.salary_text || "").trim(),
    raw_description: rawDescription,
    posted_at: normalizePostedAt(job.posted_at),
    url,
    apply_url: applyUrl,
    source_page_meta: job.source_page_meta || "",
    education: (job.education || "").trim(),
    experience: (job.experience || "").trim(),
    job_type: (job.job_type || "").trim(),
    company_size: (job.company_size || "").trim(),
    company_industry: (job.company_industry || "").trim(),
    status: rawDescription ? "ready_to_sync" : "draft_pending_jd",
    created_at: job.created_at || new Date().toISOString(),
  };
}

function mergeJob(existing: ExtractedJob, incoming: ExtractedJob): ExtractedJob {
  const merged: ExtractedJob = {
    ...existing,
    ...incoming,
    title: incoming.title || existing.title,
    company: incoming.company || existing.company,
    location: incoming.location || existing.location,
    salary_text: incoming.salary_text || existing.salary_text,
    salary_min: incoming.salary_min ?? existing.salary_min,
    salary_max: incoming.salary_max ?? existing.salary_max,
    raw_description: incoming.raw_description || existing.raw_description,
    posted_at: incoming.posted_at || existing.posted_at,
    url: incoming.url || existing.url,
    apply_url: incoming.apply_url || existing.apply_url || incoming.url || existing.url,
    source_page_meta: incoming.source_page_meta || existing.source_page_meta,
    education: incoming.education || existing.education,
    experience: incoming.experience || existing.experience,
    job_type: incoming.job_type || existing.job_type,
    company_size: incoming.company_size || existing.company_size,
    company_industry: incoming.company_industry || existing.company_industry,
    status:
      incoming.status === "ready_to_sync" || existing.raw_description || incoming.raw_description
        ? "ready_to_sync"
        : "draft_pending_jd",
    created_at: existing.created_at || incoming.created_at || new Date().toISOString(),
  };

  return sanitizeJob(merged);
}

function toSyncJobCandidate(job: ExtractedJob): SyncJobCandidate {
  return {
    title: job.title,
    company: job.company,
    description: job.raw_description,
    location: job.location || undefined,
    salary: job.salary_text || undefined,
    applyUrl: job.apply_url || undefined,
    postedAt: job.posted_at ?? undefined,
    sourceUrl: job.url,
    hashKey: job.hash_key,
    salaryMin: job.salary_min,
    salaryMax: job.salary_max,
    education: job.education || undefined,
    experience: job.experience || undefined,
    jobType: job.job_type || undefined,
    companySize: job.company_size || undefined,
    companyIndustry: job.company_industry || undefined,
  };
}

async function updateBadge(total: number): Promise<void> {
  await chrome.action.setBadgeText({ text: total > 0 ? String(total) : "" });
  if (total > 0) {
    await chrome.action.setBadgeBackgroundColor({ color: "#2563eb" });
  }
}

// ---- 存储操作 ----
async function getJobs(): Promise<ExtractedJob[]> {
  const result = await chrome.storage.local.get(JOBS_STORAGE_KEY);
  const raw = result[JOBS_STORAGE_KEY] as unknown;

  // Legacy migration: older versions stored plain array in collectedJobs.
  if (Array.isArray(raw)) {
    const migrated: VersionedJobsStore = {
      version: JOBS_SCHEMA_VERSION,
      jobs: raw as ExtractedJob[],
    };
    await chrome.storage.local.set({ [JOBS_STORAGE_KEY]: migrated });
    return migrated.jobs;
  }

  const parsed = sanitizeVersionedJobsStore(raw);
  return parsed.jobs;
}

async function saveJobs(jobs: ExtractedJob[]): Promise<void> {
  const payload: VersionedJobsStore = {
    version: JOBS_SCHEMA_VERSION,
    jobs,
  };
  await chrome.storage.local.set({ [JOBS_STORAGE_KEY]: payload });
  await updateBadge(jobs.length);
}

async function getSettings(): Promise<ExtensionSettings> {
  const result = await chrome.storage.local.get(SETTINGS_KEY);
  return (result[SETTINGS_KEY] as ExtensionSettings) || DEFAULT_SETTINGS;
}

function sanitizeSmartFillSettings(input: unknown): SmartFillAiSettings {
  if (!input || typeof input !== "object") {
    return { ...DEFAULT_SMART_FILL_SETTINGS };
  }

  const raw = input as Partial<SmartFillAiSettings>;
  const ttl = Number(raw.cacheTtlSeconds);
  const maxEntries = Number(raw.cacheMaxEntries);
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_SMART_FILL_SETTINGS.enabled,
    provider: (raw.provider || DEFAULT_SMART_FILL_SETTINGS.provider || "").trim(),
    baseUrl: (raw.baseUrl || "").trim(),
    apiKey: (raw.apiKey || "").trim(),
    model: (raw.model || "").trim(),
    enableFallback:
      typeof raw.enableFallback === "boolean"
        ? raw.enableFallback
        : DEFAULT_SMART_FILL_SETTINGS.enableFallback,
    cacheTtlSeconds: Number.isFinite(ttl) && ttl > 0 ? Math.round(ttl) : DEFAULT_SMART_FILL_SETTINGS.cacheTtlSeconds,
    cacheMaxEntries: Number.isFinite(maxEntries) && maxEntries > 0 ? Math.round(maxEntries) : DEFAULT_SMART_FILL_SETTINGS.cacheMaxEntries,
    cacheCrossDomainReuse:
      typeof raw.cacheCrossDomainReuse === "boolean"
        ? raw.cacheCrossDomainReuse
        : DEFAULT_SMART_FILL_SETTINGS.cacheCrossDomainReuse,
  };
}

async function getSmartFillSettings(): Promise<SmartFillAiSettings> {
  const result = await chrome.storage.local.get(SMART_FILL_SETTINGS_KEY);
  return sanitizeSmartFillSettings(result[SMART_FILL_SETTINGS_KEY]);
}

function nowMs(): number {
  return Date.now();
}

async function isSmartFillDebugEnabledInBackground(): Promise<boolean> {
  if (nowMs() - smartFillDebugCacheAt < SMART_FILL_DEBUG_CACHE_TTL_MS) {
    return smartFillDebugEnabledCache;
  }
  const result = await chrome.storage.local.get(SMART_FILL_DEBUG_FLAG_KEY);
  const enabled = Boolean(result?.[SMART_FILL_DEBUG_FLAG_KEY]);
  smartFillDebugEnabledCache = enabled;
  smartFillDebugCacheAt = nowMs();
  return enabled;
}

async function logSmartFillBackground(stage: string, payload: unknown): Promise<void> {
  if (!(await isSmartFillDebugEnabledInBackground())) return;
  try {
    // eslint-disable-next-line no-console
    console.groupCollapsed(`[OfferU SmartFill Background] ${stage}`);
    // eslint-disable-next-line no-console
    console.log(payload);
    // eslint-disable-next-line no-console
    console.groupEnd();
  } catch {
    // ignore debug logging errors
  }
}

function simpleHash(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function buildSmartFillMapCacheKey(
  pageStructureSig: string,
  profileSig: string,
  modelSig: string,
  adapterId: string,
): string {
  return simpleHash([
    pageStructureSig,
    profileSig,
    modelSig,
    adapterId || "unknown",
  ].join("##"));
}

function buildSmartFillModelSignature(settings: SmartFillAiSettings): string {
  return simpleHash([
    settings.provider,
    settings.model,
    settings.baseUrl,
    settings.enableFallback ? "1" : "0",
  ].join("::"));
}

function buildSmartFillAdapterHint(fields: SmartFillFieldCandidate[]): string {
  const signatures = fields
    .map((field) => field.canonicalFieldKey || "")
    .filter(Boolean)
    .join("||")
    .toLowerCase();
  if (signatures.includes("feishu")) return "feishu";
  if (signatures.includes("beisen")) return "beisen";
  if (signatures.includes("dayee")) return "dayee";
  if (signatures.includes("moka")) return "moka";
  if (signatures.includes("self-built")) return "self-built";
  return "unknown";
}

function buildSmartFillPageStructureSignature(fields: SmartFillFieldCandidate[]): string {
  const compact = fields
    .map((field) => [
      field.fieldId,
      field.canonicalFieldKey || "",
      field.label || "",
      field.level1Title || "",
      field.level2Title || "",
      field.repeatGroupIndex ? String(field.repeatGroupIndex) : "",
      field.structureToken || "",
      field.qualifiedLabel || "",
      field.placeholder || "",
      field.name || "",
      field.inputType || "",
      field.required ? "1" : "0",
      field.options.join("|"),
    ].join("::"))
    .join("||");
  return simpleHash(compact);
}

function resolveSmartFillCacheScope(
  settings: SmartFillAiSettings,
  pageUrl?: string,
): string {
  const text = (pageUrl || "").trim();
  try {
    const parsed = new URL(text);
    if (settings.cacheCrossDomainReuse) {
      return `domain:${parsed.hostname || "unknown"}`;
    }
    return `origin:${parsed.origin || "unknown"}`;
  } catch {
    return settings.cacheCrossDomainReuse ? "domain:unknown" : "origin:unknown";
  }
}

function resolveSmartFillCacheTtlMs(settings: SmartFillAiSettings): number {
  const ttlSeconds = Number(settings.cacheTtlSeconds || 0);
  if (Number.isFinite(ttlSeconds) && ttlSeconds > 0) {
    return Math.max(30, Math.round(ttlSeconds)) * 1000;
  }
  return SMART_FILL_MAP_CACHE_TTL_MS;
}

function resolveSmartFillCacheMaxEntries(settings: SmartFillAiSettings): number {
  const maxEntries = Number(settings.cacheMaxEntries || 0);
  if (Number.isFinite(maxEntries) && maxEntries > 0) {
    return Math.max(8, Math.round(maxEntries));
  }
  return SMART_FILL_MAP_CACHE_MAX_ENTRIES;
}

function isSmartFillAiRuntimeEnabled(settings: SmartFillAiSettings): boolean {
  return Boolean(settings.enabled || hasDirectChannelConfig(settings));
}

function sanitizeSmartFillMapCacheStore(input: unknown): SmartFillMapCacheStore {
  if (!input || typeof input !== "object") {
    return { version: 1, entries: {} };
  }
  const raw = input as Partial<SmartFillMapCacheStore>;
  const entriesRaw = raw.entries && typeof raw.entries === "object" ? raw.entries : {};
  const entries: Record<string, SmartFillMapCacheEntry> = {};
  for (const [key, value] of Object.entries(entriesRaw)) {
    if (!value || typeof value !== "object") continue;
    const row = value as Partial<SmartFillMapCacheEntry>;
    const createdAt = Number(row.createdAt);
    const expiresAt = Number(row.expiresAt);
    const channel = row.channel === "backend" ? "backend" : row.channel === "plugin-direct" ? "plugin-direct" : null;
    if (!channel || !Number.isFinite(createdAt) || !Number.isFinite(expiresAt)) continue;
    entries[key] = {
      key,
      createdAt,
      expiresAt,
      mappings: Array.isArray(row.mappings) ? row.mappings : [],
      channel,
      fallbackUsed: Boolean(row.fallbackUsed),
      runId: typeof row.runId === "string" ? row.runId : undefined,
    };
  }
  return {
    version: 1,
    entries,
  };
}

async function getSmartFillMapCacheStore(): Promise<SmartFillMapCacheStore> {
  const result = await chrome.storage.local.get(SMART_FILL_MAP_CACHE_KEY);
  return sanitizeSmartFillMapCacheStore(result[SMART_FILL_MAP_CACHE_KEY]);
}

function pruneSmartFillMapCacheEntries(
  entries: Record<string, SmartFillMapCacheEntry>,
  maxEntries: number,
): Record<string, SmartFillMapCacheEntry> {
  const now = nowMs();
  const alive = Object.values(entries)
    .filter((item) => item.expiresAt > now)
    .sort((a, b) => b.createdAt - a.createdAt);
  const trimmed = alive.slice(0, maxEntries);
  const next: Record<string, SmartFillMapCacheEntry> = {};
  for (const item of trimmed) {
    next[item.key] = item;
  }
  return next;
}

async function readSmartFillMapCache(
  key: string,
  settings: SmartFillAiSettings,
): Promise<SmartFillMapCacheEntry | null> {
  const store = await getSmartFillMapCacheStore();
  const entry = store.entries[key];
  if (!entry) return null;
  if (entry.expiresAt <= nowMs()) {
    const nextEntries = { ...store.entries };
    delete nextEntries[key];
    const maxEntries = resolveSmartFillCacheMaxEntries(settings);
    await chrome.storage.local.set({
      [SMART_FILL_MAP_CACHE_KEY]: { version: 1, entries: pruneSmartFillMapCacheEntries(nextEntries, maxEntries) },
    });
    return null;
  }
  return entry;
}

async function writeSmartFillMapCache(
  key: string,
  settings: SmartFillAiSettings,
  payload: {
    mappings: SmartFillAiMapping[];
    channel: SmartFillChannel;
    fallbackUsed: boolean;
    runId?: string;
  },
): Promise<void> {
  const store = await getSmartFillMapCacheStore();
  const now = nowMs();
  const ttlMs = resolveSmartFillCacheTtlMs(settings);
  const maxEntries = resolveSmartFillCacheMaxEntries(settings);
  const nextEntries = {
    ...store.entries,
    [key]: {
      key,
      createdAt: now,
      expiresAt: now + ttlMs,
      mappings: payload.mappings,
      channel: payload.channel,
      fallbackUsed: payload.fallbackUsed,
      runId: payload.runId,
    },
  };
  await chrome.storage.local.set({
    [SMART_FILL_MAP_CACHE_KEY]: {
      version: 1,
      entries: pruneSmartFillMapCacheEntries(nextEntries, maxEntries),
    },
  });
}

async function saveSmartFillSettings(settings: SmartFillAiSettings): Promise<void> {
  const sanitized = sanitizeSmartFillSettings(settings);
  await chrome.storage.local.set({ [SMART_FILL_SETTINGS_KEY]: sanitized });
}

async function saveSmartFillRuntime(stats: SmartFillRuntimeStats): Promise<void> {
  await chrome.storage.local.set({ [SMART_FILL_RUNTIME_KEY]: stats });
}

function normalizeBaseUrl(raw: string): string {
  const trimmed = (raw || "").trim();
  if (!trimmed) return "";
  return trimmed.replace(/\/+$/, "");
}

function parseJsonPayload(input: string): Record<string, unknown> | null {
  if (!input) return null;
  const text = input.trim();
  if (!text) return null;

  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    // continue
  }

  const match = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (match?.[1]) {
    try {
      return JSON.parse(match[1]) as Record<string, unknown>;
    } catch {
      // continue
    }
  }

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  return null;
}

async function fetchJsonWithTimeout<T>(
  url: string,
  init: RequestInit = {},
  timeoutMs = SMART_FILL_REQUEST_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || `HTTP ${response.status}`);
    }
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

function flattenStringValues(input: unknown, output: Set<string>): void {
  if (typeof input === "string") {
    const value = input.trim();
    if (value) output.add(value);
    return;
  }

  if (Array.isArray(input)) {
    for (const item of input) flattenStringValues(item, output);
    return;
  }

  if (!input || typeof input !== "object") {
    return;
  }

  for (const value of Object.values(input as Record<string, unknown>)) {
    flattenStringValues(value, output);
  }
}

async function fetchSmartFillProfilePayload(): Promise<SmartFillProfileNormalized> {
  const settings = await getSettings();
  const base = settings.serverUrl.replace(/\/+$/, "");
  const separator = base.includes("?") ? "&" : "?";
  const profileUrl = `${base}/api/profile/${separator}_ts=${Date.now()}`;
  const rawProfile = await fetchJsonWithTimeout<unknown>(
    profileUrl,
    {
      method: "GET",
      cache: "no-store",
      headers: {
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
      },
    },
  );
  const normalized = normalizeSmartFillProfile(rawProfile);
  const availableCount = countSmartFillAvailableFields(normalized);
  if (availableCount <= 0) {
    throw new Error("未读取到可用于智填的档案数据");
  }
  return normalized;
}

async function fetchSmartFillProfileContext(): Promise<{
  profile: SmartFillProfileNormalized;
  profileValues: SmartFillProfileFieldValue[];
}> {
  const profile = await fetchSmartFillProfilePayload();
  const profileValues = buildSmartFillProfileFieldValues(profile);
  if (profileValues.length <= 0) {
    throw new Error("未读取到可用于智填的档案数据");
  }
  return { profile, profileValues };
}

async function ensureHostPermissionForUrl(url: string): Promise<void> {
  const baseUrl = normalizeBaseUrl(url);
  if (!baseUrl) return;

  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return;
  }

  const originPattern = `${parsed.protocol}//${parsed.host}/*`;
  const chromeWithPermissions = chrome as typeof chrome & {
    permissions?: {
      contains: (permissions: { origins?: string[] }) => Promise<boolean>;
      request: (permissions: { origins?: string[] }) => Promise<boolean>;
    };
  };

  if (!chromeWithPermissions.permissions) return;
  const hasPermission = await chromeWithPermissions.permissions.contains({ origins: [originPattern] });
  if (!hasPermission) {
    throw new Error("未授予目标 AI 服务地址权限，请在插件设置中点击“检查连接”重新授权");
  }
}

async function requestHostPermissionForUrl(url: string): Promise<void> {
  const baseUrl = normalizeBaseUrl(url);
  if (!baseUrl) return;

  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("AI 服务地址格式不正确");
  }

  const originPattern = `${parsed.protocol}//${parsed.host}/*`;
  const chromeWithPermissions = chrome as typeof chrome & {
    permissions?: {
      contains: (permissions: { origins?: string[] }) => Promise<boolean>;
      request: (permissions: { origins?: string[] }) => Promise<boolean>;
    };
  };

  if (!chromeWithPermissions.permissions) return;
  const hasPermission = await chromeWithPermissions.permissions.contains({ origins: [originPattern] });
  if (hasPermission) return;

  const granted = await chromeWithPermissions.permissions.request({ origins: [originPattern] });
  if (!granted) {
    throw new Error("用户未授予目标 AI 服务地址权限");
  }
}

function parseAiMappings(
  payload: unknown,
  source: "plugin-direct" | "backend",
  fields: SmartFillFieldCandidate[],
): SmartFillAiMapping[] {
  const fieldSet = new Set(fields.map((field) => field.fieldId));
  if (!payload || typeof payload !== "object") {
    return [];
  }

  const mappings = Array.isArray((payload as { mappings?: unknown[] }).mappings)
    ? ((payload as { mappings?: unknown[] }).mappings as unknown[])
    : [];
  const normalized: SmartFillAiMapping[] = [];

  for (const item of mappings) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const fieldId = String(row.fieldId || "").trim();
    const profilePath = String(row.profilePath || row.sourcePath || row.resumePath || "").trim();
    const catalogKey = String(row.catalogKey || row.key || "").trim();
    const reason = String(row.reason || "").trim();
    const intent = String(row.intent || "").trim();
    const category = String(row.category || "").trim();
    const transform = normalizeAiTransform(row.transform);
    const itemIndexRaw = Number(row.itemIndex);
    const itemIndex = Number.isFinite(itemIndexRaw) && itemIndexRaw > 0 ? Math.round(itemIndexRaw) : undefined;
    const confidenceRaw = Number(row.confidence);
    const confidence = Number.isFinite(confidenceRaw) ? Math.max(0, Math.min(1, confidenceRaw)) : 0;
    if (!fieldId || !fieldSet.has(fieldId)) continue;
    if (!profilePath && !catalogKey) continue;
    normalized.push({
      fieldId,
      profilePath: profilePath || undefined,
      catalogKey: catalogKey || undefined,
      confidence,
      intent: intent || undefined,
      category: category || undefined,
      itemIndex,
      reason,
      transform,
      source,
    });
  }

  return normalized;
}

function normalizeAiTransform(input: unknown): SmartFillAiTransform | undefined {
  if (!input || typeof input !== "object") return undefined;
  const row = input as Record<string, unknown>;
  const type = String(row.type || "none").trim();
  if (type === "date_part") {
    const part = row.part === "month" || row.part === "day" ? row.part : "year";
    return { type: "date_part", part };
  }
  if (type === "phone_part") {
    return { type: "phone_part", part: row.part === "countryCode" ? "countryCode" : "nationalNumber" };
  }
  if (type === "boolean_choice") {
    return {
      type: "boolean_choice",
      trueValue: String(row.trueValue ?? "是"),
      falseValue: String(row.falseValue ?? "否"),
    };
  }
  if (type === "join") {
    return { type: "join", separator: String(row.separator || ", ") };
  }
  return { type: "none" };
}

async function pluginDirectPing(settings: SmartFillAiSettings): Promise<{ ok: true }> {
  const baseUrl = normalizeBaseUrl(settings.baseUrl);
  await ensureHostPermissionForUrl(baseUrl);
  await fetchJsonWithTimeout<unknown>(
    `${baseUrl}/models`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${settings.apiKey}`,
      },
    },
    12000,
  );
  return { ok: true };
}

async function backendPing(): Promise<{ ok: true }> {
  const settings = await getSettings();
  await fetchJsonWithTimeout<unknown>(
    `${settings.serverUrl}/api/profile/smart-fill/ping`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "smart-fill" }),
    },
    12000,
  );
  return { ok: true };
}

async function pluginDirectMap(
  settings: SmartFillAiSettings,
  fields: SmartFillFieldCandidate[],
  profile: SmartFillProfileNormalized,
  catalog: SmartFillCatalogItem[],
): Promise<SmartFillAiMapping[]> {
  const baseUrl = normalizeBaseUrl(settings.baseUrl);
  await ensureHostPermissionForUrl(baseUrl);

  const body = {
    model: settings.model,
    temperature: 0.1,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "你是表单字段映射助手。只返回 JSON：{ \"mappings\": [{\"fieldId\":\"\", \"profilePath\":\"\", \"catalogKey\":\"\", \"confidence\":0-1, \"intent\":\"\", \"category\":\"\", \"itemIndex\":1, \"transform\":{\"type\":\"none\"}, \"reason\":\"\"}] }。"
          + "你只能从 catalog 中选择 profilePath/catalogKey，不要输出用户真实值。"
          + "重要：字段的 level1Title/moduleName 表示模块，level2Title 表示字段名，repeatGroupIndex 表示第几条经历。"
          + "遇到时间、名称、描述、职责等同名字段时，必须同时参考 qualifiedLabel、category 和 itemIndex。"
          + "catalog 中 path/key 是唯一可选来源；value 已被隐藏，本地会根据 path 解析最终值。"
          + "如果没有足够证据，省略该字段，不要猜测。",
      },
      {
        role: "user",
        content: JSON.stringify(
          {
            fields,
            catalog,
          },
          null,
          2,
        ),
      },
    ],
  };

  const response = await fetchJsonWithTimeout<{ choices?: Array<{ message?: { content?: string } }> }>(
    `${baseUrl}/chat/completions`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify(body),
    },
  );

  const content = response.choices?.[0]?.message?.content || "";
  const parsed = parseJsonPayload(content);
  return parseAiMappings(parsed, "plugin-direct", fields);
}

async function backendMap(
  fields: SmartFillFieldCandidate[],
  profile: SmartFillProfileNormalized,
  profileValues: SmartFillProfileFieldValue[],
  catalog: SmartFillCatalogItem[],
): Promise<{ mappings: SmartFillAiMapping[]; runId?: string }> {
  const settings = await getSettings();
  const response = await fetchJsonWithTimeout<{ mappings?: unknown[]; runId?: string }>(
    `${settings.serverUrl}/api/profile/smart-fill/map`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fields, profile, profileValues, catalog }),
    },
  );
  return {
    mappings: parseAiMappings(response, "backend", fields),
    runId: typeof response.runId === "string" ? response.runId : undefined,
  };
}

async function backendCatalog(): Promise<SmartFillCatalogItem[]> {
  const settings = await getSettings();
  const response = await fetchJsonWithTimeout<{ catalog?: unknown[] }>(
    `${settings.serverUrl}/api/profile/smart-fill/catalog`,
    {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    },
    12000,
  );
  if (!Array.isArray(response.catalog)) return [];
  return response.catalog
    .filter((item): item is SmartFillCatalogItem => Boolean(item && typeof item === "object"))
    .map((item) => ({
      ...item,
      key: String(item.key || item.path || "").trim(),
      path: String(item.path || item.key || "").trim(),
      label: String(item.label || "").trim(),
      categoryKey: String(item.categoryKey || item.sectionType || "").trim(),
      categoryLabel: String(item.categoryLabel || "").trim(),
      sectionType: String(item.sectionType || item.categoryKey || "general").trim() || "general",
      aliases: Array.isArray(item.aliases) ? item.aliases : [],
      sourceRef: String(item.sourceRef || "").trim(),
      signature: String(item.signature || "").trim(),
      valueType: item.valueType || "text",
    }))
    .filter((item) => item.path && item.label);
}

async function backendCacheGet(params: {
  cacheKey: string;
  adapterId: string;
  modelSignature: string;
  fields: SmartFillFieldCandidate[];
}): Promise<{
  hit: boolean;
  mappings: SmartFillAiMapping[];
  channel: SmartFillChannel | "none";
  fallbackUsed: boolean;
  runId?: string;
}> {
  const settings = await getSettings();
  const response = await fetchJsonWithTimeout<{
    hit?: boolean;
    mappings?: unknown[];
    channel?: "plugin-direct" | "backend" | "none";
    fallbackUsed?: boolean;
    runId?: string;
  }>(
    `${settings.serverUrl}/api/profile/smart-fill/cache/get`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    },
  );
  return {
    hit: Boolean(response.hit),
    mappings: parseAiMappings(response, "backend", params.fields),
    channel: response.channel === "plugin-direct" || response.channel === "backend" ? response.channel : "none",
    fallbackUsed: Boolean(response.fallbackUsed),
    runId: typeof response.runId === "string" ? response.runId : undefined,
  };
}

async function backendCacheSet(params: {
  cacheKey: string;
  adapterId: string;
  modelSignature: string;
  ttlSeconds: number;
  mappings: SmartFillAiMapping[];
  channel: SmartFillChannel;
  fallbackUsed: boolean;
  runId?: string;
}): Promise<void> {
  const settings = await getSettings();
  await fetchJsonWithTimeout(
    `${settings.serverUrl}/api/profile/smart-fill/cache/set`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    },
  );
}

async function backendRunLog(params: {
  runId?: string;
  logs: SmartFillRunLogEntry[];
}): Promise<void> {
  if (!params.runId || !params.logs.length) return;
  const settings = await getSettings();
  await fetchJsonWithTimeout(
    `${settings.serverUrl}/api/profile/smart-fill/runs/log`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    },
    8000,
  );
}

async function runPingWithFallback(settings: SmartFillAiSettings): Promise<{
  ok: boolean;
  channel: SmartFillChannel | "none";
  fallbackUsed: boolean;
  error?: string;
}> {
  const { preferred, secondary } = resolveChannelOrder(settings);
  const errors: string[] = [];
  if (!preferred) {
    return {
      ok: false,
      channel: "none",
      fallbackUsed: false,
      error: "未找到可用的智填 AI 通道",
    };
  }

  try {
    if (preferred === "plugin-direct") {
      await pluginDirectPing(settings);
    } else {
      await backendPing();
    }
    return { ok: true, channel: preferred, fallbackUsed: false };
  } catch (error: unknown) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  if (!settings.enableFallback || !secondary) {
    return { ok: false, channel: "none", fallbackUsed: false, error: errors.join(" | ") };
  }

  try {
    if (secondary === "plugin-direct") {
      await pluginDirectPing(settings);
    } else {
      await backendPing();
    }
    return { ok: true, channel: secondary, fallbackUsed: true };
  } catch (error: unknown) {
    errors.push(error instanceof Error ? error.message : String(error));
    return { ok: false, channel: "none", fallbackUsed: true, error: errors.join(" | ") };
  }
}

async function runAiMapWithFallback(
  settings: SmartFillAiSettings,
  fields: SmartFillFieldCandidate[],
  profile: SmartFillProfileNormalized,
  profileValues: SmartFillProfileFieldValue[],
  catalog: SmartFillCatalogItem[],
): Promise<{
  ok: boolean;
  channel: SmartFillChannel | "none";
  fallbackUsed: boolean;
  mappings: SmartFillAiMapping[];
  runId?: string;
  error?: string;
}> {
  const { preferred, secondary } = resolveChannelOrder(settings);
  const errors: string[] = [];
  if (!preferred) {
    return {
      ok: false,
      channel: "none",
      fallbackUsed: false,
      mappings: [],
      error: "未找到可用的智填 AI 通道",
    };
  }

  try {
    let mappings: SmartFillAiMapping[] = [];
    let runId: string | undefined;
    if (preferred === "plugin-direct") {
      mappings = await pluginDirectMap(settings, fields, profile, catalog);
    } else {
      const response = await backendMap(fields, profile, profileValues, catalog);
      mappings = response.mappings;
      runId = response.runId;
    }
    return {
      ok: true,
      channel: preferred,
      fallbackUsed: false,
      mappings,
      runId,
    };
  } catch (error: unknown) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  if (!settings.enableFallback || !secondary) {
    return { ok: false, channel: "none", fallbackUsed: false, mappings: [], error: errors.join(" | ") };
  }

  try {
    let mappings: SmartFillAiMapping[] = [];
    let runId: string | undefined;
    if (secondary === "plugin-direct") {
      mappings = await pluginDirectMap(settings, fields, profile, catalog);
    } else {
      const response = await backendMap(fields, profile, profileValues, catalog);
      mappings = response.mappings;
      runId = response.runId;
    }
    return {
      ok: true,
      channel: secondary,
      fallbackUsed: true,
      mappings,
      runId,
    };
  } catch (error: unknown) {
    errors.push(error instanceof Error ? error.message : String(error));
    return { ok: false, channel: "none", fallbackUsed: true, mappings: [], error: errors.join(" | ") };
  }
}

// ---- 去重合并 ----
async function mergeJobs(newJobs: ExtractedJob[]): Promise<MergeResponse> {
  const existing = await getJobs();
  const existingMap = new Map(existing.map((j) => [j.hash_key, j]));

  let added = 0;
  let upgraded = 0;
  let skipped = 0;

  for (const job of newJobs) {
    const incoming = sanitizeJob(job);
    const old = existingMap.get(incoming.hash_key);

    if (!old) {
      existing.push(incoming);
      existingMap.set(incoming.hash_key, incoming);
      added++;
      continue;
    }

    const merged = mergeJob(old, incoming);
    const oldReady = old.status === "ready_to_sync";
    const newReady = merged.status === "ready_to_sync";
    const improvedDescription =
      Boolean(merged.raw_description) && merged.raw_description !== old.raw_description;

    if (!oldReady && newReady) {
      upgraded++;
    } else if (improvedDescription) {
      upgraded++;
    } else {
      skipped++;
    }

    const idx = existing.findIndex((j) => j.hash_key === merged.hash_key);
    if (idx >= 0) {
      existing[idx] = merged;
    }
  }

  await saveJobs(existing);

  return { added, upgraded, skipped };
}

async function getStatus(): Promise<StatusResponse> {
  const jobs = await getJobs();
  const ready = jobs.filter((j) => isJobReadyToSync(j)).length;
  const draft = jobs.length - ready;
  const settings = await getSettings();
  return {
    total: jobs.length,
    ready,
    draft,
    serverUrl: settings.serverUrl,
  };
}

async function removeOneJob(hashKey: string): Promise<RemoveResponse> {
  if (!hashKey) {
    const jobs = await getJobs();
    return { ok: false, removed: 0, remaining: jobs.length };
  }

  const jobs = await getJobs();
  const before = jobs.length;
  const next = jobs.filter((job) => job.hash_key !== hashKey);
  await saveJobs(next);

  return {
    ok: true,
    removed: Math.max(0, before - next.length),
    remaining: next.length,
  };
}

async function removeManyJobs(hashKeys: string[]): Promise<RemoveResponse> {
  if (!hashKeys || hashKeys.length === 0) {
    const jobs = await getJobs();
    return { ok: false, removed: 0, remaining: jobs.length };
  }

  const keySet = new Set(hashKeys.filter(Boolean));
  const jobs = await getJobs();
  const before = jobs.length;
  const next = jobs.filter((job) => !keySet.has(job.hash_key));
  await saveJobs(next);

  return {
    ok: true,
    removed: Math.max(0, before - next.length),
    remaining: next.length,
  };
}

// ---- 同步到 OfferU 后端 ----
async function syncToServer(): Promise<SyncResponse> {
  const jobs = await getJobs();
  if (jobs.length === 0) {
    return { ok: true, synced: 0, skippedDraft: 0 };
  }

  const normalizedJobs = jobs.map(sanitizeJob);
  const { jobsToSync, skippedDraft } = buildSyncPlan(normalizedJobs);

  if (jobsToSync.length === 0) {
    return { ok: true, synced: 0, skippedDraft };
  }

  const settings = await getSettings();
  const control = new HttpOfferUControl(settings.serverUrl);
  const candidates = jobsToSync.map(toSyncJobCandidate);

  try {
    const plan = await control.prepareJobImport(candidates);
    const result = await control.confirmJobImport(plan.planId);

    const confirmedHashKeys = result.perItem
      .filter((item) => item.status !== "failed")
      .map((item) => candidates[item.index]?.hashKey)
      .filter((key): key is string => Boolean(key));

    if (confirmedHashKeys.length === 0 && jobsToSync.length > 0) {
      return {
        ok: false,
        synced: 0,
        skippedDraft,
        error: "后端未返回逐条同步确认，已保留插件本地队列",
      };
    }

    const remainingJobs = retainUnsyncedJobsByHashKeys(normalizedJobs, confirmedHashKeys);
    await saveJobs(remainingJobs);

    return { ok: true, synced: confirmedHashKeys.length, skippedDraft };
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === "AbortError") {
      return { ok: false, synced: 0, skippedDraft, error: "同步超时，请检查后端服务是否可访问" };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, synced: 0, skippedDraft, error: msg };
  }
}

// ---- 规则包采集（Page Agent 显式注入） ----
async function collectViaPageAgent(): Promise<PageAgentCollectViaResponse> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab?.id || !tab.url) {
    return { ok: false, message: "未找到当前标签页" };
  }

  let url: URL;
  try {
    url = new URL(tab.url);
  } catch {
    return { ok: false, message: "当前页面地址无效", fallback: true };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, message: "当前页面不支持采集", fallback: true };
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["page-agent.js"],
    });
  } catch (error: unknown) {
    return {
      ok: false,
      message: `注入失败：${error instanceof Error ? error.message : String(error)}`,
      fallback: true,
    };
  }

  let result: CollectResult;
  try {
    result = await new Promise<CollectResult>((resolve, reject) => {
      chrome.tabs.sendMessage(
        tab.id!,
        { type: "PAGE_AGENT_COLLECT", url: tab.url! },
        (response: CollectResult | undefined) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve(response as CollectResult);
        },
      );
    });
  } catch (error: unknown) {
    return {
      ok: false,
      message: `采集无响应：${error instanceof Error ? error.message : String(error)}`,
      fallback: true,
    };
  }

  switch (result.status) {
    case "collected": {
      const job = toExtractedJob(result, tab.url!);
      if (!job) return { ok: false, message: "岗位信息不完整", status: "collected" };
      await mergeJobs([job]);
      const draft = job.status === "draft_pending_jd";
      return {
        ok: true,
        message: draft ? "已加入购物车（信息不完整，可后续补全）" : "已加入购物车",
        status: "collected",
      };
    }
    case "unsupported":
      return { ok: false, message: "当前页面不是受支持的岗位详情页", status: "unsupported", fallback: true };
    case "ambiguous":
      return { ok: false, message: "页面识别存在歧义，请稍后重试", status: "ambiguous" };
    case "diagnostic":
      return { ok: false, message: "页面规则异常，暂不支持采集", status: "diagnostic", fallback: true };
    case "error":
      return { ok: false, message: `采集失败：${result.reason ?? "未知错误"}`, status: "error", fallback: true };
  }
}

// ---- 消息处理 ----
chrome.runtime.onMessage.addListener(
  (message: Message, _sender, sendResponse: (response: unknown) => void) => {
    switch (message.type) {
      case "JOBS_COLLECTED":
        mergeJobs(message.jobs).then((result) => {
          sendResponse(result);
        });
        return true; // 异步 sendResponse

      case "COLLECT_VIA_PAGE_AGENT":
        collectViaPageAgent().then((result) => {
          sendResponse(result);
        });
        return true;

      case "SYNC_TO_SERVER":
        syncToServer().then((result) => {
          sendResponse(result);
        });
        return true;

      case "GET_STATUS":
        getStatus().then((status) => {
          sendResponse(status);
        });
        return true;

      case "GET_JOBS":
        getJobs().then((jobs) => {
          sendResponse({ jobs });
        });
        return true;

      case "GET_SMART_FILL_PROFILE":
        fetchSmartFillProfilePayload().then(
          (profile) => {
            sendResponse({
              ok: true,
              profile: message.scope === "critical"
                ? selectCriticalSmartFillProfile(profile)
                : profile,
            });
          },
          (error: unknown) => {
            sendResponse({
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            });
          },
        );
        return true;

      case "GET_SMART_FILL_SETTINGS":
        getSmartFillSettings().then((settings) => {
          sendResponse({ ok: true, settings });
        });
        return true;

      case "SAVE_SMART_FILL_SETTINGS":
        saveSmartFillSettings(message.settings).then(() => {
          sendResponse({ ok: true });
        });
        return true;

      case "REQUEST_SMART_FILL_HOST_PERMISSION":
        requestHostPermissionForUrl(message.baseUrl).then(
          () => sendResponse({ ok: true }),
          (error: unknown) =>
            sendResponse({
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            }),
        );
        return true;

      case "CHECK_SMART_FILL_AI_CONNECTION":
        getSmartFillSettings().then(async (settings) => {
          const hasDirectConfig = Boolean(
            settings.baseUrl.trim()
            && settings.apiKey.trim()
            && settings.model.trim(),
          );
          if (!settings.enabled && !hasDirectConfig) {
            sendResponse({
              ok: false,
              channel: "none",
              fallbackUsed: false,
              error: "AI 智填未启用，请先开启开关或补全 API 地址 / Key / 模型后重试",
            });
            return;
          }
          const result = await runPingWithFallback(settings);
          sendResponse(result);
        });
        return true;

      case "SMART_FILL_AI_MAP":
        getSmartFillSettings().then(async (settings) => {
          if (!isSmartFillAiRuntimeEnabled(settings)) {
            sendResponse({ ok: false, channel: "none", fallbackUsed: false, mappings: [], error: "AI 智填未启用" });
            return;
          }
          if (!Array.isArray(message.fields) || message.fields.length === 0) {
            sendResponse({ ok: true, channel: "none", fallbackUsed: false, mappings: [] });
            return;
          }

          try {
            const { profile, profileValues } = await fetchSmartFillProfileContext();
            const contentCatalog = buildRuntimeCatalog(message.catalog, profileValues);
            const serverCatalog = await backendCatalog().catch(() => []);
            const runtimeCatalog = selectAuthoritativeCatalog(serverCatalog, contentCatalog, profileValues);
            const modelSignature = buildSmartFillModelSignature(settings);
            const adapterId = buildSmartFillAdapterHint(message.fields);
            const pageStructureSig = buildSmartFillPageStructureSignature(message.fields);
            const profileSig = simpleHash(buildSmartFillCatalogSignature(runtimeCatalog));
            const siteKeySource = resolveSmartFillCacheScope(settings, message.pageUrl);
            const scopedStructureSig = simpleHash(`${siteKeySource}##${pageStructureSig}`);
            const cacheKey = buildSmartFillMapCacheKey(
              scopedStructureSig,
              profileSig,
              modelSignature,
              adapterId,
            );
            const backendCache = await backendCacheGet({
              cacheKey,
              adapterId,
              modelSignature,
              fields: message.fields,
            }).catch(() => null);
            const cached = backendCache?.hit
              ? {
                  mappings: backendCache.mappings,
                  channel: (backendCache.channel === "plugin-direct" || backendCache.channel === "backend")
                    ? backendCache.channel
                    : "backend",
                  fallbackUsed: backendCache.fallbackUsed,
                  runId: backendCache.runId,
                }
              : await readSmartFillMapCache(cacheKey, settings);
            if (cached) {
              await logSmartFillBackground("cache.hit", {
                key: cacheKey,
                mappings: cached.mappings.length,
                channel: cached.channel,
                fallbackUsed: cached.fallbackUsed,
                runId: (cached as { runId?: string }).runId,
              });
              const runtimeStats: SmartFillRuntimeStats = {
                filledCount: cached.mappings.length,
                pendingCount: Math.max(0, message.fields.length - cached.mappings.length),
                failedCount: 0,
                usedAi: true,
                channel: cached.channel,
                updatedAt: new Date().toISOString(),
              };
              await saveSmartFillRuntime(runtimeStats);
              sendResponse({
                ok: true,
                channel: cached.channel,
                fallbackUsed: cached.fallbackUsed,
                mappings: cached.mappings,
                runId: (cached as { runId?: string }).runId,
              });
              return;
            }

            const result = await runAiMapWithFallback(settings, message.fields, profile, profileValues, runtimeCatalog);
            const runtimeStats: SmartFillRuntimeStats = {
              filledCount: result.mappings.length,
              pendingCount: Math.max(0, message.fields.length - result.mappings.length),
              failedCount: result.ok ? 0 : message.fields.length,
              usedAi: true,
              channel: result.channel,
              updatedAt: new Date().toISOString(),
              errorCode: result.ok ? undefined : "AI_MAP_FAILED",
            };
            if (result.ok && result.channel !== "none") {
              await writeSmartFillMapCache(cacheKey, settings, {
                mappings: result.mappings,
                channel: result.channel,
                fallbackUsed: result.fallbackUsed,
                runId: result.runId,
              });
              await backendCacheSet({
                cacheKey,
                adapterId,
                modelSignature,
                ttlSeconds: Math.max(30, Math.round(Number(settings.cacheTtlSeconds || 300))),
                mappings: result.mappings,
                channel: result.channel,
                fallbackUsed: result.fallbackUsed,
                runId: result.runId,
              }).catch(() => undefined);
              await backendRunLog({
                runId: result.runId,
                logs: [
                  {
                    stage: "ai-map",
                    severity: "info",
                    scope: "run",
                    message: "smart-fill mappings generated",
                    payload: {
                      mappingCount: result.mappings.length,
                      adapterId,
                      channel: result.channel,
                      fallbackUsed: result.fallbackUsed,
                    },
                    ts: new Date().toISOString(),
                  },
                ],
              }).catch(() => undefined);
              await logSmartFillBackground("cache.store", {
                key: cacheKey,
                mappings: result.mappings.length,
                channel: result.channel,
                fallbackUsed: result.fallbackUsed,
                runId: result.runId,
              });
            }
            await saveSmartFillRuntime(runtimeStats);
            sendResponse({
              ...result,
              runId: result.runId,
            });
          } catch (error: unknown) {
            const runtimeStats: SmartFillRuntimeStats = {
              filledCount: 0,
              pendingCount: message.fields.length,
              failedCount: message.fields.length,
              usedAi: true,
              channel: "none",
              updatedAt: new Date().toISOString(),
              errorCode: "AI_MAP_EXCEPTION",
            };
            await saveSmartFillRuntime(runtimeStats);
            sendResponse({
              ok: false,
              channel: "none",
              fallbackUsed: false,
              mappings: [],
              error: error instanceof Error ? error.message : String(error),
            });
          }
        });
        return true;

      case "SMART_FILL_OPTION_MATCH":
        (async () => {
          try {
            const settings = await getSettings();
            const response = await fetchJsonWithTimeout<{
              ok?: boolean;
              value?: string;
              matchType?: string;
              confidence?: number;
            }>(
              `${settings.serverUrl}/api/profile/smart-fill/option-match`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  candidates: message.candidates,
                  resume_value: message.resumeValue,
                  level1_title: message.level1Title,
                  level2_title: message.level2Title,
                }),
              },
              15000,
            );
            sendResponse({
              ok: Boolean(response.ok),
              value: response.value || "",
              matchType: response.matchType || "NONE",
              confidence: response.confidence ?? 0,
            });
          } catch (error: unknown) {
            sendResponse({
              ok: false,
              value: "",
              matchType: "NONE",
              confidence: 0,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        })();
        return true;

      case "SMART_FILL_FIELD_MAP":
        (async () => {
          try {
            const settings = await getSettings();
            const response = await fetchJsonWithTimeout<{
              ok?: boolean;
              mappings?: Array<{
                module_name: string;
                field_label: string;
                item_index: number;
                value: string | null;
                match_type: string;
                archive_path: string | null;
              }>;
            }>(
              `${settings.serverUrl}/api/profile/smart-fill/field-map`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  fragments: message.fragments,
                }),
              },
              15000,
            );
            sendResponse({
              ok: Boolean(response.ok),
              mappings: response.mappings || [],
            });
          } catch (error: unknown) {
            sendResponse({
              ok: false,
              mappings: [],
              error: error instanceof Error ? error.message : String(error),
            });
          }
        })();
        return true;

      case "SMART_FILL_MODULE_COUNT":
        (async () => {
          try {
            const settings = await getSettings();
            const response = await fetchJsonWithTimeout<{
              ok?: boolean;
              modules?: Array<{
                module_name: string;
                field_name: string;
                count: number;
              }>;
            }>(
              `${settings.serverUrl}/api/profile/smart-fill/module-count`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({}),
              },
              15000,
            );
            sendResponse({
              ok: Boolean(response.ok),
              modules: response.modules || [],
            });
          } catch (error: unknown) {
            sendResponse({
              ok: false,
              modules: [],
              error: error instanceof Error ? error.message : String(error),
            });
          }
        })();
        return true;

      case "SMART_FILL_RUN_LOG":
        backendRunLog({
          runId: message.runId,
          logs: message.logs,
        }).then(
          () => sendResponse({ ok: true }),
          (error: unknown) => sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
        return true;

      case "COPY_IMAGE_TO_CLIPBOARD":
        copyImageToClipboardViaOffscreen(message.imageUrl).then((result) => {
          sendResponse(result);
        });
        return true;

      case "OFFSCREEN_WRITE_IMAGE_RESULT": {
        const resolver = pendingClipboardRequests.get(message.requestId);
        if (resolver) {
          resolver({ ok: message.ok, error: message.error });
        }
        return false;
      }

      case "OFFSCREEN_WRITE_IMAGE":
        // Relay message for offscreen page only.
        return false;

      case "OPEN_DRAWER": {
        const tab = message.tab || "settings";
        const url = chrome.runtime.getURL(`popup.html?tab=${tab}`);
        chrome.tabs.create({ url }, () => {
          if (chrome.runtime.lastError) {
            sendResponse({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          sendResponse({ ok: true });
        });
        return true;
      }

      case "REMOVE_JOB":
        removeOneJob(message.hashKey).then((result) => {
          sendResponse(result);
        });
        return true;

      case "REMOVE_JOBS":
        removeManyJobs(message.hashKeys).then((result) => {
          sendResponse(result);
        });
        return true;

      case "CLEAR_JOBS":
        saveJobs([]).then(() => {
          sendResponse({ ok: true });
        });
        return true;

      default:
        sendResponse({ error: "Unknown message type" });
    }
  }
);

// ---- 初始化 badge ----
chrome.runtime.onInstalled.addListener(async () => {
  const jobs = await getJobs();
  await updateBadge(jobs.length);
});

chrome.runtime.onStartup.addListener(async () => {
  const jobs = await getJobs();
  await updateBadge(jobs.length);
});
