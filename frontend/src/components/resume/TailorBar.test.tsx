import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/lib/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/core")>()),
  tool: vi.fn(),
}));
vi.mock("@/lib/tailor", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tailor")>()),
  tailorResume: vi.fn(),
}));

import { tool, type Job } from "@/lib/core";
import { tailorResume, type TailorEdit, type TailorEvent } from "@/lib/tailor";
import { TailorBar } from "./TailorBar";

const save = vi.mocked(tool);
const run = vi.mocked(tailorResume);
const jobs = [{ id: 3, company: "百度", title: "AI产品营销经理", jd: "负责 AI 产品营销" }] as unknown as Job[];
const grounding: TailorEdit[] = [{ old: "获省级一等奖", new: "", reason: "档案里没有", category: "grounding" }];

function done(docId: number): TailorEvent {
  return {
    type: "done", doc_id: docId, body: "# 张三", resume: {}, change_id: 1, pages: 1,
    rounds: [{ round: 1, pages: 1, applied: [{ ...grounding[0], reason: "档案里没有。" }], skipped: [] }],
    notes: { 关键词: "缺 Redis" }, grounding,
  };
}

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("TailorBar", () => {
  it("主简历改写后跳到定制简历，重挂的 TailorBar 还显示结果，点「存进档案」存一条记忆", async () => {
    run.mockImplementation(async (_doc, _job, _signal, onEvent) => { onEvent(done(26)); });
    save.mockResolvedValue({});
    const onDone = vi.fn(async () => undefined);
    render(<TailorBar docId={7} jobId={null} jobs={jobs} disabled={false} onDone={onDone} />);

    fireEvent.click(screen.getByRole("button", { name: "按岗位改写" }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(26));
    expect(run).toHaveBeenCalledWith(7, 3, expect.any(AbortSignal), expect.any(Function));

    // 页面跳到 /resume/26：Editor 按 doc id 重挂，TailorBar 是新的实例
    cleanup();
    render(<TailorBar docId={26} jobId={3} jobs={jobs} disabled={false} onDone={onDone} />);
    expect(screen.getByText(/已存成这个岗位的定制简历/)).toBeInTheDocument();
    expect(screen.getByText(/第 1 轮审稿改了 1 处，出处：档案里没有 预计 1\.0 页/)).toBeInTheDocument();
    expect(screen.getByText(/审稿找不到出处，改掉了「获省级一等奖」/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "是真的，存进档案" }));
    await screen.findByText("已存进档案，再改写一次就能用上");
    expect(save).toHaveBeenCalledWith("save", { type: "memory", data: { kind: "note", title: "改写审稿时确认的事实", body: "获省级一等奖" } });
  });

  it("岗位简历原地改写；存档案失败要告诉人", async () => {
    run.mockImplementation(async (_doc, _job, _signal, onEvent) => { onEvent(done(40)); });
    save.mockRejectedValue(new Error("后端没连上"));
    const onDone = vi.fn(async () => undefined);
    render(<TailorBar docId={40} jobId={3} jobs={jobs} disabled={false} onDone={onDone} />);
    expect(screen.queryByRole("combobox")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "按岗位改写" }));
    await screen.findByText(/已按岗位改好，可在最近改动里撤销/);
    expect(onDone).toHaveBeenCalledWith(40);

    fireEvent.click(screen.getByRole("button", { name: "是真的，存进档案" }));
    await screen.findByText("后端没连上");
    expect(screen.getByRole("button", { name: "是真的，存进档案" })).toBeInTheDocument();
  });
});
