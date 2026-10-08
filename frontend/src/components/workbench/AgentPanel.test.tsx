import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  start: vi.fn(),
  skills: vi.fn(),
  runs: vi.fn(),
  events: vi.fn(),
  run: vi.fn(),
  abort: vi.fn(),
  steer: vi.fn(),
  resume: vi.fn(),
  confirm: vi.fn(),
  reject: vi.fn(),
  inputRequestsPending: vi.fn(),
  conversations: vi.fn(),
  conversation: vi.fn(),
  deleteConversation: vi.fn(),
  hostedSessions: vi.fn(),
}));
vi.mock("@/lib/api", () => ({
  AUTO_SKILL_ID: "auto",
  agentRuntimeApi: {
    start: api.start,
    skills: api.skills,
    runs: api.runs,
    events: api.events,
    run: api.run,
    abort: api.abort,
    steer: api.steer,
    resume: api.resume,
    confirm: api.confirm,
    reject: api.reject,
    inputRequestsPending: api.inputRequestsPending,
  },
  agentSupportApi: {
    conversations: api.conversations,
    conversation: api.conversation,
    deleteConversation: api.deleteConversation,
  },
  hostedExecutorApi: { sessions: api.hostedSessions },
}));
vi.mock("./AgentConnectionPanel", () => ({ AgentConnectionStatus: () => null }));
vi.mock("@/lib/showcase/router", () => ({ SHOWCASE: false }));
import { AgentPanel } from "./AgentPanel";

const skillFixture = (id: string, name: string) => ({
  id,
  name,
  group: "jobs",
  status: "native",
  description: `${name}说明`,
  featured: true,
  order: 10,
  missing_capabilities: [],
});

const runRecord = (updates: Record<string, unknown> = {}) => ({
  id: "run-1",
  task_id: "task-1",
  conversation_id: "conv-1",
  goal: "看看岗位",
  mode: "skill_assistant",
  skill_id: "evaluate_job",
  skill_version: "v1",
  skill_snapshot: { id: "evaluate_job", name: "岗位评估" },
  status: "completed",
  steps: [],
  llm_runtime: {},
  final_result: {},
  failure_reason: "",
  event_sequence: 1,
  ...updates,
});

const runResponse = (updates: Record<string, unknown> = {}) => ({
  ok: true,
  run: runRecord(),
  assistant_message: "已处理",
  pending_actions: [],
  active_skill: {
    ...skillFixture("evaluate_job", "岗位评估"),
    routing: { via: "auto", reason: "岗位评估最匹配当前任务" },
  },
  guardian: {},
  conversation_id: "conv-1",
  conversation_title: "测试对话",
  ...updates,
});

const renderPanel = () => render(<MemoryRouter><AgentPanel /></MemoryRouter>);

const sendPrompt = async (user: UserEvent, text: string) => {
  const input = screen.getByRole("textbox");
  await waitFor(() => expect(input).toBeEnabled());
  await user.type(input, text);
  await user.click(screen.getByRole("button", { name: "发送" }));
};

beforeEach(() => {
  vi.clearAllMocks();
  HTMLElement.prototype.scrollTo = vi.fn();
  api.skills.mockResolvedValue({
    skills: [
      skillFixture("evaluate_job", "岗位评估"),
      skillFixture("tracker", "投递追踪"),
    ],
  });
  api.conversations.mockResolvedValue({ conversations: [] });
  api.conversation.mockResolvedValue({
    id: "conv-9",
    title: "旧对话",
    created_at: "",
    updated_at: "",
    messages: [],
  });
  api.deleteConversation.mockResolvedValue({ ok: true });
  api.runs.mockResolvedValue({ runs: [] });
  api.events.mockResolvedValue({ run_id: "run-1", events: [], last_sequence: 0 });
  api.run.mockResolvedValue({ run: runRecord() });
  api.inputRequestsPending.mockResolvedValue({ requests: [] });
  api.abort.mockResolvedValue({ ok: true, run: runRecord({ status: "cancelled" }) });
  api.hostedSessions.mockResolvedValue({ items: [] });
});

