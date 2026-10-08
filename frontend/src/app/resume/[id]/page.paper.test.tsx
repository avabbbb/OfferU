import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResumeWorkspace } from "@/lib/api";

const api = vi.hoisted(() => ({
  workspace: vi.fn(),
  update: vi.fn(),
  reviewProposalItem: vi.fn(),
  reviewProposalItems: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  resumeApi: {
    workspace: api.workspace,
    update: api.update,
    reviewProposalItem: api.reviewProposalItem,
    reviewProposalItems: api.reviewProposalItems,
    createVersion: vi.fn(),
    exportPdf: vi.fn(),
    restoreVersion: vi.fn(),
    updateDesign: vi.fn(),
  },
}));
vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "7" }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/resume/7",
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("@/lib/showcase/router", () => ({ SHOWCASE: false }));
vi.mock("../components/SectionEditor", () => ({ default: () => <div data-testid="section-editor" /> }));

import ResumeEditorPage from "./page";

const before = {
  section_type: "experience", title: "工作经历", sort_order: 0, visible: true, source_section_ids: [11],
  content_json: [{ company: "示例科技", position: "后端", description: "<ul><li><p>负责对账服务</p></li></ul>" }],
};
const after = { ...before, content_json: [{ ...before.content_json[0], description: "<ul><li><p>负责日均千万笔的对账服务</p></li></ul>" }] };

function workspace(sectionContent = before.content_json): ResumeWorkspace {
  return {
    resume: {
      id: 7, workspace_revision: 3, user_name: "林一", title: "后端工程师", summary: "", contact_json: {},
      template_id: "paper", style_config: { template: "paper" }, language: "zh",
      sections: [{ id: 5, resume_id: 7, section_type: "experience", title: "工作经历", sort_order: 0, visible: true,
        content_json: sectionContent, source_section_ids: [11] }],
    } as unknown as ResumeWorkspace["resume"],
    job: { id: 42, title: "后端工程师", company: "示例公司" },
    workspace: { revision: 3, content_hash: "h", is_tailored: true },
    application_packet: {
      job_id: 42, resume_id: 7, current_version_id: 1, current_version_number: 1, status: "ready",
      application_id: null, application_attempt_id: null, artifacts: {},
    },
    proposals: [{
      proposal_id: "prop-1", status: "ready", job_id: 42, job_title: "后端工程师", company: "示例公司", profile_id: 1,
      research_run_id: "run-1", change_count: 1, fact_gate_status: "passed", fact_gate_warnings_count: 0, review_note: "",
      created_at: "", updated_at: "", source_section_ids: [11], source_snapshot_hash: "s", research_snapshot_hash: "r",
      original_summary: "", proposed_summary: "", original_rows: [before], proposed_rows: [after],
      diff: [{ change_id: "c1", change_type: "modified", title: "工作经历", section_type: "experience", before, after, source_section_ids: [11] }],
      strategy: {}, presentation: {}, fact_gates: {}, trace: {}, item_reviews: {},
    }],
    versions: [],
  } as unknown as ResumeWorkspace;
}

describe("纸画布上的 AI 建议", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    HTMLElement.prototype.scrollTo = vi.fn();
    api.update.mockImplementation(async (_id: number, data: Record<string, unknown>) => ({ id: 7, ...data }));
  });

  it("shows the suggestion inside the section it changes and accepts it from there", async () => {
    api.workspace.mockResolvedValue(workspace());
    const reviewed = workspace();
    reviewed.proposals[0].item_reviews = { c1: { action: "accept" } };
    api.reviewProposalItem.mockResolvedValue(reviewed);
    const user = userEvent.setup();
    render(<ResumeEditorPage />);

    const inline = await screen.findByTestId("inline-proposal-c1");
    expect(within(inline).getByText("日均千万笔的")).toBeInTheDocument();
    expect(screen.getByTestId("resume-canvas-proposals")).toHaveTextContent("AI 建议 1 条");
    await user.click(within(inline).getByRole("button", { name: /^采用/ }));
    await waitFor(() => expect(api.reviewProposalItem).toHaveBeenCalledWith("prop-1", {
      resume_id: 7, change_id: "c1", action: "accept", edited_text: "",
    }));
    await waitFor(() => expect(screen.queryByTestId("inline-proposal-c1")).not.toBeInTheDocument());
  });

  it("keeps the user's own edit and refuses to apply a suggestion built on the old text", async () => {
    api.workspace.mockResolvedValue(workspace([{ ...before.content_json[0], description: "<ul><li><p>我自己改的版本</p></li></ul>" }]));
    const user = userEvent.setup();
    render(<ResumeEditorPage />);

    const inline = await screen.findByTestId("inline-proposal-c1");
    expect(within(inline).getByRole("note")).toHaveTextContent("以你的版本为准");
    expect(within(inline).getByRole("button", { name: /^采用/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /全部采用/ })).toBeDisabled();

    await user.click(within(inline).getByRole("button", { name: /跳过/ }));
    await waitFor(() => expect(api.reviewProposalItem).toHaveBeenCalledWith("prop-1", {
      resume_id: 7, change_id: "c1", action: "reject", edited_text: "",
    }));
  });

  it("hides the comparison on demand without touching the content", async () => {
    api.workspace.mockResolvedValue(workspace());
    const user = userEvent.setup();
    render(<ResumeEditorPage />);
    await screen.findByTestId("inline-proposal-c1");
    await user.click(screen.getByRole("button", { name: "只看当前" }));
    expect(screen.queryByTestId("inline-proposal-c1")).not.toBeInTheDocument();
    expect(screen.getAllByText("负责对账服务").length).toBeGreaterThan(0);
  });
});

