import { isFixtureDataMode, type JobResearchRunDetail, type ResumeOptimizationProposalDetail, type RoleBenchmarkArtifactVerification, type RoleBenchmarkDetail } from "@/lib/api";
import type { CareerTask } from "@/lib/hooks";

export type JobPreparationProgressState =
  | "done"
  | "active"
  | "pending"
  | "needs_review"
  | "prepared"
  | "adopted"
  | "rejected"
  | "failed"
  | "blocked"
  | "unavailable"
  | "mismatch";

export interface JobPreparationProgressStage {
  key: string;
  label: string;
  state: JobPreparationProgressState;
}

export interface RoleBenchmarkLoadState {
  benchmark: RoleBenchmarkDetail | null;
  loading: boolean;
  error: string;
}

export interface JobPreparationProgressInput {
  jobId: number | null;
  preparationTask: CareerTask | null;
  preApplicationStage: string | null;
  research: JobResearchRunDetail | null;
  researchLoading: boolean;
  researchError: string;
  benchmark: RoleBenchmarkDetail | null;
  benchmarkLoading: boolean;
  benchmarkError: string;
  proposal: ResumeOptimizationProposalDetail | null;
  proposalLoading: boolean;
  proposalError: string;
}

const JOB_RESEARCH_SCHEMA = "offeru.job_research_result.v1";

function roleTaskStage(task: CareerTask): JobPreparationProgressStage {
  if (task.runtime_provider === "replay") {
    switch (task.status) {
      case "queued":
        return { key: "task", label: "岗位情报回放等待开始（仅用于验收）", state: "pending" };
      case "running":
        return { key: "task", label: "正在运行岗位情报回放（仅用于验收）", state: "active" };
      case "waiting_for_approval":
        return { key: "task", label: "岗位情报回放待审核（仅用于验收）", state: "needs_review" };
      case "completed":
        return { key: "task", label: "岗位情报回放已完成（仅用于验收）", state: "prepared" };
      case "failed":
        return { key: "task", label: "岗位情报回放失败", state: "failed" };
      case "blocked":
        return { key: "task", label: "岗位情报回放受阻", state: "blocked" };
      case "cancelled":
        return { key: "task", label: "岗位情报回放已取消", state: "unavailable" };
      default:
        return { key: "task", label: "岗位情报回放状态不可用", state: "unavailable" };
    }
  }
  switch (task.status) {
    case "queued":
      return { key: "task", label: "岗位情报任务等待开始", state: "pending" };
    case "running":
      return { key: "task", label: "正在准备岗位情报", state: "active" };
    case "waiting_for_approval":
      return { key: "task", label: "岗位情报任务待审核", state: "needs_review" };
    case "completed":
      return { key: "task", label: "岗位情报任务已完成", state: "done" };
    case "failed":
      return { key: "task", label: "岗位情报任务失败", state: "failed" };
    case "blocked":
      return { key: "task", label: "岗位情报任务受阻", state: "blocked" };
    case "cancelled":
      return { key: "task", label: "岗位情报任务已取消", state: "unavailable" };
    default:
      return { key: "task", label: "岗位情报任务状态不可用", state: "unavailable" };
  }
}

