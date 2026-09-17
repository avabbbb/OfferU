import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ResumeWorkspace } from "@/lib/api";

const { mockWorkspace, mockUpdate, mockReviewProposalItem, mockCreateVersion, mockExportPdf, mockRestoreVersion } =
  vi.hoisted(() => ({
    mockWorkspace: vi.fn(),
    mockUpdate: vi.fn(),
    mockReviewProposalItem: vi.fn(),
    mockCreateVersion: vi.fn(),
    mockExportPdf: vi.fn(),
    mockRestoreVersion: vi.fn(),
  }));

vi.mock("@/lib/api", () => ({
  resumeApi: {
    workspace: mockWorkspace,
    update: mockUpdate,
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
vi.mock("../components/templates/templateSettings", () => ({
  TEMPLATE_OPTIONS: [],
}));

import ResumeEditorPage from "./page";

function baseWorkspace(): ResumeWorkspace {
  return {
    resume: {
      id: 7,
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
});
