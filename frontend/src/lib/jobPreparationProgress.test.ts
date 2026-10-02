import { describe, expect, it } from "vitest";
import type {
  JobResearchRunDetail,
  ResumeOptimizationProposalDetail,
  RoleBenchmarkDetail,
} from "@/lib/api";
import type { CareerTask } from "@/lib/hooks";
import {
  projectJobPreparationProgress,
  type JobPreparationProgressInput,
} from "./jobPreparationProgress";

const benchmark = (overrides: Partial<RoleBenchmarkDetail> = {}) => ({
  found: true,
  run_id: "benchmark-42-v3",
  target_job_id: 42,
  target_job: { id: 42, title: "Backend Engineer", company: "Example", url: "" },
  status: "completed",
  benchmark_status: "READY",
  sample_sufficient: true,
  artifact_verification: { ready: true, status: "verified", reasons: [], target_snapshot: { exists: true, verified: true } },
  schema_version: "offeru.role_benchmark_candidate.v1",
  algorithm_version: "role_benchmark.v1",
  taxonomy_version: "role_capability_aliases.v1",
  data_mode: "live_backend",
  documents: [{ id: 1, job_id: 42, document_kind: "target" }],
  ...overrides,
}) as RoleBenchmarkDetail;

const research = (overrides: Partial<JobResearchRunDetail> = {}) => ({
  run_id: "research-42-v1",
  job_id: 42,
  runtime_id: "backend_search",
  runtime_version: "backend-search-v1",
  data_mode: "live",
  status: "completed",
  review_status: "candidate",
  review_note: "",
  attempts: 1,
  source_count: 2,
  finding_count: 1,
  error: null,
  error_id: null,
  created_at: "2026-10-02T00:00:00Z",
  updated_at: "2026-10-02T00:00:00Z",
  report_markdown: "",
  result: { schema: "offeru.job_research_result.v1", sources: [{ source_ref: "S1" }] },
  trace: {},
  evidence: [{ id: 1 }],
  findings: [],
  ...overrides,
}) as JobResearchRunDetail;

const task = (overrides: Partial<CareerTask> = {}) => ({
  task_id: "task-42",
  task_type: "role_intelligence",
  source: "automation",
  target_type: "job",
  target_id: "42",
  runtime_provider: "codex",
  status: "completed",
  input: {},
  progress: { stage: "completed" },
  error_id: "",
  error: "",
  retryable: false,
  attempt_count: 1,
  max_attempts: 2,
  result_ref: "career-task:assessment-only",
  result: {},
  created_at: null,
  started_at: null,
  finished_at: null,
  ...overrides,
}) as CareerTask;

const proposal = (overrides: Partial<ResumeOptimizationProposalDetail> = {}) => ({
  proposal_id: "proposal-42",
  status: "ready",
  job_id: 42,
  job_title: "Backend Engineer",
  company: "Example",
  profile_id: 1,
  research_run_id: "research-42-v1",
  change_count: 1,
  fact_gate_status: "passed",
  fact_gate_warnings_count: 0,
  accepted_resume_id: null,
  accepted_resume_version_id: null,
  review_note: "",
  created_at: "2026-10-02T00:00:00Z",
  updated_at: "2026-10-02T00:00:00Z",
  source_section_ids: [],
  source_snapshot_hash: "source-hash",
  research_snapshot_hash: "research-hash",
  original_summary: "",
  proposed_summary: "",
  original_rows: [],
  proposed_rows: [],
  diff: [],
  strategy: {},
  presentation: {},
  fact_gates: {},
  trace: {},
  ...overrides,
}) as ResumeOptimizationProposalDetail;

function project(overrides: Partial<JobPreparationProgressInput> = {}) {
  return projectJobPreparationProgress({
    jobId: 42,
    preparationTask: null,
    preApplicationStage: null,
    research: null,
    researchLoading: false,
    researchError: "",
    benchmark: null,
    benchmarkLoading: false,
    benchmarkError: "",
    proposal: null,
    proposalLoading: false,
    proposalError: "",
    ...overrides,
  });
}

function stage(key: string, stages = project()) {
  const value = stages.find((item) => item.key === key);
  if (!value) throw new Error(`Missing progress stage: ${key}`);
  return value;
}

