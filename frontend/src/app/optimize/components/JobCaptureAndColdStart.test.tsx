import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  captureDraft: vi.fn(),
  capture: vi.fn(),
  reviewProposal: vi.fn(),
  importProfileResume: vi.fn(),
  confirmProfileCandidate: vi.fn(),
  createProfileSection: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  jobsApi: { captureDraft: api.captureDraft, capture: api.capture },
  memoryApi: { reviewProposal: api.reviewProposal },
}));

vi.mock("@/lib/hooks", () => ({
  importProfileResume: api.importProfileResume,
  confirmProfileCandidate: api.confirmProfileCandidate,
  createProfileSection: api.createProfileSection,
}));

import { JobCaptureCard } from "./JobCaptureCard";
import { ProfileColdStart, manualSectionPayload } from "./ProfileColdStart";

const JD = "岗位职责：负责推荐系统后端服务的设计与开发，优化线上服务性能与稳定性。任职要求：熟悉 Python 或 Go，了解分布式系统与缓存。".repeat(2);

beforeEach(() => {
  Object.values(api).forEach((fn) => fn.mockReset());
});

describe("JobCaptureCard", () => {
  it("shows the recognised draft and only creates the job after the user confirms", async () => {
    const onCreated = vi.fn();
    api.captureDraft.mockResolvedValue({
      status: "ready",
      source_kind: "text",
      message: "",
      draft: { title: "后端开发实习生", company: "示例科技", location: "上海", url: "", jd_text: JD },
      missing: [],
    });
    api.capture.mockResolvedValue({ job_id: 9, duplicate: false });
    render(<JobCaptureCard onCreated={onCreated} />);

    await userEvent.type(screen.getByLabelText("岗位描述原文或链接"), "职位：后端开发实习生");
    await userEvent.click(screen.getByRole("button", { name: /识别/ }));

    expect(await screen.findByDisplayValue("后端开发实习生")).toBeTruthy();
    expect(api.capture).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "建岗位并开始定制" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(9));
    expect(api.capture).toHaveBeenCalledWith(expect.objectContaining({ title: "后端开发实习生", company: "示例科技" }));
  });

  it("keeps the link and asks for the original text when the site needs login", async () => {
    api.captureDraft
      .mockResolvedValueOnce({
        status: "needs_text",
        source_kind: "url",
        message: "这个招聘站需要登录，OfferU 不会替你抓取。",
        draft: { title: "", company: "", location: "", url: "https://www.zhipin.com/job_detail/1", jd_text: "" },
        missing: ["title", "company", "jd_text"],
      })
      .mockResolvedValueOnce({
        status: "incomplete",
        source_kind: "text",
        message: "",
        draft: { title: "后端", company: "", location: "", url: "", jd_text: JD },
        missing: ["company"],
      });
    render(<JobCaptureCard onCreated={vi.fn()} />);

    await userEvent.type(screen.getByLabelText("岗位描述原文或链接"), "https://www.zhipin.com/job_detail/1");
    await userEvent.click(screen.getByRole("button", { name: /识别/ }));
    expect(await screen.findByText(/不会替你抓取/)).toBeTruthy();

    await userEvent.type(screen.getByLabelText("岗位描述原文或链接"), "岗位职责：负责后端");
    await userEvent.click(screen.getByRole("button", { name: /识别/ }));

    expect(await screen.findByText(/来源：https:\/\/www.zhipin.com\/job_detail\/1/)).toBeTruthy();
    // 公司没识别出来时不能建岗位。
    expect((screen.getByRole("button", { name: "建岗位并开始定制" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("ProfileColdStart", () => {
  it("maps a hand-written internship into a verified experience section", () => {
    const payload = manualSectionPayload({
      kind: "internship",
      org: "示例科技",
      role: "后端实习生",
      period: "2024.07 - 2024.10",
      description: "把接口 P99 从 300ms 降到 120ms",
    });
    expect(payload.section_type).toBe("experience");
    expect(payload.category_label).toBe("实习经历");
    expect(payload.tier).toBe("verified_fact");
    expect(payload.content_json).toMatchObject({ company: "示例科技", position: "后端实习生", start_date: "2024.07", end_date: "2024.10" });
  });

  it("does not save a hand-written experience until the user attests it is real", async () => {
    api.createProfileSection.mockResolvedValue({ id: 1 });
    const onChanged = vi.fn();
    render(<ProfileColdStart verifiedCount={0} onProfileChanged={onChanged} onDone={vi.fn()} />);

    await userEvent.click(screen.getByRole("tab", { name: /直接写几条经历/ }));
    await userEvent.type(screen.getByLabelText("公司"), "示例科技");
    await userEvent.type(screen.getByLabelText("你做了什么、结果如何"), "负责订单服务重构，接口耗时下降一半");
    const save = screen.getByRole("button", { name: "保存这条" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    await userEvent.click(screen.getByLabelText("这是我真实的经历，可以作为定制依据"));
    await userEvent.click(save);
    await waitFor(() => expect(api.createProfileSection).toHaveBeenCalledTimes(1));
    expect(onChanged).toHaveBeenCalled();
    expect(await screen.findByText(/已保存：示例科技/)).toBeTruthy();
  });

  it("writes an imported candidate only after the user confirms it", async () => {
    api.importProfileResume.mockResolvedValue({
      session_id: 3,
      filename: "old.pdf",
      text_length: 100,
      bullets: [
        { index: 0, session_id: 3, section_type: "experience", title: "示例科技", content_json: { bullet: "后端实习" }, confidence: 0.9, memory_proposal_id: 11 },
      ],
    });
    api.confirmProfileCandidate.mockResolvedValue({});
    render(<ProfileColdStart verifiedCount={0} onProfileChanged={vi.fn()} onDone={vi.fn()} />);

    await userEvent.click(screen.getByRole("tab", { name: /导入旧简历/ }));
    const file = new File(["%PDF"], "old.pdf", { type: "application/pdf" });
    await userEvent.upload(screen.getByLabelText("选择简历文件"), file);

    expect(await screen.findByText("后端实习")).toBeTruthy();
    expect(api.confirmProfileCandidate).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: /确认属实/ }));
    await waitFor(() => expect(api.confirmProfileCandidate).toHaveBeenCalledWith({ session_id: 3, bullet_index: 0 }));
    expect(await screen.findByText("已确认")).toBeTruthy();
  });

  it("cannot leave the cold start before at least one fact is confirmed", () => {
    render(<ProfileColdStart verifiedCount={0} onProfileChanged={vi.fn()} onDone={vi.fn()} />);
    expect((screen.getByRole("button", { name: "确认 1 条后可开始" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