function researchStage(input: JobPreparationProgressInput): JobPreparationProgressStage {
  const { jobId, research } = input;
  if (input.researchLoading) return { key: "research", label: "正在读取岗位研究", state: "active" };
  if (input.researchError) return { key: "research", label: "岗位研究暂不可用", state: "unavailable" };
  if (!research) return { key: "research", label: "岗位研究不可用", state: "unavailable" };
  if (!research.run_id || !Number.isInteger(research.job_id) || research.job_id !== jobId) {
    return { key: "research", label: "岗位研究结果与当前岗位不符", state: "mismatch" };
  }

  if (research.status === "failed") return { key: "research", label: "岗位研究失败", state: "failed" };
  if (research.status === "blocked") return { key: "research", label: "岗位研究受阻", state: "blocked" };
  if (research.status === "pending" || research.status === "running") {
    return { key: "research", label: research.status === "pending" ? "岗位研究等待执行" : "正在进行岗位研究", state: research.status === "pending" ? "pending" : "active" };
  }
  if (research.status !== "completed") return { key: "research", label: "岗位研究状态不可用", state: "unavailable" };

  if (
    research.result?.schema !== JOB_RESEARCH_SCHEMA
    || !research.runtime_version
    || research.source_count < 1
    || research.evidence?.length < 1
  ) {
    return { key: "research", label: "岗位研究版本无法验证", state: "mismatch" };
  }
  if (research.data_mode !== "live" && !isFixtureDataMode(research.data_mode)) {
    return { key: "research", label: "岗位研究来源无法验证", state: "mismatch" };
  }

  if (isFixtureDataMode(research.data_mode)) {
    return research.review_status === "accepted"
      ? { key: "research", label: "样本岗位研究已审核", state: "prepared" }
      : research.review_status === "rejected"
        ? { key: "research", label: "岗位研究已拒绝", state: "rejected" }
        : { key: "research", label: "岗位研究待审核", state: "needs_review" };
  }
  if (research.review_status === "accepted") return { key: "research", label: "岗位研究已审核", state: "done" };
  if (research.review_status === "candidate" || research.review_status === "pending") {
    return { key: "research", label: "岗位研究待审核", state: "needs_review" };
  }
  if (research.review_status === "rejected") return { key: "research", label: "岗位研究已拒绝", state: "rejected" };
  return { key: "research", label: "岗位研究不可用", state: "unavailable" };
}

export type RoleBenchmarkArtifactProjection =
  | "verified"
  | "fixture"
  | "replay"
  | "insufficient_sample"
  | "fixture_insufficient_sample"
  | "unverified";

export interface RoleBenchmarkArtifactReadback {
  data_mode?: string | null;
  benchmark_status?: string;
  sample_sufficient?: boolean;
  valid_sample_count?: number | null;
  minimum_sample_count?: number | null;
  artifact_verification?: RoleBenchmarkArtifactVerification | null;
}

const LIVE_BENCHMARK_MODES = ["live", "live_backend", "live_plugin"];
const FIXTURE_VERIFICATION_REASON = "fixture_or_unknown_data_mode";
const SAMPLE_VERIFICATION_REASON = "sample_metadata_mismatch";

function verifiedTargetSnapshot(verification: RoleBenchmarkArtifactVerification | null | undefined) {
  return verification?.target_snapshot?.exists === true && verification.target_snapshot.verified === true;
}

export function projectRoleBenchmarkArtifact(benchmark: RoleBenchmarkArtifactReadback): RoleBenchmarkArtifactProjection {
  const verification = benchmark.artifact_verification;
  if (!verification || typeof verification.ready !== "boolean"
    || !["verified", "unverified"].includes(verification.status)
    || !Array.isArray(verification.reasons)
    || !verifiedTargetSnapshot(verification)) return "unverified";

  const reasons = verification.reasons;
  const insufficient = benchmark.sample_sufficient === false
    || benchmark.benchmark_status === "INSUFFICIENT_SAMPLE"
    || (typeof benchmark.valid_sample_count === "number"
      && typeof benchmark.minimum_sample_count === "number"
      && benchmark.minimum_sample_count > 0
      && benchmark.valid_sample_count < benchmark.minimum_sample_count);
  if (LIVE_BENCHMARK_MODES.includes(String(benchmark.data_mode || ""))) {
    if (!insufficient && verification.ready === true && verification.status === "verified" && reasons.length === 0) return "verified";
    if (insufficient && verification.ready === false && verification.status === "unverified"
      && reasons.length === 1 && reasons[0] === SAMPLE_VERIFICATION_REASON) return "insufficient_sample";
    return "unverified";
  }

  const fixtureMode = isFixtureDataMode(benchmark.data_mode);
  if (fixtureMode && verification.ready === false && verification.status === "unverified") {
    if (insufficient && reasons.length === 2
      && reasons.includes(FIXTURE_VERIFICATION_REASON)
      && reasons.includes(SAMPLE_VERIFICATION_REASON)) return "fixture_insufficient_sample";
    if (!insufficient && benchmark.sample_sufficient === true
      && reasons.length === 1 && reasons[0] === FIXTURE_VERIFICATION_REASON) return "fixture";
    return "unverified";
  }

  if (benchmark.data_mode === "replay"
    && benchmark.sample_sufficient === true
    && verification.ready === false
    && verification.status === "unverified"
    && reasons.length === 1
    && reasons[0] === FIXTURE_VERIFICATION_REASON) return "replay";
  return "unverified";
}

