import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockForJob } = vi.hoisted(() => ({ mockForJob: vi.fn() }));

vi.mock("@/lib/api", () => ({
  dataModeLabel: (mode?: string) => mode || "未知",
  isFixtureDataMode: (mode?: unknown) => ["fixture", "fixture_plugin"].includes(String(mode || "")),
  roleBenchmarkApi: { forJob: mockForJob, build: vi.fn(), refresh: vi.fn() },
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

import { RoleIntelligencePanel } from "./RoleIntelligencePanel";

function liveBenchmark(overrides: Record<string, unknown> = {}) {
  return {
    run_id: "benchmark-42-v1",
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
    valid_sample_count: 30,
    company_count: 12,
    updated_at: "2026-10-02T00:00:00Z",
    target_profile: {},
    documents: [{ id: 1, job_id: 42, document_kind: "target" }],
    signals: [],
    ...overrides,
  };
}

describe("RoleIntelligencePanel benchmark readback", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reports an absent artifact as not built", async () => {
    mockForJob.mockResolvedValue({ found: false, target_job_id: 42 });
    const report = vi.fn();

    render(<RoleIntelligencePanel jobId={42} onBenchmarkStateChange={report} />);

    expect(await screen.findByText("岗位基准尚未构建")).toBeInTheDocument();
    await waitFor(() => expect(report).toHaveBeenLastCalledWith({ benchmark: null, loading: false, error: "" }));
  });

  it("reports the same versioned, job-bound API artifact used by its completed view", async () => {
    const result = liveBenchmark();
    mockForJob.mockResolvedValue(result);
    const report = vi.fn();

    render(<RoleIntelligencePanel jobId={42} onBenchmarkStateChange={report} />);

    expect(await screen.findByText("参考岗位")).toBeInTheDocument();
    await waitFor(() => expect(report).toHaveBeenLastCalledWith({ benchmark: result, loading: false, error: "" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("labels a fixture artifact as local acceptance data while reporting the canonical API result", async () => {
    const result = liveBenchmark({
      data_mode: "fixture",
      artifact_verification: { ready: false, status: "unverified", reasons: ["fixture_or_unknown_data_mode"], target_snapshot: { exists: true, verified: true } },
    });
    mockForJob.mockResolvedValue(result);
    const report = vi.fn();

    render(<RoleIntelligencePanel jobId={42} onBenchmarkStateChange={report} />);

    expect(await screen.findByText(/Fixture benchmark：仅用于本地产品验收/)).toBeInTheDocument();
    await waitFor(() => expect(report).toHaveBeenLastCalledWith({ benchmark: result, loading: false, error: "" }));
  });

  it("hides replay benchmark data with an explicit acceptance-only label", async () => {
    mockForJob.mockResolvedValue(liveBenchmark({
      data_mode: "replay",
      artifact_verification: { ready: false, status: "unverified", reasons: ["fixture_or_unknown_data_mode"], target_snapshot: { exists: true, verified: true } },
    }));

    render(<RoleIntelligencePanel jobId={42} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("岗位基准回放结果仅用于验收");
    expect(screen.queryByText("参考岗位")).not.toBeInTheDocument();
  });

  it("hides and reports an artifact that belongs to another Job", async () => {
    const result = liveBenchmark({
      target_job_id: 99,
      target_job: { id: 99, title: "Other role", company: "Other", url: "" },
      artifact_verification: { ready: false, status: "unverified", reasons: ["target_job_mismatch"], target_snapshot: { exists: true, verified: false } },
    });
    mockForJob.mockResolvedValue(result);
    const report = vi.fn();

    render(<RoleIntelligencePanel jobId={42} onBenchmarkStateChange={report} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("岗位基准验证未通过：产物关联了其他岗位");
    await waitFor(() => expect(report).toHaveBeenLastCalledWith({ benchmark: result, loading: false, error: "" }));
    expect(screen.queryByText("参考岗位")).not.toBeInTheDocument();
  });

  it("fails closed when a legacy result has no backend verification object", async () => {
    mockForJob.mockResolvedValue(liveBenchmark({ artifact_verification: undefined }));

    render(<RoleIntelligencePanel jobId={42} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("岗位基准验证信息缺失");
    expect(screen.queryByText("参考岗位")).not.toBeInTheDocument();
  });

  it("uses backend schema and changed-JD failures instead of recalculating them in the panel", async () => {
    const metadataMismatch = liveBenchmark({
      schema_version: "old-schema",
      artifact_verification: { ready: false, status: "unverified", reasons: ["schema_mismatch"], target_snapshot: { exists: true, verified: true } },
    });
    mockForJob.mockResolvedValue(metadataMismatch);
    const metadataRender = render(<RoleIntelligencePanel jobId={42} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("产物格式版本不匹配");
    metadataRender.unmount();

    mockForJob.mockResolvedValue(liveBenchmark({
      artifact_verification: { ready: false, status: "unverified", reasons: ["target_snapshot_mismatch"], target_snapshot: { exists: true, verified: false } },
    }));
    render(<RoleIntelligencePanel jobId={42} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("当前岗位 JD 快照已变化");
  });
});
