import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ResumeSetup } from "./ResumeSetup";

const api = vi.hoisted(() => ({ importProfileResume: vi.fn(), confirmProfileCandidate: vi.fn(), updateProfileData: vi.fn() }));
vi.mock("@/lib/hooks", () => api);

describe("resume setup", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    api.importProfileResume.mockResolvedValue({
      session_id: 10, filename: "resume.pdf", text_length: 500, base_info: {},
      bullets: [0, 1].map((index) => ({ index, title: `经历 ${index}`, section_type: "experience",
        memory_proposal_id: index + 1, candidate_state: "pending",
        content_json: { normalized: { company: "示例公司", position: "产品经理", start_date: "2023-01", description: "负责用户研究" } },
      })),
    });
  });

  it("shows the facts before confirmation and retries only the unsaved candidate", async () => {
    const user = userEvent.setup();
    const done = vi.fn();
    api.confirmProfileCandidate.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error("稍后重试")).mockResolvedValueOnce({});
    render(<ResumeSetup onDone={done} onBusy={vi.fn()} />);
    await user.upload(screen.getByLabelText("选择简历文件"), new File(["resume"], "resume.pdf", { type: "application/pdf" }));
    await screen.findAllByText("示例公司");
    expect(screen.getAllByText("2023-01")).toHaveLength(2);
    expect(api.confirmProfileCandidate).not.toHaveBeenCalled();
    const confirm = screen.getByRole("button", { name: "确认所选内容，建立档案" });
    await user.click(confirm);
    await screen.findByRole("alert");
    expect(done).not.toHaveBeenCalled();
    await user.click(confirm);
    await waitFor(() => expect(done).toHaveBeenCalledOnce());
    expect(api.confirmProfileCandidate.mock.calls.map(([args]) => args.bullet_index)).toEqual([0, 1, 1]);
  });
});