const BENCHMARK_VERIFICATION_REASON_LABELS: Record<string, string> = {
  run_not_completed: "运行尚未完成",
  fixture_or_unknown_data_mode: "数据来源不是已验证的实时来源",
  runtime_metadata_missing: "运行时版本信息缺失",
  schema_mismatch: "产物格式版本不匹配",
  algorithm_mismatch: "算法版本不匹配",
  taxonomy_mismatch: "能力分类版本不匹配",
  sample_metadata_mismatch: "样本信息不匹配",
  comparator_snapshot_count_mismatch: "参考岗位快照数量不匹配",
  target_job_mismatch: "产物关联了其他岗位",
  target_snapshot_missing_or_ambiguous: "当前岗位快照缺失或重复",
  target_snapshot_mismatch: "当前岗位 JD 快照已变化",
};

export function roleBenchmarkArtifactVerificationLabel(benchmark: RoleBenchmarkArtifactReadback): string {
  const verification = benchmark.artifact_verification;
  if (!verification) return "岗位基准验证信息缺失";
  if (!verifiedTargetSnapshot(verification)) return "岗位基准当前岗位快照未验证";
  return "岗位基准完整性未验证";
}

export function roleBenchmarkArtifactVerificationMessage(benchmark: RoleBenchmarkArtifactReadback): string {
  const verification = benchmark.artifact_verification;
  if (!verification) return "岗位基准验证信息缺失，无法确认这份结果是否匹配当前岗位。";
  const reasons = Array.isArray(verification.reasons) ? verification.reasons : [];
  const details = reasons.map((reason) => BENCHMARK_VERIFICATION_REASON_LABELS[reason]).filter(Boolean);
  if (!details.length) return "岗位基准完整性尚未通过后端验证，已隐藏这份数据。";
  return `岗位基准验证未通过：${details.join("；")}。`;
}

function roleBenchmarkStage(input: JobPreparationProgressInput): JobPreparationProgressStage {
  const { jobId, benchmark } = input;
  if (input.benchmarkLoading && !benchmark) return { key: "benchmark", label: "正在读取岗位基准状态", state: "active" };
  if (!benchmark && input.benchmarkError) return { key: "benchmark", label: "岗位基准状态暂不可用", state: "unavailable" };
  if (!benchmark || benchmark.found === false) return { key: "benchmark", label: "岗位基准尚未构建", state: "pending" };

  if (benchmark.status === "failed") return { key: "benchmark", label: "岗位基准失败", state: "failed" };
  if (benchmark.status === "blocked") return { key: "benchmark", label: "岗位基准受阻", state: "blocked" };
  if (benchmark.status === "pending" || benchmark.status === "running") {
    return { key: "benchmark", label: benchmark.status === "pending" ? "岗位基准等待执行" : "正在分析岗位基准", state: benchmark.status === "pending" ? "pending" : "active" };
  }
  if (benchmark.status !== "completed") return { key: "benchmark", label: "岗位基准状态无法确认", state: "unavailable" };

  const artifact = projectRoleBenchmarkArtifact(benchmark);
  if (artifact === "insufficient_sample") return { key: "benchmark", label: "岗位基准样本不足", state: "needs_review" };
  if (artifact === "fixture_insufficient_sample") return { key: "benchmark", label: "样本岗位基准样本不足（仅用于验收）", state: "needs_review" };
  if (artifact === "fixture") return { key: "benchmark", label: "样本岗位基准已生成", state: "prepared" };
  if (artifact === "replay") return { key: "benchmark", label: "岗位基准回放结果（仅用于验收）", state: "prepared" };
  if (artifact === "verified") return { key: "benchmark", label: "岗位基准已就绪", state: "done" };
  return { key: "benchmark", label: roleBenchmarkArtifactVerificationLabel(benchmark), state: "mismatch" };
}