describe("Embedded Agent configuration recovery", () => {
  it("clears old chat after a committed reset without another backend action", async () => {
    api.start.mockResolvedValue(runResponse());
    const user = userEvent.setup();
    renderPanel();
    await sendPrompt(user, "读取旧岗位");
    await screen.findByText("已处理");
    act(() => window.dispatchEvent(new Event("offeru-career-reset")));
    expect(screen.queryByText("已处理")).not.toBeInTheDocument();
    expect(api.abort).not.toHaveBeenCalled();
    await sendPrompt(user, "初始化新档案");
    await waitFor(() => expect(api.start).toHaveBeenCalledTimes(2));
    expect(api.start.mock.calls[1][0].conversation_id).not.toBe("conv-1");
  });
  it("offers a direct model-settings route and keeps the failed prompt available", async () => {
    api.start.mockRejectedValue(new Error("LLM API Key 未配置，请在设置页面填写"));
    const user = userEvent.setup();
    renderPanel();
    const input = screen.getByRole("textbox");
    await user.type(input, "读取我的岗位");
    await user.click(screen.getByRole("button", { name: "发送" }));
    expect(await screen.findByRole("link", { name: "配置内置 Agent" })).toHaveAttribute("href", "/settings?section=models");
    expect(input).toHaveValue("读取我的岗位");
    expect(api.start).toHaveBeenCalledTimes(1);
    expect(api.start.mock.calls[0][0].skill_id).toBe("auto");
  });
});

