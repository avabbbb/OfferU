import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { JobResearchRunDetail, ResumeOptimizationProposalDetail, RoleBenchmarkDetail } from "@/lib/api";
import type { CareerTask } from "@/lib/hooks";
import { projectJobPreparationProgress } from "@/lib/jobPreparationProgress";
import { JobPreparationProgress } from "./JobPreparationProgress";

describe("JobPreparationProgress", () => {
  it("renders labels projected from real artifact, task, review, and adoption state", () => {
    const task = {
      task_id: "task-42",
      task_type: "role_intelligence",
      source: "automation",
      target_type: "job",
      target_id: "42",
      runtime_provider: "codex",
      status: "completed",
      progress: {},
      error_id: "",
      error: "",
      retryable: false,
      attempt_count: 1,
      max_attempts: 1,
      result_ref: "career-task:assessment-only",
    } as CareerTask;
    const research = {
      run_id: "research-42",
      job_id: 42,
      runtime_id: "backend_search",
      runtime_version: "backend-search-v1",
      data_mode: "live",
      status: "completed",
      review_status: "candidate",
      source_count: 2,
      finding_count: 1,
      result: { schema: "offeru.job_research_result.v1" },
      evidence: [{ id: 1 }],
    } as JobResearchRunDetail;
    const proposal = {
      proposal_id: "proposal-42",
      job_id: 42,
      status: "ready",
    } as ResumeOptimizationProposalDetail;
    const readyResearch = { ...research, review_status: "accepted" } as JobResearchRunDetail;
    const readyBenchmark = {
      run_id: "benchmark-42",
      target_job_id: 42,
      status: "completed",
      benchmark_status: "READY",
      sample_sufficient: true,
      artifact_verification: { ready: true, status: "verified", reasons: [], target_snapshot: { exists: true, verified: true } },
      schema_version: "offeru.role_benchmark_candidate.v1",
      algorithm_version: "role_benchmark.v1",
      taxonomy_version: "role_capability_aliases.v1",
      data_mode: "live_backend",
      documents: [{ job_id: 42, document_kind: "target" }],
    } as unknown as RoleBenchmarkDetail;
    const adoptedProposal = {
      ...proposal,
      status: "accepted",
      accepted_resume_id: 7,
      accepted_resume_version_id: 3,
    } as ResumeOptimizationProposalDetail;
    const incomplete = projectJobPreparationProgress({
      jobId: 42,
      preparationTask: task,
      preApplicationStage: "resume_proposal_ready",
      research,
      researchLoading: false,
      researchError: "",
      benchmark: null,
      benchmarkLoading: false,
      benchmarkError: "",
      proposal,
      proposalLoading: false,
      proposalError: "",
    });
    const ready = projectJobPreparationProgress({
      jobId: 42,
      preparationTask: task,
      preApplicationStage: "decision_ready",
      research: readyResearch,
      researchLoading: false,
      researchError: "",
      benchmark: readyBenchmark,
      benchmarkLoading: false,
      benchmarkError: "",
      proposal: adoptedProposal,
      proposalLoading: false,
      proposalError: "",
    });
    const blocked = projectJobPreparationProgress({
      jobId: 42,
      preparationTask: { ...task, status: "failed" },
      preApplicationStage: null,
      research: { ...research, status: "failed", review_status: "not_available" },
      researchLoading: false,
      researchError: "",
      benchmark: { ...readyBenchmark, status: "blocked" },
      benchmarkLoading: false,
      benchmarkError: "",
      proposal: { ...proposal, job_id: 99 },
      proposalLoading: false,
      proposalError: "",
    });
    render(
      <>
        <JobPreparationProgress stages={incomplete} />
        <JobPreparationProgress stages={ready} />
        <JobPreparationProgress stages={blocked} />
      </>,
    );

    expect(screen.getAllByRole("list", { name: "岗位准备进度" })).toHaveLength(3);
    for (const taskStatus of screen.getAllByText("岗位情报任务已完成")) {
      expect(taskStatus.closest("li")).toHaveAttribute("data-state", "done");
    }
    expect(screen.getByText("岗位研究待审核").closest("li")).toHaveAttribute("data-state", "needs_review");
    expect(screen.getByText("岗位基准尚未构建").closest("li")).toHaveAttribute("data-state", "pending");
    expect(screen.getByText("简历提案待审核").closest("li")).toHaveAttribute("data-state", "prepared");
    expect(screen.getByText("已进入简历准备阶段").closest("li")).toHaveAttribute("data-state", "done");
    expect(screen.getByText("岗位基准已就绪").closest("li")).toHaveAttribute("data-state", "done");
    expect(screen.getByText("岗位研究已审核").closest("li")).toHaveAttribute("data-state", "done");
    expect(screen.getByText("简历版本已采纳").closest("li")).toHaveAttribute("data-state", "adopted");
    expect(screen.getByText("岗位情报任务失败").closest("li")).toHaveAttribute("data-state", "failed");
    expect(screen.getByText("岗位研究失败").closest("li")).toHaveAttribute("data-state", "failed");
    expect(screen.getByText("岗位基准受阻").closest("li")).toHaveAttribute("data-state", "blocked");
    expect(screen.getByText("简历提案与当前岗位不符").closest("li")).toHaveAttribute("data-state", "mismatch");
  });
});
