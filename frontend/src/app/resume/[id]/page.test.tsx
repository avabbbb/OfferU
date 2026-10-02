import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ResumeWorkspace } from "@/lib/api";

const { mockWorkspace, mockUpdate, mockUpdateDesign, mockReviewProposalItem, mockCreateVersion, mockExportPdf, mockRestoreVersion } =
  vi.hoisted(() => ({
    mockWorkspace: vi.fn(),
    mockUpdate: vi.fn(),
    mockUpdateDesign: vi.fn(),
    mockReviewProposalItem: vi.fn(),
    mockCreateVersion: vi.fn(),
    mockExportPdf: vi.fn(),
    mockRestoreVersion: vi.fn(),
  }));

vi.mock("@/lib/api", () => ({
  isFixtureDataMode: (mode?: unknown) => ["fixture", "fixture_plugin"].includes(String(mode || "")),
  resumeApi: {
    workspace: mockWorkspace,
    update: mockUpdate,
    updateDesign: mockUpdateDesign,
    reviewProposalItem: mockReviewProposalItem,
    createVersion: mockCreateVersion,
    exportPdf: mockExportPdf,
    restoreVersion: mockRestoreVersion,
  },
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "7" }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/resume/7",
  useSearchParams: () => new URLSearchParams(""),
}));

vi.mock("@/lib/showcase/router", () => ({ SHOWCASE: false }));

vi.mock("../components/SectionEditor", () => ({
  default: () => <div data-testid="section-editor" />,
}));
vi.mock("../components/ResumePreview", () => ({
  default: () => <div data-testid="resume-preview" />,
}));

import ResumeEditorPage from "./page";

function baseWorkspace(): ResumeWorkspace {
  return {
    resume: {
      id: 7,
      workspace_revision: 0,
      user_name: "张三",
      title: "后端工程师简历",
      summary: "五年服务端经验",
      contact_json: {},
      template_id: "modern",
      style_config: {},
      language: "zh",
      sections: [],
    } as ResumeWorkspace["resume"],
    job: { id: 42, title: "后端工程师", company: "字节跳动" },
    workspace: { revision: 1, content_hash: "h", is_tailored: true },
    application_packet: {
      job_id: 42,
      resume_id: 7,
      current_version_id: 1,
      current_version_number: 1,
      status: "ready",
      application_id: null,
      application_attempt_id: null,
      artifacts: {},
      external_submission: {
        scope: "recorded_only",
        receipt_verified: false,
        recorded: false,
        completed: false,
        attempt_id: null,
        job_id: null,
        resume_id: 7,
        status: null,
        resume_version_id: null,
        matches_current_version: false,
        latest_attempt: null,
      },
    },
    proposals: [],
    versions: [],
  };
}

function workspaceWithProposal(): ResumeWorkspace {
  const ws = baseWorkspace();
  ws.proposals = [
    {
      proposal_id: "prop-1",
      status: "ready",
      job_id: 42,
      job_title: "后端工程师",
      company: "字节跳动",
      profile_id: 1,
      research_run_id: "run-1",
      change_count: 1,
      fact_gate_status: "passed",
      fact_gate_warnings_count: 0,
      review_note: "",
      created_at: "2026-09-01T00:00:00Z",
      updated_at: "2026-09-01T00:00:00Z",
      source_section_ids: [],
      source_snapshot_hash: "s",
      research_snapshot_hash: "r",
      original_summary: "",
      proposed_summary: "",
      original_rows: [],
      proposed_rows: [],
      diff: [
        {
          change_id: "c1",
          title: "强化项目经历描述",
          change_type: "rewrite",
          after: { content_json: "主导高并发订单系统重构" },
        },
      ],
      strategy: {},
      presentation: {},
      fact_gates: {},
      trace: {},
      item_reviews: {},
    },
  ];
  return ws;
}