describe("durable Run chat and navigation", () => {
  const pendingProposalResponse = () => runResponse({
    run: runRecord({ id: "run-pending", status: "waiting_confirmation" }),
    pending_actions: [{
      id: "proposal-1",
      tool: "prepare_resume_draft",
      summary: "准备岗位化简历草稿",
      risk_level: "confirm",
      requires_confirmation: true,
      args: {},
    }],
  });

  it("keeps chat editable and sendable while a proposal awaits its separate decision", async () => {
    let calls = 0;
    api.start.mockImplementation(async () => (
      calls++ === 0
        ? pendingProposalResponse()
        : runResponse({ run: runRecord({ id: "run-follow-up" }) })
    ));
    const user = userEvent.setup();
    renderPanel();

    await user.type(screen.getByRole("textbox"), "准备岗位草稿");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await screen.findByText("有 1 项待审核请求");

    const input = screen.getByRole("textbox");
    expect(input).toBeEnabled();
    await user.type(input, "先解释一下这项修改");
    await user.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => expect(api.start).toHaveBeenCalledTimes(2));
    expect(api.start.mock.calls[1][0]).toMatchObject({
      message: "先解释一下这项修改",
      conversation_id: "conv-1",
    });
    expect(api.confirm).not.toHaveBeenCalled();
    expect(api.reject).not.toHaveBeenCalled();
    expect(api.abort).not.toHaveBeenCalled();
  });

  it("does not semantically cancel a pending Run when starting another conversation", async () => {
    api.start.mockResolvedValueOnce(pendingProposalResponse());
    const user = userEvent.setup();
    renderPanel();

    await user.type(screen.getByRole("textbox"), "准备岗位草稿");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await screen.findByText("有 1 项待审核请求");
    await user.click(screen.getByRole("button", { name: "测试对话" }));
    await user.click(screen.getByRole("button", { name: "新建" }));

    expect(api.abort).not.toHaveBeenCalled();
    expect(await screen.findByText(/新对话已开始/)).toBeInTheDocument();
  });

  it("does not semantically cancel a pending Run when loading another conversation", async () => {
    api.start.mockResolvedValueOnce(pendingProposalResponse());
    api.conversations.mockResolvedValue({
      conversations: [{
        id: "conv-9",
        title: "旧对话",
        created_at: "",
        updated_at: "",
        message_count: 1,
        last_message: "旧消息",
      }],
    });
    api.conversation.mockResolvedValue({
      id: "conv-9",
      title: "旧对话",
      created_at: "",
      updated_at: "",
      messages: [{ role: "user", content: "旧消息" }],
    });
    api.runs.mockResolvedValue({ runs: [runRecord({ id: "run-history", conversation_id: "conv-9" })] });
    const user = userEvent.setup();
    renderPanel();

    await user.type(screen.getByRole("textbox"), "准备岗位草稿");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await screen.findByText("有 1 项待审核请求");
    await user.click(screen.getByRole("button", { name: "测试对话" }));
    await user.click(await screen.findByRole("button", { name: /旧对话/ }));

    await screen.findByText("旧消息");
    expect(api.abort).not.toHaveBeenCalled();
  });

  it("offers continue or later for a pending Run instead of auto-opening it", async () => {
    api.conversations.mockResolvedValue({
      conversations: [{
        id: "conv-9",
        title: "旧对话",
        created_at: "",
        updated_at: "",
        message_count: 1,
        last_message: "需要补充信息",
      }],
    });
    api.runs.mockResolvedValue({
      runs: [runRecord({ id: "run-9", conversation_id: "conv-9", status: "waiting_input" })],
    });
    const user = userEvent.setup();
    renderPanel();

    expect(await screen.findByRole("button", { name: "继续上次任务" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "稍后" })).toBeEnabled();
    expect(api.conversation).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "稍后" }));
    expect(api.conversation).not.toHaveBeenCalled();
  });

  it("allows a new message while an Ask answer remains pending", async () => {
    let calls = 0;
    api.start.mockImplementation(async () => (
      calls++ === 0
        ? runResponse({ run: runRecord({ id: "run-ask", status: "waiting_input" }) })
        : runResponse({ run: runRecord({ id: "run-follow-up" }) })
    ));
    api.inputRequestsPending.mockResolvedValue({
      requests: [{
        request_id: "ask-1",
        run_id: "run-ask",
        status: "pending",
        question: "如何定位这段经历？",
        reason: "会影响简历结构",
        options: [{ option_id: "lead", label: "突出带头工作" }],
        allow_free_text: true,
      }],
    });
    const user = userEvent.setup();
    renderPanel();

    await user.type(screen.getByRole("textbox"), "准备经历");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await screen.findByRole("region", { name: "助手提问：如何定位这段经历？" });

    const input = screen.getByPlaceholderText(/继续对话或说明如何调整/);
    expect(input).toBeEnabled();
    await user.type(input, "先说明这段经历的证据");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(api.start).toHaveBeenCalledTimes(2));
    expect(api.start.mock.calls[1][0]).toMatchObject({
      message: "先说明这段经历的证据",
      conversation_id: "conv-1",
    });
  });

  it("allows a new message after reopening an interrupted Run", async () => {
    api.conversations.mockResolvedValue({
      conversations: [{
        id: "conv-9",
        title: "中断的对话",
        created_at: "",
        updated_at: "",
        message_count: 1,
        last_message: "读取中断",
      }],
    });
    api.runs.mockResolvedValue({
      runs: [runRecord({ id: "run-interrupted", conversation_id: "conv-9", status: "interrupted" })],
    });
    api.conversation.mockResolvedValue({
      id: "conv-9",
      title: "中断的对话",
      created_at: "",
      updated_at: "",
      messages: [{ role: "user", content: "读取中断" }],
    });
    api.start.mockResolvedValueOnce(runResponse({ run: runRecord({ id: "run-follow-up" }) }));
    const user = userEvent.setup();
    renderPanel();

    await user.click(await screen.findByRole("button", { name: "继续上次任务" }));
    await screen.findByText("读取中断");

    const input = screen.getByRole("textbox");
    expect(input).toBeEnabled();
    await user.type(input, "继续分析另一岗位");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(api.start).toHaveBeenCalledTimes(1));
    expect(api.start.mock.calls[0][0]).toMatchObject({
      message: "继续分析另一岗位",
      conversation_id: "conv-9",
    });
  });

  it("keeps the composer editable during a request while preventing duplicate starts", async () => {
    let resolveFirst: ((value: ReturnType<typeof runResponse>) => void) | undefined;
    api.start.mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }));
    api.start.mockResolvedValueOnce(runResponse({ run: runRecord({ id: "run-next" }) }));
    const user = userEvent.setup();
    renderPanel();

    await user.type(screen.getByRole("textbox"), "第一次请求");
    await user.click(screen.getByRole("button", { name: "发送" }));
    const input = screen.getByRole("textbox");
    expect(input).toBeEnabled();
    await user.type(input, "下一条消息");
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    await act(async () => { resolveFirst?.(runResponse()); });
    await screen.findByText("已处理");
    expect(input).toHaveValue("下一条消息");
    const sendBtn = screen.getByRole("button", { name: "发送" });
    await user.click(sendBtn);
    await waitFor(() => expect(api.start).toHaveBeenCalledTimes(2));
  });

  it("detaches the stream when the panel closes without cancelling its durable Run", async () => {
    let requestSignal: AbortSignal | undefined;
    api.start.mockImplementationOnce((_payload, _onEvent, signal: AbortSignal) => {
      requestSignal = signal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          const error = new Error("stream detached");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      });
    });
    const user = userEvent.setup();
    const view = renderPanel();
    await user.type(screen.getByRole("textbox"), "读取我的岗位");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(api.start).toHaveBeenCalledTimes(1));

    view.unmount();

    expect(requestSignal?.aborted).toBe(true);
    expect(api.abort).not.toHaveBeenCalled();
  });
});