function decisionStage(stage: string): JobPreparationProgressStage {
  const stages: Record<string, Omit<JobPreparationProgressStage, "key">> = {
    research_pending: { label: "投前决策等待岗位研究", state: "active" },
    research_failed: { label: "投前岗位研究失败", state: "failed" },
    needs_decision: { label: "投前决策待生成", state: "pending" },
    needs_decision_review: { label: "投前决策待审核", state: "needs_review" },
    decision_ready: { label: "投前决策已完成", state: "done" },
    ready_for_resume_proposal: { label: "已确认可以准备简历提案", state: "done" },
    resume_proposal_ready: { label: "已进入简历准备阶段", state: "done" },
    completed_no_go: { label: "已确认暂不投递", state: "done" },
    completed_insufficient_evidence: { label: "已确认申请证据不足", state: "done" },
  };
  const projection = stages[stage];
  return projection ? { key: "decision", ...projection } : { key: "decision", label: "投前决策状态待核对", state: "unavailable" };
}

function proposalStage(input: JobPreparationProgressInput): JobPreparationProgressStage {
  const { jobId, proposal } = input;
  if (input.proposalLoading) return { key: "proposal", label: "正在读取简历提案", state: "active" };
  if (input.proposalError) return { key: "proposal", label: "简历提案暂不可用", state: "unavailable" };
  if (!proposal) return { key: "proposal", label: "简历提案尚未生成", state: "pending" };
  if (!proposal.proposal_id || proposal.job_id !== jobId) {
    return { key: "proposal", label: "简历提案与当前岗位不符", state: "mismatch" };
  }
  if (proposal.status === "ready") return { key: "proposal", label: "简历提案待审核", state: "prepared" };
  if (proposal.status === "in_review") return { key: "proposal", label: "简历提案审核中", state: "needs_review" };
  if (proposal.status === "accepted") {
    return proposal.accepted_resume_id && proposal.accepted_resume_version_id
      ? { key: "proposal", label: "简历版本已采纳", state: "adopted" }
      : { key: "proposal", label: "已接受的简历版本无法验证", state: "mismatch" };
  }
  if (proposal.status === "rejected") return { key: "proposal", label: "简历提案已拒绝", state: "rejected" };
  if (proposal.status === "stale") return { key: "proposal", label: "简历提案已过期，需要重新生成", state: "mismatch" };
  if (proposal.status === "blocked") return { key: "proposal", label: "简历提案生成受阻", state: "blocked" };
  if (proposal.status === "failed") return { key: "proposal", label: "简历提案生成失败", state: "failed" };
  return { key: "proposal", label: "简历提案状态无法确认", state: "unavailable" };
}

export function projectJobPreparationProgress(input: JobPreparationProgressInput): JobPreparationProgressStage[] {
  if (!input.jobId) return [];
  const stages: JobPreparationProgressStage[] = [
    { key: "saved", label: "岗位已保存", state: "done" },
  ];
  if (input.preparationTask) stages.push(roleTaskStage(input.preparationTask));
  stages.push(researchStage(input), roleBenchmarkStage(input));
  if (input.preApplicationStage) {
    stages.push(decisionStage(input.preApplicationStage));
  }
  stages.push(proposalStage(input));
  return stages;
}
