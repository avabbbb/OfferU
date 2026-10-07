import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  start: vi.fn(),
  runs: vi.fn(),
  events: vi.fn(),
  run: vi.fn(),
  abort: vi.fn(),
  resume: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  agentRuntimeApi: {
    start: api.start,
    runs: api.runs,
    events: api.events,
    run: api.run,
    abort: api.abort,
    resume: api.resume,
  },
}));

vi.mock("@/components/workbench/AgentAskPanel", () => ({
  AgentAskPanel: ({ runId }: { runId: string }) => <div data-testid="ask-panel">ask:{runId}</div>,
}));

import { OptimizeChatPanel } from "./OptimizeChatPanel";

function runRecord(status = "completed") {
  return {
    id: "run_0123456789abcdef",
    task_id: "tailor_resume:job:7",
    conversation_id: "conv-1",
    goal: "为 canonical Job #7 定制岗位简历。",
    mode: "resume_workflow",
    skill_id: "tailor_resume",
    skill_version: "v1",
    skill_snapshot: {},
    status,
    steps: [],
    proposal_plans: status === "waiting_decision" ? [{
      id: "plan_0123456789abcdef0123456789abcdef",
      run_id: "run_0123456789abcdef",
      revision: 1,
      status: "sealed",
      digest: "a".repeat(64),
      title: "简历修改",
      groups: [],
    }] : [],
    llm_runtime: {},
    final_result: {},
    failure_reason: "",
    event_sequence: 1,
  };
}

function renderPanel() {
  return render(
    <MemoryRouter>
      <OptimizeChatPanel
        jobIds={[7]}
        mode="per_job"
        disabled={false}
        profileId={3}
        referenceResumeId={11}
      />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  api.runs.mockResolvedValue({ runs: [] });
  api.events.mockResolvedValue({ run_id: "run_0123456789abcdef", events: [], last_sequence: 0 });
  api.run.mockResolvedValue({ run: runRecord() });
  api.abort.mockResolvedValue({ ok: true, run: runRecord("cancelled") });
  api.resume.mockResolvedValue({ ok: true, run: runRecord("running"), assistant_message: "", pending_actions: [], active_skill: {} });
});

describe("OptimizeChatPanel Runtime integration", () => {
  it("starts tailor_resume through the canonical Agent Runtime instead of the legacy Optimize session API", async () => {
    api.start.mockResolvedValue({
      ok: true,
      run: runRecord("waiting_input"),
      assistant_message: "我需要确认一个真实取舍。",
      pending_actions: [],
      active_skill: {},
    });
    const user = userEvent.setup();
    renderPanel();

    await screen.findByRole("button", { name: "开始定制" });
    await user.click(screen.getByRole("button", { name: "开始定制" }));

    await waitFor(() => expect(api.start).toHaveBeenCalledTimes(1));
    expect(api.start.mock.calls[0][0]).toMatchObject({
      skill_id: "tailor_resume",
      task_id: "tailor_resume:job:7",
    });
    expect(api.start.mock.calls[0][0].message).toContain("canonical Job #7");
    expect(api.start.mock.calls[0][0].message).toContain("简历 #11");
  });

  it("restores a persisted waiting_input Run and reuses AgentAskPanel", async () => {
    const waiting = runRecord("waiting_input");
    api.runs.mockResolvedValue({ runs: [waiting] });
    api.run.mockResolvedValue({ run: waiting });

    renderPanel();

    expect(await screen.findByTestId("ask-panel")).toHaveTextContent(waiting.id);
    expect(api.runs).toHaveBeenCalledWith({ task_id: "tailor_resume:job:7", limit: 1 });
  });

  it("opens the existing Proposal v2 review for the same Run", async () => {
    const waiting = runRecord("waiting_decision");
    api.runs.mockResolvedValue({ runs: [waiting] });
    api.run.mockResolvedValue({ run: waiting });
    const listener = vi.fn();
    window.addEventListener("offeru-open-plan-review", listener as EventListener);

    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole("button", { name: "审核改动组" }));

    expect(listener).toHaveBeenCalledTimes(1);
    const event = listener.mock.calls[0][0] as CustomEvent;
    expect(event.detail.run_id).toBe(waiting.id);
    expect(event.detail.plan_id).toBe("plan_0123456789abcdef0123456789abcdef");
    window.removeEventListener("offeru-open-plan-review", listener as EventListener);
  });
});