describe("projectJobPreparationProgress", () => {
  it("does not infer a built benchmark from a completed task or decision stage", () => {
    const stages = project({
      preparationTask: task(),
      preApplicationStage: "decision_ready",
    });

    expect(stage("task", stages)).toMatchObject({ label: "岗位情报任务已完成", state: "done" });
    expect(stage("benchmark", stages)).toMatchObject({ label: "岗位基准尚未构建", state: "pending" });
    expect(stage("research", stages)).toMatchObject({ label: "岗位研究不可用", state: "unavailable" });
    expect(stage("decision", stages)).toMatchObject({ label: "投前决策已完成", state: "done" });
    expect(stages.some((item) => item.label === "同类岗位基准分析完成")).toBe(false);
  });

  it("keeps a completed replay visibly separate from a completed live task", () => {
    expect(stage("task", project({ preparationTask: task({ runtime_provider: "replay" }) }))).toMatchObject({
      label: "岗位情报回放已完成（仅用于验收）",
      state: "prepared",
    });
    expect(stage("benchmark", project({ benchmark: benchmark({
      data_mode: "replay",
      artifact_verification: { ready: false, status: "unverified", reasons: ["fixture_or_unknown_data_mode"], target_snapshot: { exists: true, verified: true } },
    }) }))).toMatchObject({
      label: "岗位基准回放结果（仅用于验收）",
      state: "prepared",
    });
  });

  it("uses backend artifact verification as the benchmark readiness authority", () => {
    const done = project({ benchmark: benchmark() });
    expect(stage("benchmark", done)).toMatchObject({ label: "岗位基准已就绪", state: "done" });

    expect(stage("benchmark", project({ benchmark: benchmark({
      target_job_id: 99,
      artifact_verification: { ready: false, status: "unverified", reasons: ["target_job_mismatch"], target_snapshot: { exists: true, verified: false } },
    }) }))).toMatchObject({
      label: "岗位基准当前岗位快照未验证",
      state: "mismatch",
    });
    expect(stage("benchmark", project({ benchmark: benchmark({
      algorithm_version: "",
      artifact_verification: { ready: false, status: "unverified", reasons: ["algorithm_mismatch"], target_snapshot: { exists: true, verified: true } },
    }) }))).toMatchObject({
      label: "岗位基准完整性未验证",
      state: "mismatch",
    });
    expect(stage("benchmark", project({ benchmark: benchmark({ artifact_verification: undefined }) }))).toMatchObject({
      label: "岗位基准验证信息缺失",
      state: "mismatch",
    });
  });

  it("keeps insufficient and fixture benchmarks distinct from live-ready output", () => {
    expect(stage("benchmark", project({ benchmark: benchmark({
      sample_sufficient: false,
      benchmark_status: "INSUFFICIENT_SAMPLE",
      artifact_verification: { ready: false, status: "unverified", reasons: ["sample_metadata_mismatch"], target_snapshot: { exists: true, verified: true } },
    }) }))).toMatchObject({
      label: "岗位基准样本不足",
      state: "needs_review",
    });
    expect(stage("benchmark", project({ benchmark: benchmark({
      data_mode: "fixture",
      artifact_verification: { ready: false, status: "unverified", reasons: ["fixture_or_unknown_data_mode"], target_snapshot: { exists: true, verified: true } },
    }) }))).toMatchObject({
      label: "样本岗位基准已生成",
      state: "prepared",
    });
    expect(stage("benchmark", project({ benchmark: benchmark({
      data_mode: "unrecognized",
      artifact_verification: { ready: false, status: "unverified", reasons: ["fixture_or_unknown_data_mode"], target_snapshot: { exists: true, verified: true } },
    }) }))).toMatchObject({
      label: "岗位基准完整性未验证",
      state: "mismatch",
    });
  });

  it.each([
    ["failed", "岗位基准失败", "failed"],
    ["blocked", "岗位基准受阻", "blocked"],
    ["running", "正在分析岗位基准", "active"],
  ])("projects benchmark status %s independently", (status, label, state) => {
    expect(stage("benchmark", project({ benchmark: benchmark({ status }) }))).toMatchObject({
      label,
      state,
    });
  });

  it("requires a versioned, job-bound research artifact and exposes review state", () => {
    expect(stage("research", project({ research: research() }))).toMatchObject({
      label: "岗位研究待审核",
      state: "needs_review",
    });
    expect(stage("research", project({ research: research({ review_status: "accepted" }) }))).toMatchObject({
      label: "岗位研究已审核",
      state: "done",
    });
    expect(stage("research", project({ research: research({ review_status: "accepted", data_mode: "fixture" }) }))).toMatchObject({
      label: "样本岗位研究已审核",
      state: "prepared",
    });
    expect(stage("research", project({ research: research({ job_id: 99 }) }))).toMatchObject({
      label: "岗位研究结果与当前岗位不符",
      state: "mismatch",
    });
    expect(stage("research", project({ research: research({ runtime_version: null }) }))).toMatchObject({
      label: "岗位研究版本无法验证",
      state: "mismatch",
    });
    expect(stage("research", project({ research: research({ data_mode: "unrecognized" }) }))).toMatchObject({
      label: "岗位研究来源无法验证",
      state: "mismatch",
    });
    expect(stage("research", project({ research: research({ result: { schema: "unknown" } }) }))).toMatchObject({
      label: "岗位研究版本无法验证",
      state: "mismatch",
    });
  });

  it("preserves distinct research failure and unavailable states", () => {
    expect(stage("research", project({ research: research({ status: "failed", review_status: "not_available" }) }))).toMatchObject({
      label: "岗位研究失败",
      state: "failed",
    });
    expect(stage("research", project({ research: research({ status: "blocked", review_status: "not_available" }) }))).toMatchObject({
      label: "岗位研究受阻",
      state: "blocked",
    });
    expect(stage("research", project({ researchLoading: true }))).toMatchObject({
      label: "正在读取岗位研究",
      state: "active",
    });
    expect(stage("research", project({ researchError: "network down" }))).toMatchObject({
      label: "岗位研究暂不可用",
      state: "unavailable",
    });
  });

  it("projects a prepared proposal separately from an adopted version", () => {
    expect(stage("proposal", project({ proposal: proposal() }))).toMatchObject({
      label: "简历提案待审核",
      state: "prepared",
    });
    expect(stage("proposal", project({ proposal: proposal({
      status: "accepted",
      accepted_resume_id: 7,
      accepted_resume_version_id: 3,
    }) }))).toMatchObject({
      label: "简历版本已采纳",
      state: "adopted",
    });
    expect(stage("proposal", project({ proposal: proposal({ status: "accepted" }) }))).toMatchObject({
      label: "已接受的简历版本无法验证",
      state: "mismatch",
    });
    expect(stage("proposal", project({ proposal: proposal({ job_id: 99 }) }))).toMatchObject({
      label: "简历提案与当前岗位不符",
      state: "mismatch",
    });
  });
});