describe("Embedded Agent skill routing", () => {
  it("sends the auto routing sentinel for a plain natural-language request", async () => {
    api.start.mockResolvedValue(runResponse());
    const user = userEvent.setup();
    renderPanel();
    const select = screen.getByRole("combobox", { name: "当前 Agent Skill" });
    expect(select).toHaveValue("auto");
    await sendPrompt(user, "看看我保存的岗位哪个值得投");
    await screen.findByText("已处理");
    expect(api.start).toHaveBeenCalledTimes(1);
    const [payload] = api.start.mock.calls[0];
    expect(payload.skill_id).toBe("auto");
    expect(payload.message).toBe("看看我保存的岗位哪个值得投");
  });

  it("shows the resolved skill for the run while the next turn still sends auto", async () => {
    api.start.mockResolvedValue(runResponse());
    const user = userEvent.setup();
    renderPanel();
    const select = screen.getByRole("combobox", { name: "当前 Agent Skill" });
    await sendPrompt(user, "帮我评估已保存的岗位");
    expect(await screen.findByText("本轮：岗位评估")).toBeInTheDocument();
    expect(select).toHaveValue("auto");
    await sendPrompt(user, "继续说明原因");
    await waitFor(() => expect(api.start).toHaveBeenCalledTimes(2));
    expect(api.start.mock.calls[1][0].skill_id).toBe("auto");
  });

  it("sends the explicitly picked skill and quick-action override without repinning the mode", async () => {
    api.start.mockResolvedValue(runResponse());
    const user = userEvent.setup();
    renderPanel();
    const select = screen.getByRole("combobox", { name: "当前 Agent Skill" });
    await screen.findByRole("option", { name: "投递追踪" });
    await user.selectOptions(select, "tracker");
    expect(select).toHaveValue("tracker");
    await sendPrompt(user, "汇总我的投递");
    await waitFor(() => expect(api.start).toHaveBeenCalledTimes(1));
    expect(api.start.mock.calls[0][0].skill_id).toBe("tracker");
    expect(select).toHaveValue("tracker");
    await user.click(screen.getByRole("button", { name: "确认身份" }));
    await waitFor(() => expect(api.start).toHaveBeenCalledTimes(2));
    expect(api.start.mock.calls[1][0].skill_id).toBe("profile_onboarding");
    expect(api.start.mock.calls[1][0].message).toContain("校招/应届/实习");
    expect(select).toHaveValue("tracker");
  });

  it("resets to automatic routing when a new conversation starts", async () => {
    api.start.mockResolvedValue(runResponse());
    const user = userEvent.setup();
    renderPanel();
    const select = screen.getByRole("combobox", { name: "当前 Agent Skill" });
    await screen.findByRole("option", { name: "投递追踪" });
    await user.selectOptions(select, "tracker");
    await user.click(screen.getByRole("button", { name: "新对话" }));
    await user.click(await screen.findByRole("button", { name: "新建" }));
    expect(select).toHaveValue("auto");
    await sendPrompt(user, "看看我保存的岗位");
    await waitFor(() => expect(api.start).toHaveBeenCalledTimes(1));
    expect(api.start.mock.calls[0][0].skill_id).toBe("auto");
  });

  it("keeps automatic mode and shows the frozen run skill after loading history", async () => {
    api.conversations.mockResolvedValue({
      conversations: [{
        id: "conv-9",
        title: "旧对话",
        created_at: "2026-10-01T10:00:00Z",
        updated_at: "2026-10-01T11:00:00Z",
        message_count: 2,
        last_message: "投递汇总",
      }],
    });
    api.conversation.mockResolvedValue({
      id: "conv-9",
      title: "旧对话",
      created_at: "2026-10-01T10:00:00Z",
      updated_at: "2026-10-01T11:00:00Z",
      messages: [
        { role: "user", content: "查投递" },
        { role: "assistant", content: "投递汇总" },
      ],
    });
    api.runs.mockResolvedValue({
      runs: [runRecord({
        id: "run-9",
        conversation_id: "conv-9",
        skill_id: "tracker",
        skill_snapshot: { id: "tracker", name: "投递追踪" },
        status: "completed",
      })],
    });
    api.start.mockResolvedValue(runResponse());
    const user = userEvent.setup();
    renderPanel();
    const select = screen.getByRole("combobox", { name: "当前 Agent Skill" });
    await user.click(screen.getByRole("button", { name: "新对话" }));
    await user.click(await screen.findByRole("button", { name: /旧对话/ }));
    await screen.findByText("投递汇总");
    expect(select).toHaveValue("auto");
    expect(await screen.findByText("本轮：投递追踪")).toBeInTheDocument();
    await sendPrompt(user, "再看看有没有遗漏");
    await waitFor(() => expect(api.start).toHaveBeenCalledTimes(1));
    const [payload] = api.start.mock.calls[0];
    expect(payload.skill_id).toBe("auto");
    expect(payload.conversation_id).toBe("conv-9");
  });

  it("surfaces a routing failure instead of a blank completion and allows a retry", async () => {
    api.start.mockResolvedValue(runResponse({
      ok: false,
      assistant_message: "",
      errors: ["技能路由失败：内置模型不可用"],
      run: runRecord({ status: "failed", skill_id: "auto", skill_snapshot: {} }),
    }));
    const user = userEvent.setup();
    renderPanel();
    await sendPrompt(user, "帮我看岗位");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("技能路由失败：内置模型不可用");
    expect(screen.getByRole("textbox")).toHaveValue("帮我看岗位");
    api.start.mockResolvedValue(runResponse());
    await user.click(screen.getByRole("button", { name: "发送" }));
    await screen.findByText("已处理");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(api.start).toHaveBeenCalledTimes(2);
    expect(api.start.mock.calls[1][0].skill_id).toBe("auto");
  });
});