type PacketArtifactState = {
  resume: { exists?: boolean; ready?: boolean; adopted?: boolean; adoption_status?: string; current_version_matches_resume?: boolean };
  research: { exists?: boolean; ready?: boolean; adopted?: boolean; linked_to_resume?: boolean; verification_status?: string; data_mode?: string | null; run_id?: string | null; proposal_run_id?: string | null; status?: string; review_status?: string; target_job_id?: number | null; target_job_matches?: boolean };
  benchmark: { exists?: boolean; ready?: boolean; status?: string; verification_status?: string; data_mode?: string | null; benchmark_status?: string; sample_sufficient?: boolean; artifact_verification?: { ready: boolean; status: string; reasons: string[]; target_snapshot: { exists: boolean; verified: boolean } } | null; run_id?: string | null; schema_version?: string | null; algorithm_version?: string | null; target_snapshot?: { exists: boolean; verified: boolean; job_id?: number | null; source_ref?: string | null; description_hash?: string | null }; valid_sample_count?: number | null; minimum_sample_count?: number | null };
  interview_focus: { exists?: boolean; ready?: boolean; status?: string; interview_id?: number | null; resume_id?: number | null; focus_schema?: string | null; benchmark_run_id?: string | null };
  documents: { exists?: boolean; count?: number; items?: Array<{ id?: number; resume_id?: number; resume_version_id?: number; version_matches_resume?: boolean | null; matches_current_version?: boolean }> };
};

function workspaceWithPacketState(state: PacketArtifactState): ResumeWorkspace {
  const ws = baseWorkspace();
  (ws.application_packet as unknown as { artifact_state: PacketArtifactState }).artifact_state = state;
  return ws;
}

