import { describe, expect, it } from "vitest";

import { extractOutputPanels, formatToolStep } from "./agentToolPresentation";
import type { ToolExecutionState } from "./embeddedAgentStream";

describe("agentToolPresentation (Hark live timeline & interactive panels)", () => {
  it("formats human-readable Chinese step labels with argument and result details", () => {
    expect(formatToolStep("search", { query: "Agent Harness" }, "running")).toEqual({
      title: "正在检索档案与记录：Agent Harness",
      detail: undefined,
    });
    expect(formatToolStep("search", { query: "Agent Harness" }, "done", { items: [{ id: 1 }, { id: 2 }] })).toEqual({
      title: "已检索档案与记录：Agent Harness",
      detail: "命中 2 条",
    });
    expect(formatToolStep("save", { type: "job", data: { company: "飞书", title: "AI 产品" } }, "done", { change_id: 12 })).toEqual({
      title: "已保存岗位：AI 产品",
      detail: "改动 #12 · 可撤销",
    });
  });

  it("extracts structured job, event, doc, pending memory, and change panels from tool results", () => {
    const executions: ToolExecutionState[] = [
      {
        id: "t1",
        toolName: "evaluate_jobs",
        status: "done",
        result: {
          content: [{
            type: "text",
            text: JSON.stringify({
              results: [{ job_id: 9, company: "飞书", title: "Agent 产品", score: 88, status: "saved", reasons: ["有 AgentOS 落地经验"] }],
            }),
          }],
        },
      },
      {
        id: "t2",
        toolName: "save",
        status: "done",
        result: {
          record: { id: 15, type: "event", title: "飞书一面", kind: "interview", at: "2026-11-28T15:00", url: "https://vc.feishu.cn/j/123", done: false, job_id: 9 },
          change_id: 21,
        },
      },
      {
        id: "t3",
        toolName: "save",
        status: "done",
        result: {
          record: { id: 16, type: "memory", kind: "project", title: "开源 PR 合入", confirmed: false },
          change_id: 22,
        },
      },
      {
        id: "t4",
        toolName: "tailor_resume",
        status: "done",
        result: { doc_id: 30, title: "飞书定制简历", job_id: 9 },
      },
    ];

    const panels = extractOutputPanels(executions);
    expect(panels.jobs).toEqual([{ id: 9, company: "飞书", title: "Agent 产品", status: "saved", score: 88, reason: "有 AgentOS 落地经验" }]);
    expect(panels.events[0]).toMatchObject({ id: 15, title: "飞书一面", url: "https://vc.feishu.cn/j/123", done: false });
    expect(panels.docs[0]).toEqual({ id: 30, title: "飞书定制简历", kind: "resume", jobId: 9 });
    expect(panels.pendingMemories).toEqual([{ id: 16, title: "开源 PR 合入", kind: "project", confirmed: false }]);
    expect(panels.changes.map((item) => item.changeId)).toEqual([21, 22]);
  });
});
