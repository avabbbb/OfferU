import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/lib/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/core")>()),
  tool: vi.fn(),
}));
vi.mock("@/lib/tailor", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tailor")>()),
  tailorResume: vi.fn(),
  captureImpact: vi.fn(),
}));

import { tool, type Job } from "@/lib/core";
import { captureImpact, tailorResume, type TailorAsk, type TailorEvent } from "@/lib/tailor";
import { TailorBar } from "./TailorBar";

const save = vi.mocked(tool);
const run = vi.mocked(tailorResume);
const capture = vi.mocked(captureImpact);
const jobs = [{ id: 3, company: "百度", title: "AI产品营销经理", jd: "负责 AI 产品营销" }] as unknown as Job[];
const asks: TailorAsk[] = [
  { old: "- 负责公众号粉丝运营", why: "只有动作", question: "粉丝运营带来了什么变化？" },
  { old: "- 策划校园活动", why: "只有动作", question: "活动来了多少人？" },
];

function done(docId: number): TailorEvent {
  return {
    type: "done", doc_id: docId, body: "# 张三", resume: {}, change_id: 1, pages: 1,
    rounds: [{ round: 1, pages: 1, applied: [], skipped: [] }], notes: {}, grounding: [], asks,
  };
}

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("TailorBar 追问成果", () => {
  it("先出一版再问；只交答了的句子；草稿一次存进档案；存完可只审稿再改一下", async () => {
    run.mockImplementation(async (_doc, _job, _signal, onEvent) => { onEvent(done(40)); });
    save.mockResolvedValue({});
    capture.mockResolvedValue({
      drafts: [{ memory_id: 5, title: "公众号运营", data: { body: "三个月涨粉大概 2 万" },
        answers: [{ old: asks[0].old, question: asks[0].question, answer: "三个月涨粉大概 2 万", add: "三个月涨粉大概 2 万" }] }],
      dropped: [{ index: 1, old: asks[1].old, question: asks[1].question, quote: "很多人", why: "原话没有具体结果" }],
    });
    const onDone = vi.fn(async () => undefined);
    render(<TailorBar docId={40} jobId={3} jobs={jobs} disabled={false} onDone={onDone} />);

    fireEvent.click(screen.getByRole("button", { name: "按岗位改写" }));
    await screen.findByText("粉丝运营带来了什么变化？");
    expect(screen.getByText("「负责公众号粉丝运营」")).toBeInTheDocument();
    const organize = screen.getByRole("button", { name: "整理一下" });
    expect(organize).toBeDisabled();

    fireEvent.change(screen.getByRole("textbox", { name: "粉丝运营带来了什么变化？" }), { target: { value: " 三个月涨粉大概 2 万 " } });
    fireEvent.click(organize);
    await screen.findByText(/我会这样记进档案/);
    expect(capture).toHaveBeenCalledWith([{ old: asks[0].old, question: asks[0].question, answer: "三个月涨粉大概 2 万" }], 3);
    expect(screen.getByText("+ 三个月涨粉大概 2 万")).toBeInTheDocument();
    expect(screen.getByText(/没记：「很多人」，原话没有具体结果/)).toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "存进档案" }));
    await screen.findByText("已存进档案，可在最近改动里撤销。");
    expect(save).toHaveBeenCalledWith("save", { type: "memory", id: 5, data: { body: "三个月涨粉大概 2 万" } });
    expect(save).toHaveBeenCalledWith("save", { type: "doc", id: 40, data: { pending_asks: null } });

    fireEvent.click(screen.getByRole("button", { name: "用新成果再改一下" }));
    await waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    expect(run).toHaveBeenLastCalledWith(40, 3, expect.any(AbortSignal), expect.any(Function), { reviewOnly: true });
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("粉丝运营带来了什么变化？")).toBeNull();
  });

  it("先不答：卡片收起，清掉简历上挂着的追问，不整理也不写档案", async () => {
    run.mockImplementation(async (_doc, _job, _signal, onEvent) => { onEvent(done(41)); });
    save.mockResolvedValue({});
    render(<TailorBar docId={41} jobId={3} jobs={jobs} disabled={false} onDone={vi.fn(async () => undefined)} />);

    fireEvent.click(screen.getByRole("button", { name: "按岗位改写" }));
    await screen.findByText("活动来了多少人？");
    fireEvent.click(screen.getByRole("button", { name: "先不答" }));
    expect(screen.queryByText("活动来了多少人？")).toBeNull();
    expect(capture).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith("save", { type: "doc", id: 41, data: { pending_asks: null } });
  });

  it("草稿带 flags 只提醒不拦：黄字显示「留意」，照样一次存进档案", async () => {
    run.mockImplementation(async (_doc, _job, _signal, onEvent) => { onEvent(done(42)); });
    save.mockResolvedValue({});
    const flags = ["原话里没有「三成」", "原话说了大概，草稿丢了约数词"];
    capture.mockResolvedValue({
      drafts: [{ memory_id: 5, title: "公众号运营", data: { body: "三个月涨粉三成" },
        answers: [{ old: asks[0].old, question: asks[0].question, answer: "涨了大概不少", add: "三个月涨粉三成", flags }] }],
      dropped: [],
    });
    render(<TailorBar docId={42} jobId={3} jobs={jobs} disabled={false} onDone={vi.fn(async () => undefined)} />);

    fireEvent.click(screen.getByRole("button", { name: "按岗位改写" }));
    await screen.findByText("粉丝运营带来了什么变化？");
    fireEvent.change(screen.getByRole("textbox", { name: "粉丝运营带来了什么变化？" }), { target: { value: "涨了大概不少" } });
    fireEvent.click(screen.getByRole("button", { name: "整理一下" }));
    await screen.findByText(/标了「留意」的请看一眼再存/);
    const note = screen.getByText("（留意：" + flags.join("；") + "）");
    expect(note).toHaveClass("text-amber-600");
    expect(save).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "存进档案" }));
    await screen.findByText("已存进档案，可在最近改动里撤销。");
    expect(save).toHaveBeenCalledWith("save", { type: "memory", id: 5, data: { body: "三个月涨粉三成" } });
  });
});