describe("Proposal Plan review routing", () => {
  it("routes five projected nodes to one Plan review entry and never renders per-node approval", async () => {
    const runId = `run_${"1".repeat(32)}`;
    const planId = `plan_${"2".repeat(32)}`;
    const groupId = `group_${"3".repeat(32)}`;
    const nodes = Array.from({ length: 5 }, (_, index) => ({
      id: `node_${String(index + 1).padStart(32, "0")}`,
      group_id: groupId,
      operation: "review_resume_proposal_items",
      summary: `简历修改 ${index + 1}`,
      status: "pending",
      display: { before: "旧内容", after: "新内容", evidence: "简历证据", rationale: "岗位相关" },
    }));
    const projectedRun = runRecord({
      id: runId,
      status: "waiting_confirmation",
      proposal_authority: "proposal-plan-v2",
      proposal_plans: [{
        id: planId,
        run_id: runId,
        revision: 1,
        status: "sealed",
        digest: "a".repeat(64),
        title: "岗位化简历",
        groups: [{
          id: groupId,
          title: "经历调整",
          summary: "一次审核五条修改",
          rationale: "保持一组语义改动",
          digest: "b".repeat(64),
          status: "pending",
          nodes,
        }],
        continuations: [],
      }],
      steps: nodes.map((node) => ({
        ...node,
        tool: node.operation,
        risk_level: "confirm",
        requires_confirmation: true,
        args: { private_marker: "raw-plan-parameter", change_ids: [node.id] },
        idempotency_key: `idem-${node.id}`,
        attempts: 0,
        plan_id: planId,
        group_id: groupId,
        projection_only: true,
      })),
    });
    const projectionActions = projectedRun.steps;
    let planReadyRunId = "";
    api.start.mockImplementation(async (_payload: unknown, onEvent?: (name: string, data: unknown) => void) => {
      onEvent?.("proposal.plan_ready", { run_id: runId, payload: { plan_id: planId } });
      planReadyRunId = runId;
      return runResponse({ run: projectedRun, pending_actions: projectionActions });
    });
    api.run.mockResolvedValue({ run: projectedRun });

    const openPlanReview = vi.fn();
    window.addEventListener("offeru-open-plan-review", openPlanReview);
    const user = userEvent.setup();
    renderPanel();
    await sendPrompt(user, "准备岗位化简历");

    const status = await screen.findByTestId("agent-plan-review");
    expect(status).toHaveTextContent("1 个改动组等待你审核");
    expect(api.run).toHaveBeenCalledWith(planReadyRunId);
    expect(screen.getAllByRole("button", { name: "打开计划审核" })).toHaveLength(1);
    await waitFor(() => expect(screen.getByRole("button", { name: "取消本次 Run" })).toBeEnabled());
    expect(screen.queryByText("逐项审核动作")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "确认" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "拒绝" })).not.toBeInTheDocument();
    expect(screen.queryByText(/raw-plan-parameter|change_ids/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "打开计划审核" }));
    expect(openPlanReview).toHaveBeenCalledTimes(1);
    expect(openPlanReview.mock.calls[0][0].detail).toEqual({ run_id: runId, plan_id: planId });
    expect(api.confirm).not.toHaveBeenCalled();
    expect(api.reject).not.toHaveBeenCalled();
    window.removeEventListener("offeru-open-plan-review", openPlanReview);
  });
});


