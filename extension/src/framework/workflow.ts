// =============================================
// 工作流合同：所有流程使用同一两阶段 Interface
// prepare 只读；confirm 在显式确认后执行。
// =============================================

import type { PageSnapshot } from "./page-snapshot.js";

export interface PageContext {
  url: string;
  snapshot: PageSnapshot;
}

export interface ExtensionWorkflow<Plan, Result> {
  prepare(context: PageContext): Promise<Plan>;
  confirm(planId: string): Promise<Result>;
}

// ---------- 岗位采集（Slice 1 充实） ----------

export interface JobCandidate {
  title: string;
  company: string;
  description: string;
  location?: string;
  salary?: string;
  applyUrl?: string;
  postedAt?: string;
  tags?: string[];
  companyTags?: string[];
  sourceId?: string;
  sourceUrl: string;
}

/** 同步载荷：采集结果 + 本地幂等键（与后端 Job.hash_key 对应） */
export interface SyncJobCandidate extends JobCandidate {
  hashKey: string;
  salaryMin?: number | null;
  salaryMax?: number | null;
  education?: string;
  experience?: string;
  jobType?: string;
  companySize?: string;
  companyIndustry?: string;
}

export interface JobImportPlan {
  planId: string;
  candidates: JobCandidate[];
  packId: string;
  packVersion: string;
  createdAt: number;
}

export interface JobImportResult {
  planId: string;
  createdCount: number;
  skippedCount: number;
  perItem: Array<{ index: number; status: "created" | "skipped" | "failed"; reason?: string }>;
}

// ---------- 安全填表（Slice 2 充实） ----------

export interface FillProjectionField {
  intent: string;
  value: string;
  sensitivity: "safe" | "sensitive" | "commitment";
}

export interface FillProjection {
  jobId: string;
  fields: FillProjectionField[];
  issuedAt: number;
}

export interface FillPlan {
  planId: string;
  url: string;
  fingerprint: string;
  expiresAt: number;
  fields: Array<{
    intent: string;
    previewMasked: string;
    status: "match" | "missing" | "ambiguous" | "protected";
  }>;
}

export interface FillResult {
  planId: string;
  outcome: Array<{
    intent: string;
    result: "written" | "skipped" | "protected" | "failed";
    reason?: string;
  }>;
}

// ---------- 提交候选证据（Slice 3 充实） ----------

export interface ReceiptEvidence {
  company: string;
  role: string;
  applicationId?: string;
  occurredAt: number;
  sourceUrl: string;
  sourceHash: string;
}

export interface SubmissionCandidate {
  candidateId: string;
  evidence: ReceiptEvidence;
  createdAt: number;
}

export interface SubmissionResult {
  candidateId: string;
  status: "created" | "already-processed";
  attemptId?: string;
}
