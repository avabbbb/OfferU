// =============================================
// OfferUControl port：OfferU 是远程但自有依赖
// 生产使用本机 HTTP Adapter（:8765），测试使用内存 Adapter。
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

export interface OfferUControl {
  probe(): Promise<ConnectionState>;
  prepareJobImport(input: SyncJobCandidate[]): Promise<JobImportPlan>;
  confirmJobImport(planId: string): Promise<JobImportResult>;
  getFillProjection(jobId: string): Promise<FillProjection>;
  recordFillOutcome(outcome: RedactedFillOutcome): Promise<void>;
  createSubmissionCandidate(input: ReceiptEvidence): Promise<SubmissionCandidate>;
  confirmSubmissionCandidate(candidateId: string): Promise<SubmissionResult>;
}
