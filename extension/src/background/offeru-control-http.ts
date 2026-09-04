// =============================================
// HttpOfferUControl：OfferUControl port 的生产 HTTP Adapter
// 固定指向本机后端（默认 http://127.0.0.1:8765），只投影允许的 Registry
// Operations；规则包不能指定 endpoint，浏览器不直连数据库。
// EXT-JOB-002 只实现岗位同步三件套；填表/候选接口由后续切片实现。
// =============================================

import type {
  ConnectionState,
  OfferUControl,
  RedactedFillOutcome,
} from "../framework/offeru-control.js";
import type {
  FillProjection,
  JobImportPlan,
  JobImportResult,
  ReceiptEvidence,
  SubmissionCandidate,
  SubmissionResult,
  SyncJobCandidate,
} from "../framework/workflow.js";
import {
  DEFAULT_OFFERU_SERVER_URL,
  normalizeOfferUServerUrl,
} from "./server-url.js";
import { safeExtensionError } from "../lib/safe-error.js";

export const DEFAULT_BACKEND_URL = DEFAULT_OFFERU_SERVER_URL;
const SYNC_TIMEOUT_MS = 15000;

interface IngestPayloadItem {
  title: string;
  company: string;
  location: string;
  url: string;
  apply_url: string;
  source: string;
  raw_description: string;
  posted_at?: string | null;
  hash_key: string;
  salary_min: number | null;
  salary_max: number | null;
  salary_text: string;
  education: string;
  experience: string;
  job_type: string;
  company_size: string;
  company_industry: string;
}

interface IngestResponse {
  created?: number;
  skipped?: number;
  batch_id?: string;
  accepted_hash_keys?: string[];
  created_hash_keys?: string[];
  skipped_hash_keys?: string[];
}

function isOfferUHealthIdentity(payload: {
  status?: unknown;
  service?: unknown;
  runtime?: unknown;
  version?: unknown;
  build_mode?: unknown;
}): boolean {
  return (
    payload.status === "ok" &&
    payload.service === "OfferU" &&
    payload.runtime === "python" &&
    typeof payload.version === "string" &&
    payload.version.trim().length > 0 &&
    (payload.build_mode === "local-development" || payload.build_mode === "release")
  );
}

export class HttpOfferUControl implements OfferUControl {
  private readonly plans = new Map<string, { candidates: SyncJobCandidate[]; createdAt: number }>();
  private readonly baseUrl: string;

  constructor(baseUrl: string = DEFAULT_BACKEND_URL) {
    this.baseUrl = normalizeOfferUServerUrl(baseUrl || DEFAULT_OFFERU_SERVER_URL);
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SYNC_TIMEOUT_MS);
    try {
      const resp = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        redirect: "error",
        signal: controller.signal,
      });
      if (!resp.ok) {
        const errorId = resp.headers.get("X-OfferU-Error-Id")?.trim();
        throw new Error(errorId ? `HTTP ${resp.status}（错误 ID: ${errorId}）` : `HTTP ${resp.status}`);
      }
      return (await resp.json()) as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  async probe(): Promise<ConnectionState> {
    try {
      const health = await this.request<{
        status?: string;
        service?: string;
        runtime?: string;
        version?: string;
        build_mode?: string;
      }>("/api/health");
      return {
        ok: isOfferUHealthIdentity(health),
        backendUrl: this.baseUrl,
        error: undefined,
      };
    } catch (error: unknown) {
      return {
        ok: false,
        backendUrl: this.baseUrl,
        error: safeExtensionError(error, "无法连接 OfferU 后端"),
      };
    }
  }

  /** prepare 是本地只读计划：绑定候选与幂等键，不发网络请求 */
  async prepareJobImport(input: SyncJobCandidate[]): Promise<JobImportPlan> {
    const planId = `import-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.plans.set(planId, { candidates: [...input], createdAt: Date.now() });
    return {
      planId,
      candidates: input.map(({ hashKey: _hashKey, ...candidate }) => candidate),
      packId: "browser-extension",
      packVersion: "0",
      createdAt: Date.now(),
    };
  }

  /** confirm 是显式确认后的执行：POST /api/jobs/ingest（薄 Adapter 背后是 import_job_batch Operation） */
  async confirmJobImport(planId: string): Promise<JobImportResult> {
    const plan = this.plans.get(planId);
    if (!plan) {
      return {
        planId,
        createdCount: 0,
        skippedCount: 0,
        perItem: [],
      };
    }
    const batchId = `offeru-ext-${Date.now()}`;
    const payload = {
      jobs: plan.candidates.map((candidate) => toIngestPayloadItem(candidate)),
      source: "offeru-extension",
      batch_id: batchId,
    };
    const data = await this.request<IngestResponse>("/api/jobs/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const createdKeys = new Set(data.created_hash_keys ?? []);
    const skippedKeys = new Set(data.skipped_hash_keys ?? []);
    const acceptedKeys = new Set(data.accepted_hash_keys ?? []);

    const perItem = plan.candidates.map((candidate, index) => {
      if (createdKeys.has(candidate.hashKey)) {
        return { index, status: "created" as const };
      }
      if (skippedKeys.has(candidate.hashKey)) {
        return { index, status: "skipped" as const };
      }
      if (acceptedKeys.has(candidate.hashKey)) {
        return { index, status: "skipped" as const };
      }
      return { index, status: "failed" as const, reason: "no per-item confirmation" };
    });

    const confirmed = perItem.filter((item) => item.status !== "failed");
    if (confirmed.length === 0 && plan.candidates.length > 0) {
      throw new Error("后端未返回逐条同步确认，已保留插件本地队列");
    }

    return {
      planId,
      createdCount: perItem.filter((item) => item.status === "created").length,
      skippedCount: perItem.filter((item) => item.status === "skipped").length,
      perItem,
    };
  }

  getFillProjection(_jobId: string): Promise<FillProjection> {
    throw new Error("getFillProjection 由 EXT-FILL 切片实现");
  }

  recordFillOutcome(_outcome: RedactedFillOutcome): Promise<void> {
    throw new Error("recordFillOutcome 由 EXT-FILL 切片实现");
  }

  createSubmissionCandidate(_input: ReceiptEvidence): Promise<SubmissionCandidate> {
    throw new Error("createSubmissionCandidate 由 EXT-RECEIPT 切片实现");
  }

  confirmSubmissionCandidate(_candidateId: string): Promise<SubmissionResult> {
    throw new Error("confirmSubmissionCandidate 由 EXT-RECEIPT 切片实现");
  }
}

export function toIngestPayloadItem(candidate: SyncJobCandidate): IngestPayloadItem {
  return {
    title: candidate.title,
    company: candidate.company,
    location: candidate.location ?? "",
    url: candidate.sourceUrl,
    apply_url: candidate.applyUrl ?? "",
    source: "offeru-extension",
    raw_description: candidate.description,
    posted_at: candidate.postedAt ?? null,
    hash_key: candidate.hashKey,
    salary_min: candidate.salaryMin ?? null,
    salary_max: candidate.salaryMax ?? null,
    salary_text: candidate.salary ?? "",
    education: candidate.education ?? "",
    experience: candidate.experience ?? "",
    job_type: candidate.jobType ?? "",
    company_size: candidate.companySize ?? "",
    company_industry: candidate.companyIndustry ?? "",
  };
}