describe("ResumeEditorPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWorkspace.mockResolvedValue(baseWorkspace());
    mockUpdate.mockImplementation(async (_id: number, data: Record<string, unknown>) => ({ id: 7, ...data }));
  });

  it("加载失败时给出错误与返回入口而不是空白页", async () => {
    mockWorkspace.mockRejectedValue(new Error("network down"));
    render(<ResumeEditorPage />);
    expect(await screen.findByText("network down")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "返回" })).toBeInTheDocument();
  });

  it("does not treat legacy packet artifact links as completed research or interview preparation", async () => {
    const ws = baseWorkspace();
    ws.application_packet.artifacts.research = true;
    ws.application_packet.artifacts.interview_focus = true;
    mockWorkspace.mockResolvedValue(ws);

    render(<ResumeEditorPage />);

    const packet = await screen.findByTestId("application-packet-summary");
    expect(packet).toHaveTextContent("岗位研究状态无法验证");
    expect(packet).toHaveTextContent("面试准备状态无法验证");
    expect(packet).not.toHaveTextContent("已关联");
  });

  it("shows packet assets as pending, unavailable, ready, or adopted from their own readiness state", async () => {
    const pendingWorkspace = workspaceWithPacketState({
      resume: { exists: true, ready: false, adopted: false, adoption_status: "not_adopted", current_version_matches_resume: true },
      research: { exists: true, ready: false, adopted: false, linked_to_resume: true, verification_status: "unverified", data_mode: "live", run_id: "research-42", proposal_run_id: "research-42", status: "completed", review_status: "candidate", target_job_id: 42, target_job_matches: true },
      benchmark: { exists: false, ready: false, status: "not_built" },
      interview_focus: { exists: true, ready: false, status: "failed" },
      documents: { exists: true, count: 2, items: [
        { id: 1, resume_id: 7, resume_version_id: 1, version_matches_resume: true, matches_current_version: true },
        { id: 2, resume_id: 7, resume_version_id: 1, version_matches_resume: true, matches_current_version: false },
      ] },
    });
    pendingWorkspace.application_packet.external_submission = {
      recorded: false,
      completed: false,
      scope: "recorded_only",
      receipt_verified: false,
      attempt_id: null,
      job_id: 42,
      resume_id: 7,
      status: null,
      resume_version_id: null,
      matches_current_version: false,
      latest_attempt: null,
    };
    mockWorkspace.mockResolvedValue(pendingWorkspace);

    render(<ResumeEditorPage />);
    const packet = await screen.findByTestId("application-packet-summary");
    expect(packet).toHaveTextContent("岗位研究待审核");
    expect(packet).toHaveTextContent("岗位基准尚未构建");
    expect(packet).toHaveTextContent("面试准备失败");
    expect(packet).toHaveTextContent("简历提案尚未采纳");
    expect(packet).toHaveTextContent("1 / 2 当前版本匹配");
    expect(packet).toHaveTextContent("尚无投递记录");

    const readyWorkspace = workspaceWithPacketState({
      resume: { exists: true, ready: true, adopted: true, adoption_status: "adopted", current_version_matches_resume: true },
      research: { exists: true, ready: true, adopted: true, linked_to_resume: true, verification_status: "verified", data_mode: "live", run_id: "research-42", proposal_run_id: "research-42", status: "completed", review_status: "accepted", target_job_id: 42, target_job_matches: true },
      benchmark: { exists: true, ready: true, status: "completed", verification_status: "verified", run_id: "benchmark-42", data_mode: "live_backend", artifact_verification: { ready: true, status: "verified", reasons: [], target_snapshot: { exists: true, verified: true } }, schema_version: "offeru.role_benchmark_result.v1", algorithm_version: "role_benchmark.v1", target_snapshot: { exists: true, verified: true, job_id: 42, source_ref: "job:42" }, valid_sample_count: 20, minimum_sample_count: 15 },
      interview_focus: { exists: true, ready: true, status: "completed", interview_id: 5, resume_id: 7, focus_schema: "offeru.interview_focus_plan.v1", benchmark_run_id: "benchmark-42" },
      documents: { exists: true, count: 1, items: [{ id: 1, resume_id: 7, resume_version_id: 1, version_matches_resume: true, matches_current_version: true }] },
    });
    readyWorkspace.application_packet.external_submission = {
      recorded: true,
      completed: true,
      scope: "recorded_only",
      receipt_verified: false,
      attempt_id: 9,
      job_id: 42,
      resume_id: 7,
      status: "submitted",
      resume_version_id: 1,
      matches_current_version: false,
      latest_attempt: {
        attempt_id: 9,
        job_id: 42,
        resume_id: 7,
        status: "submitted",
        resume_version_id: 1,
        matches_current_version: false,
      },
    };
    mockWorkspace.mockResolvedValue(readyWorkspace);
    render(<ResumeEditorPage />);
    await waitFor(() => expect(screen.getAllByTestId("application-packet-summary")).toHaveLength(2));
    const readyPacket = screen.getAllByTestId("application-packet-summary").at(-1)!;
    expect(readyPacket).toHaveTextContent("简历版本已采纳");
    expect(readyPacket).toHaveTextContent("岗位研究已审核");
    expect(readyPacket).toHaveTextContent("岗位基准已就绪");
    expect(readyPacket).toHaveTextContent("面试准备已就绪");
    expect(readyPacket).toHaveTextContent("1 / 1 当前版本匹配");
    expect(readyPacket).toHaveTextContent("记录为已投递，使用旧版本");
    expect(readyPacket).not.toHaveTextContent("外部回执已验证");
  });

  it("keeps a manually saved resume usable for JD-only preparation while the benchmark is absent", async () => {
    const ws = workspaceWithPacketState({
      resume: { exists: true, ready: true, adopted: false, adoption_status: "user_saved", current_version_matches_resume: true },
      research: { exists: false, ready: false, adopted: false, linked_to_resume: false, status: "unavailable" },
      benchmark: { exists: false, ready: false, status: "not_built" },
      interview_focus: { exists: false, ready: false, status: "not_built" },
      documents: { exists: false, count: 0, items: [] },
    });
    mockWorkspace.mockResolvedValue(ws);

    render(<ResumeEditorPage />);

    const packet = await screen.findByTestId("application-packet-summary");
    expect(packet).toHaveTextContent("简历版本已保存");
    expect(packet).toHaveTextContent("岗位基准尚未构建");
    expect(screen.getByTestId("resume-save-version")).toBeEnabled();
  });

  it("reports a research association mismatch before fixture or review readiness", async () => {
    const ws = workspaceWithPacketState({
      resume: { exists: true, ready: true, adopted: false, adoption_status: "user_saved", current_version_matches_resume: true },
      research: { exists: true, ready: true, adopted: true, linked_to_resume: false, data_mode: "fixture", run_id: "research-old", proposal_run_id: "research-current", status: "completed", review_status: "accepted" },
      benchmark: { exists: false, ready: false, status: "not_built" },
      interview_focus: { exists: false, ready: false, status: "not_built" },
      documents: { exists: false, count: 0, items: [] },
    });
    mockWorkspace.mockResolvedValue(ws);

    render(<ResumeEditorPage />);

    expect(await screen.findByTestId("application-packet-summary")).toHaveTextContent("岗位研究未关联此简历");
  });

  it("rejects packet artifacts whose source snapshot belongs to another Job", async () => {
    const ws = workspaceWithPacketState({
      resume: { exists: true, ready: true, adopted: false, adoption_status: "user_saved", current_version_matches_resume: true },
      research: { exists: true, ready: true, adopted: true, linked_to_resume: true, verification_status: "unverified", data_mode: "live", run_id: "research-42", proposal_run_id: "research-42", status: "completed", review_status: "accepted", target_job_id: 99, target_job_matches: false },
      benchmark: { exists: true, ready: true, status: "completed", verification_status: "unverified", data_mode: "live_backend", artifact_verification: { ready: false, status: "unverified", reasons: ["target_snapshot_mismatch"], target_snapshot: { exists: true, verified: false } }, run_id: "benchmark-42", schema_version: "v1", algorithm_version: "v1", target_snapshot: { exists: true, verified: false, job_id: 99 }, valid_sample_count: 20, minimum_sample_count: 15 },
      interview_focus: { exists: false, ready: false, status: "not_built" },
      documents: { exists: false, count: 0, items: [] },
    });
    mockWorkspace.mockResolvedValue(ws);

    render(<ResumeEditorPage />);

    const packet = await screen.findByTestId("application-packet-summary");
    expect(packet).toHaveTextContent("岗位研究关联了其他岗位");
    expect(packet).toHaveTextContent("岗位基准当前岗位快照未验证");
  });

  it("does not treat a legacy completed benchmark without backend verification as ready", async () => {
    const ws = workspaceWithPacketState({
      resume: { exists: true, ready: true, adopted: false, adoption_status: "user_saved", current_version_matches_resume: true },
      research: { exists: false, ready: false, adopted: false, linked_to_resume: false, status: "unavailable" },
      benchmark: { exists: true, ready: true, status: "completed", data_mode: "live_backend", run_id: "legacy-1", schema_version: "v1", algorithm_version: "v1", valid_sample_count: 20, minimum_sample_count: 15 },
      interview_focus: { exists: false, ready: false, status: "not_built" },
      documents: { exists: false, count: 0, items: [] },
    });
    mockWorkspace.mockResolvedValue(ws);

    render(<ResumeEditorPage />);

    expect(await screen.findByTestId("application-packet-summary")).toHaveTextContent("岗位基准验证信息缺失");
  });

  it("does not label fixture, replay, or insufficient benchmarks as ready", async () => {
    const fixtureWorkspace = workspaceWithPacketState({
      resume: { exists: true, ready: true, adopted: false, adoption_status: "user_saved", current_version_matches_resume: true },
      research: { exists: false, ready: false, adopted: false, linked_to_resume: false, status: "unavailable" },
      benchmark: { exists: true, ready: true, status: "completed", verification_status: "unverified", data_mode: "fixture", benchmark_status: "READY", sample_sufficient: true, artifact_verification: { ready: false, status: "unverified", reasons: ["fixture_or_unknown_data_mode"], target_snapshot: { exists: true, verified: true } }, run_id: "fixture-1", schema_version: "v1", algorithm_version: "v1", target_snapshot: { exists: true, verified: true, job_id: 42 }, valid_sample_count: 20, minimum_sample_count: 15 },
      interview_focus: { exists: false, ready: false, status: "not_built" },
      documents: { exists: false, count: 0, items: [] },
    });
    mockWorkspace.mockResolvedValue(fixtureWorkspace);
    const fixtureRender = render(<ResumeEditorPage />);
    expect(await screen.findByText("样本岗位基准已生成（仅供本地验收）")).toBeInTheDocument();
    fixtureRender.unmount();

    const replayWorkspace = workspaceWithPacketState({
      resume: { exists: true, ready: true, adopted: false, adoption_status: "user_saved", current_version_matches_resume: true },
      research: { exists: false, ready: false, adopted: false, linked_to_resume: false, status: "unavailable" },
      benchmark: { exists: true, ready: false, status: "completed", verification_status: "unverified", data_mode: "replay", sample_sufficient: true, artifact_verification: { ready: false, status: "unverified", reasons: ["fixture_or_unknown_data_mode"], target_snapshot: { exists: true, verified: true } }, run_id: "replay-1", schema_version: "v1", algorithm_version: "v1", target_snapshot: { exists: true, verified: true, job_id: 42 }, valid_sample_count: 20, minimum_sample_count: 15 },
      interview_focus: { exists: false, ready: false, status: "not_built" },
      documents: { exists: false, count: 0, items: [] },
    });
    mockWorkspace.mockResolvedValue(replayWorkspace);
    const replayRender = render(<ResumeEditorPage />);
    expect(await screen.findByText("岗位基准回放结果（仅供验收）")).toBeInTheDocument();
    replayRender.unmount();

    const thinWorkspace = workspaceWithPacketState({
      resume: { exists: true, ready: true, adopted: false, adoption_status: "user_saved", current_version_matches_resume: true },
      research: { exists: false, ready: false, adopted: false, linked_to_resume: false, status: "unavailable" },
      benchmark: { exists: true, ready: false, status: "completed", verification_status: "unverified", data_mode: "live_backend", artifact_verification: { ready: false, status: "unverified", reasons: ["sample_metadata_mismatch"], target_snapshot: { exists: true, verified: true } }, run_id: "thin-1", schema_version: "v1", algorithm_version: "v1", target_snapshot: { exists: true, verified: true, job_id: 42 }, valid_sample_count: 6, minimum_sample_count: 15 },
      interview_focus: { exists: false, ready: false, status: "not_built" },
      documents: { exists: false, count: 0, items: [] },
    });
    mockWorkspace.mockResolvedValue(thinWorkspace);
    render(<ResumeEditorPage />);
    expect(await screen.findByText("岗位基准样本不足")).toBeInTheDocument();
  });

  it("shows the latest failed or cancelled attempt without erasing a recorded submission", async () => {
    const ws = baseWorkspace();
    ws.application_packet.external_submission = {
      scope: "recorded_only",
      receipt_verified: false,
      recorded: true,
      completed: true,
      attempt_id: 9,
      job_id: 42,
      resume_id: 7,
      status: "submitted",
      resume_version_id: 1,
      matches_current_version: false,
      latest_attempt: {
        attempt_id: 10,
        job_id: 42,
        resume_id: 7,
        status: "failed",
        resume_version_id: null,
        matches_current_version: false,
      },
    };
    mockWorkspace.mockResolvedValue(ws);

    render(<ResumeEditorPage />);

    const packet = await screen.findByTestId("application-packet-summary");
    expect(packet).toHaveTextContent("最近一次投递尝试失败；记录为已投递，使用旧版本");
  });

  it("fails closed for a legacy submission object without recorded-only scope", async () => {
    const ws = baseWorkspace();
    ws.application_packet.external_submission = {
      recorded: true,
      completed: true,
      attempt_id: 9,
      job_id: 42,
      resume_id: 7,
      status: "submitted",
      resume_version_id: 1,
      matches_current_version: true,
    } as unknown as NonNullable<ResumeWorkspace["application_packet"]["external_submission"]>;
    mockWorkspace.mockResolvedValue(ws);

    render(<ResumeEditorPage />);

    const packet = await screen.findByTestId("application-packet-summary");
    expect(packet).toHaveTextContent("投递记录无法验证");
    expect(packet).not.toHaveTextContent("记录为已投递");
  });

  it.each([
    ["failed", "最近一次投递尝试失败"],
    ["cancelled", "最近一次投递尝试已取消"],
  ])("projects a latest-only %s attempt even without a submitted history", async (status, expected) => {
    const ws = baseWorkspace();
    ws.application_packet.external_submission = {
      scope: "recorded_only",
      receipt_verified: false,
      recorded: true,
      completed: false,
      attempt_id: null,
      job_id: null,
      resume_id: null,
      status: null,
      resume_version_id: null,
      matches_current_version: false,
      latest_attempt: {
        attempt_id: 11,
        job_id: 42,
        resume_id: 7,
        status,
        resume_version_id: null,
        matches_current_version: false,
      },
    };
    mockWorkspace.mockResolvedValue(ws);

    render(<ResumeEditorPage />);

    expect(await screen.findByTestId("application-packet-summary")).toHaveTextContent(expected);
  });

  it("自动保存失败时本地草稿不被覆盖，并展示保存失败状态", async () => {
    mockUpdate.mockRejectedValue(new Error("disk full"));
    render(<ResumeEditorPage />);
    const nameInput = await screen.findByTestId("resume-name-input");
    expect(nameInput).toHaveValue("张三");

    const user = userEvent.setup();
    await user.clear(nameInput);
    await user.type(nameInput, "张三·更新版");

    await waitFor(
      () => expect(screen.getByTestId("resume-save-status")).toHaveTextContent("保存失败"),
      { timeout: 4000 },
    );
    // 关键回归点：草稿内容不能被失败响应清掉
    expect(nameInput).toHaveValue("张三·更新版");
    expect(mockUpdate).toHaveBeenCalled();
  });

  it("接受一条 AI 建议时调用对应提案的审核接口", async () => {
    mockWorkspace.mockResolvedValue(workspaceWithProposal());
    const nextWorkspace = workspaceWithProposal();
    nextWorkspace.proposals[0].item_reviews = { c1: { action: "accept" } };
    mockReviewProposalItem.mockResolvedValue(nextWorkspace);

    render(<ResumeEditorPage />);
    expect(await screen.findByText("强化项目经历描述")).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^接受$/ }));

    await waitFor(() =>
      expect(mockReviewProposalItem).toHaveBeenCalledWith("prop-1", {
        resume_id: 7,
        change_id: "c1",
        action: "accept",
        edited_text: "",
      }),
    );
  });

  it("图片上传期间输入的文字仍会保存，并使用上传后的版本号", async () => {
    const ws = baseWorkspace();
    mockWorkspace.mockResolvedValue(ws);
    mockUpdate.mockImplementation(async (_id: number, data: Record<string, unknown>) => ({ ...ws.resume, ...data, workspace_revision: 1 }));
    let resolveUpload!: (value: unknown) => void;
    mockUpdateDesign.mockImplementation(() => new Promise((resolve) => { resolveUpload = resolve; }));
    const user = userEvent.setup();
    render(<ResumeEditorPage />);
    await user.click(await screen.findByTestId("resume-panel-design"));
    await user.upload(screen.getByLabelText("上传照片"), new File(["fixture"], "photo.png", { type: "image/png" }));
    await waitFor(() => expect(mockUpdateDesign).toHaveBeenCalled());
    const name = screen.getByTestId("resume-name-input");
    await user.clear(name);
    await user.type(name, "上传时的新输入");
    resolveUpload({ ...ws.resume, photo_url: "/uploads/photos/new.png", workspace_revision: 2 });
    await waitFor(() => expect(mockUpdate).toHaveBeenLastCalledWith(7, expect.objectContaining({ user_name: "上传时的新输入", expected_revision: 2 })), { timeout: 4000 });
    expect(name).toHaveValue("上传时的新输入");
  });
});