/** docs/02 D-1 / D-2：等待中的 Run 不锁输入，导航不中断 Run。 */
const waitingPlanRun = () => {
  const runId = `run_${"4".repeat(32)}`;
  const planId = `plan_${"5".repeat(32)}`;
  const groupId = `group_${"6".repeat(32)}`;
  const node = {
    id: `node_${"7".repeat(32)}`,
    group_id: groupId,
    operation: "review_resume_proposal_items",
    summary: "简历修改",
    status: "pending",
    display: { before: "旧", after: "新", evidence: "证据", rationale: "理由" },
  };
  return runRecord({
    id: runId,
    status: "waiting_confirmation",
    proposal_authority: "proposal-plan-v2",
    proposal_plans: [{
      id: planId, run_id: runId, revision: 1, status: "sealed", digest: "a".repeat(64), title: "计划",
      groups: [{ id: groupId, title: "组", summary: "一组", rationale: "", digest: "b".repeat(64), status: "pending", nodes: [node] }],
      continuations: [],
    }],
    steps: [{
      ...node, tool: node.operation, risk_level: "confirm", requires_confirmation: true, args: {},
      idempotency_key: "idem", attempts: 0, plan_id: planId, group_id: groupId, projection_only: true,
    }],
  });
};

describe("Agent input never locks", () => {
  it("keeps typing, skills and quick actions usable while a plan waits, and parks the waiting run", async () => {
    const waiting = waitingPlanRun();
    api.start.mockResolvedValueOnce(runResponse({ run: waiting, pending_actions: waiting.steps }));
    api.start.mockResolvedValueOnce(runResponse());
    api.run.mockResolvedValue({ run: waiting });
    const user = userEvent.setup();
    renderPanel();
    await sendPrompt(user, "准备岗位化简历");
    await screen.findByTestId("agent-plan-review");

    expect(screen.getByRole("textbox")).toBeEnabled();
    expect(screen.getByRole("combobox", { name: "当前 Agent Skill" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "校招体检" })).toBeEnabled();

    await sendPrompt(user, "顺便看看今天的新岗位");
    await waitFor(() => expect(api.start).toHaveBeenCalledTimes(2));
    expect(api.start.mock.calls[1][0].message).toBe("顺便看看今天的新岗位");
    expect(api.abort).not.toHaveBeenCalled();
    const parked = await screen.findByTestId("agent-parked-runs");
    expect(parked).toHaveTextContent("等你审核");

    await user.click(screen.getByRole("button", { name: "回去处理" }));
    expect(await screen.findByTestId("agent-plan-review")).toBeInTheDocument();
    expect(api.run).toHaveBeenCalledWith(waiting.id);
  });

  it("steers a live run with a mid-run message instead of blocking it", async () => {
    let finish: (value: unknown) => void = () => {};
    api.start.mockImplementationOnce((_payload: unknown, onEvent?: (name: string, data: unknown) => void) => {
      onEvent?.("run.started", { run_id: "run-1" });
      return new Promise((resolve) => { finish = resolve; });
    });
    api.steer.mockResolvedValue({ ok: true, disposition: "steered" });
    const user = userEvent.setup();
    renderPanel();
    await sendPrompt(user, "找后端岗位");
    await waitFor(() => expect(api.start).toHaveBeenCalledTimes(1));

    await sendPrompt(user, "只要上海的");
    await waitFor(() => expect(api.steer).toHaveBeenCalledWith("run-1", "只要上海的"));
    expect(await screen.findByText("已交给正在进行的任务")).toBeInTheDocument();
    expect(api.start).toHaveBeenCalledTimes(1);
    await act(async () => { finish(runResponse()); });
  });

  it("queues a message the live run cannot take and sends it once the run finishes", async () => {
    let finish: (value: unknown) => void = () => {};
    api.start.mockImplementationOnce((_payload: unknown, onEvent?: (name: string, data: unknown) => void) => {
      onEvent?.("run.started", { run_id: "run-1" });
      return new Promise((resolve) => { finish = resolve; });
    });
    api.start.mockResolvedValueOnce(runResponse());
    api.steer.mockResolvedValue({ ok: true, disposition: "not_running" });
    const user = userEvent.setup();
    renderPanel();
    await sendPrompt(user, "找后端岗位");
    await sendPrompt(user, "再帮我写封求职信");
    expect(await screen.findByTestId("agent-message-queue")).toHaveTextContent("再帮我写封求职信");

    await act(async () => { finish(runResponse()); });
    await waitFor(() => expect(api.start).toHaveBeenCalledTimes(2));
    expect(api.start.mock.calls[1][0].message).toBe("再帮我写封求职信");
    await waitFor(() => expect(screen.queryByTestId("agent-message-queue")).not.toBeInTheDocument());
  });

  it("starting a new conversation never aborts a run that waits on the user", async () => {
    const waiting = waitingPlanRun();
    api.start.mockResolvedValueOnce(runResponse({ run: waiting, pending_actions: waiting.steps }));
    api.run.mockResolvedValue({ run: waiting });
    const user = userEvent.setup();
    renderPanel();
    await sendPrompt(user, "准备岗位化简历");
    await screen.findByTestId("agent-plan-review");
    await user.click(screen.getByTitle("打开历史对话"));
    await user.click(await screen.findByRole("button", { name: "新建" }));
    await screen.findByText(/新对话已开始/);
    expect(api.abort).not.toHaveBeenCalled();
  });
});
