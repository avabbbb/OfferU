// =============================================
// OfferUControl port：OfferU 是远程但自有依赖
// 生产使用本机 HTTP Adapter（:8766），测试使用内存 Adapter。
// 只投影允许的 Registry Operations，不暴露 raw DB 或任意 HTTP。
// =============================================

import type {
  FillProjection,
  JobImportPlan,
  JobImportResult,
  ReceiptEvidence,
  SubmissionCandidate,
  SubmissionResult,
  SyncJobCandidate,
} from "./workflow.js";

export interface ConnectionState {
  ok: boolean;
  backendUrl: string;
  error?: string;
}

export interface RedactedFillOutcome {
  planId: string;
  jobId: string;
  url: string;
  outcome: Array<{ intent: string; result: "written" | "skipped" | "protected" | "failed"; reason?: string }>;
}

/** 招聘站点登录态的后端状态；只描述"能不能用"，不回传凭据本身。 */
export interface ScraperSessionState {
  configured: boolean;
  hasWt2: boolean;
  hasZpToken: boolean;
  message: string;
}

export interface OfferUControl {
  probe(): Promise<ConnectionState>;
  /** 把本机浏览器的站点登录态交给 OfferU；凭据只存在于本次调用内。 */
  updateScraperSession(provider: string, cookie: string): Promise<ScraperSessionState>;
  getScraperSession(provider: string): Promise<ScraperSessionState>;
  prepareJobImport(input: SyncJobCandidate[]): Promise<JobImportPlan>;
  confirmJobImport(planId: string): Promise<JobImportResult>;
  getFillProjection(jobId: string): Promise<FillProjection>;
  recordFillOutcome(outcome: RedactedFillOutcome): Promise<void>;
  createSubmissionCandidate(input: ReceiptEvidence): Promise<SubmissionCandidate>;
  confirmSubmissionCandidate(candidateId: string): Promise<SubmissionResult>;
}
