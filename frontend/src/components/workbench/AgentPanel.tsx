"use client";

// =============================================
// OfferU 主 Agent 面板 — Python Run Host → migrated Agent kernel
// 对话仍是交互记录；任务、Run、事件、提案、确认和审计由后端控制。
// =============================================

import { ToolExecutionList } from "./EmbeddedAgentStreamView";
import { AgentAskPanel } from "./AgentAskPanel";
import { applyRuntimeToolEvent, createInitialAgentStreamState } from "@/lib/embeddedAgentStream";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Textarea } from "@heroui/react";
import {
  Activity,
  AlertTriangle,
  Briefcase,
  ClipboardCheck,
  ChevronDown,
  ChevronUp,
  History,
  Download,
  Loader2,
  Plus,
  RefreshCw,
  Send,
  Sparkles,
  Square,
  Trash2,
  Upload,
  Wrench,
} from "lucide-react";
import {
  agentSupportApi,
  hostedExecutorApi,
  agentRuntimeApi,
  AUTO_SKILL_ID,
  type AgentCareerPath,
  type AgentConversationSummary,
  type AgentJobCard,
  type AgentProposedAction,
  type AgentResponse,
  type AgentRunRecord,
  type AgentSkill,
  type AgentToolCall,
  type HostedExecutorEvent,
  type HostedExecutorSession,
  type HostedExecutorSessionDetail,
  type AgentRunResponse,
} from "@/lib/api";
import { AGENT_COMPOSE_EVENT, drainAgentCompose } from "@/lib/agentCompose";
import { presentAgentToolCall } from "@/lib/agentToolPresentation";
import { bauhausFieldClassNames } from "@/lib/bauhaus";
import { safeClientErrorMessage } from "@/lib/safe-error";
import { AgentConnectionStatus } from "./AgentConnectionPanel";
import { ExternalUrlLink } from "@/components/ExternalUrlLink";
import { SHOWCASE } from "@/lib/showcase/router";
import Link from "next/link";
import { agentRecovery, MODEL_SETTINGS_ROUTE } from "@/lib/agentRecovery";

interface PanelMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  response?: AgentResponse;
  /** D-1：运行中发来、已在下一个工具边界注入当前任务的消息。 */
  steered?: boolean;
}

interface QueuedPanelMessage {
  id: string;
  content: string;
  skillId?: string;
}

interface ParkedRun {
  id: string;
  status: string;
}

const PARKED_RUN_LABELS: Record<string, string> = {
  waiting_confirmation: "等你审核",
  waiting_decision: "等你决定",
  waiting_input: "等你回答",
  interrupted: "已中断，可恢复",
};

interface ResumeCandidate {
  conversationId: string;
  conversationTitle: string;
  runId: string;
  status: string;
}

const QUICK_ACTIONS = [
  {
    label: "确认身份",
    skillId: "profile_onboarding",
    prompt: "先问我几个问题，判断我是校招/应届/实习，还是社招/跳槽",
  },
  {
    label: "校招体检",
    skillId: "market_calibration",
    prompt: "按校招标准检查我的档案、简历、岗位和投递流程缺口",
  },
  {
    label: "每日岗位",
    skillId: "evaluate_job",
    prompt: "今天给我推荐一个最值得投的校招/实习岗位，并说明为什么",
  },
  {
    label: "异常检测",
    skillId: "tracker",
    prompt: "检查我的档案、岗位库、投递管理和面试日程有没有异常",
  },
];

const STAGE_LABELS: Record<string, string> = {
  campus: "校招",
  experienced: "社招",
  unknown: "待确认",
};

const RESUMABLE_RUN_STATUSES = new Set([
  "queued",
  "running",
  "waiting_confirmation",
  "waiting_decision",
  "waiting_input",
  "interrupted",
]);

const HOSTED_STATUS_LABELS: Record<string, string> = {
  created: "已创建",
  starting: "启动中",
  running: "运行中",
  interrupted: "已中断",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

const HOSTED_ACTIVE_STATUSES = new Set(["created", "starting", "running"]);

function executorLabel(executorId: string) {
  return executorId
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function hostedEventLabel(event: HostedExecutorEvent) {
  const payload = event.payload || {};
  if (event.type === "provider.initialized") {
    return `运行时就绪 · ${payload.model || event.provider_event || "Provider"}`;
  }
  if (event.type === "tool.started") {
    const names = Array.isArray(payload.tool_names) ? payload.tool_names.join("、") : "";
    return `调用工具 · ${names || "未命名工具"}`;
  }
  if (event.type === "tool.progress") {
    return `工具运行中 · ${payload.tool_name || ""} ${payload.elapsed_time_seconds || 0}s`;
  }
  if (event.type === "tool.completed") {
    const failed = Array.isArray(payload.results)
      && payload.results.some((item: any) => item?.is_error);
    return failed ? "工具返回错误" : "工具调用完成";
  }
  const labels: Record<string, string> = {
    "session.created": "会话已持久化",
    "session.starting": "正在启动外部执行器",
    "session.resuming": "正在恢复同一外部会话",
    "session.bound": "外部会话已绑定",
    "session.completed": "托管任务已完成",
    "session.cancelled": "托管任务已取消",
    "session.failed": "托管任务失败",
    "recovery.interrupted": "检测到后端中断",
    "approval.denied": "越权工具请求已拒绝",
    "provider.retry": "Provider 正在重试",
    "provider.auth_error": "Provider 认证失败",
    "provider.rate_limit": "Provider 触发限流",
    "executor.result": "结构化结果已返回",
    "assistant.completed": "Agent 完成一轮推理",
  };
  return labels[event.type] || event.type;
}

function shortTime(value?: string | null) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
}

function previewJson(value: unknown) {
  try {
    const text = JSON.stringify(value, null, 2);
    return text.length > 260 ? `${text.slice(0, 260)}...` : text;
  } catch {
    return String(value);
  }
}

function runHasProposalPlan(run?: AgentRunRecord | null) {
  return Boolean(run && (
    run.proposal_authority?.startsWith("proposal-plan")
    || run.proposal_plans?.length
  ));
}

function isPlanProjection(action: AgentProposedAction) {
  return Boolean(action.plan_id || action.group_id || action.projection_only);
}

function visiblePendingActions(actions: AgentProposedAction[], run?: AgentRunRecord | null) {
  if (runHasProposalPlan(run)) return [];
  return actions.filter((action) => !isPlanProjection(action));
}

function pendingActionsFromResponse(response: AgentRunResponse) {
  return visiblePendingActions(response.pending_actions || [], response.run);
}

function runPlanGroups(run: AgentRunRecord) {
  return (run.proposal_plans || []).flatMap((plan) => plan.groups || []);
}

function planReviewSummary(run: AgentRunRecord, loading: boolean) {
  if (loading) return "正在刷新改动组和执行回执…";
  const groups = runPlanGroups(run);
  const pending = groups.filter((group) => group.status === "pending").length;
  const reconciliation = groups.filter((group) => group.status === "needs_reconciliation").length;
  const paused = groups.filter((group) => group.status === "paused").length;
  if (pending) return `${pending} 个改动组等待你审核。审核入口会显示具体修改、证据和理由。`;
  if (reconciliation) return `${reconciliation} 个改动组需要核对执行结果；不会自动重放。`;
  if (paused) return `${paused} 个改动组已暂停，等待核对或修复。`;
  const continuations = (run.proposal_plans || []).flatMap((plan) => plan.continuations || []);
  const continuation = continuations[continuations.length - 1];
  if (continuation?.receiver === "ui_result_projection" && continuation.status === "delivered") {
    return "执行结果已存回原任务；Agent 没有自动恢复推理。";
  }
  if (continuation?.status === "failed") return "原任务回执投影失败，可重试查看。";
  if (continuation?.status === "delivered") return "回执已保存；接收方式未提供。";
  return `计划状态：${run.status}。打开计划审核查看各组状态与回执。`;
}

function primaryPlanId(run: AgentRunRecord) {
  return run.proposal_plans?.find((plan) => plan.status !== "replaced")?.id;
}

function toPanelResponse(response: AgentRunResponse): AgentResponse {
  const guardian = response.guardian || {};
  const proposedActions = pendingActionsFromResponse(response);
  return {
    assistant_message: response.assistant_message,
    mode: response.run.mode,
    active_skill: response.active_skill,
    requires_confirmation: proposedActions.length > 0,
    tool_calls: [],
    proposed_actions: proposedActions,
    user_stage: guardian.user_stage,
    stage_confidence: guardian.stage_confidence,
    stage_signals: guardian.stage_signals,
    alerts: guardian.alerts,
    proactive_suggestions: guardian.proactive_suggestions,
    conversation_id: response.conversation_id,
    conversation_title: response.conversation_title,
  };
}

function pendingActionsFromRun(run: AgentRunRecord): AgentProposedAction[] {
  return visiblePendingActions((run.steps || [])
    .filter((step) => step.status === "waiting_confirmation")
    .map((step) => ({
      id: step.id,
      tool: step.tool,
      summary: step.summary,
      risk_level: step.risk_level,
      requires_confirmation: step.requires_confirmation,
      args: step.args,
      plan_id: step.plan_id,
      group_id: step.group_id,
      group_digest: step.group_digest,
      projection_only: step.projection_only,
    })), run);
}

export function AgentPanel() {
  const [messages, setMessages] = useState<PanelMessage[]>([
    {
      id: "welcome",
      role: "assistant",
      content: SHOWCASE
        ? "这是 OfferU 网页演示 Agent。它只使用演示数据，不连接你电脑里的 Coding Agent；真实本地数据与外置 Agent 请使用 OfferU Desktop。"
        : "在这里查看 OfferU 任务与确认请求。需要时可从「接入与同步」连接本机 Coding Agent，把当前工作交给它。",
    },
  ]);
  const [input, setInput] = useState("");
  const [pendingActions, setPendingActions] = useState<AgentProposedAction[]>([]);
  const [planReviewLoading, setPlanReviewLoading] = useState(false);
  const [planReviewNotice, setPlanReviewNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [toolStream, setToolStream] = useState(createInitialAgentStreamState);
  const [progressText, setProgressText] = useState(SHOWCASE ? "正在准备演示 Agent..." : "正在准备 OfferU Agent...");
  const [streamingText, setStreamingText] = useState("");
  const [error, setError] = useState("");
  const [importedStage, setImportedStage] = useState<string>("unknown");
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [conversationTitle, setConversationTitle] = useState("新对话");
  const [resumeCandidate, setResumeCandidate] = useState<ResumeCandidate | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [activeRun, setActiveRun] = useState<AgentRunRecord | null>(null);
  const [interruptedRunId, setInterruptedRunId] = useState<string | null>(null);
  const [selectedSkillId, setSelectedSkillId] = useState<string>(AUTO_SKILL_ID);
  const [skills, setSkills] = useState<AgentSkill[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [conversations, setConversations] = useState<AgentConversationSummary[]>([]);
  const [hostedOpen, setHostedOpen] = useState(false);
  const [hostedSessions, setHostedSessions] = useState<HostedExecutorSession[]>([]);
  const [selectedHostedSessionId, setSelectedHostedSessionId] = useState<string | null>(null);
  const [hostedDetail, setHostedDetail] = useState<HostedExecutorSessionDetail | null>(null);
  const [hostedLoading, setHostedLoading] = useState(false);
  const [hostedAction, setHostedAction] = useState<"cancel" | "resume" | null>(null);
  const [hostedError, setHostedError] = useState("");
  const [hostedRefreshKey, setHostedRefreshKey] = useState(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const sendRequestPendingRef = useRef(false);
  const suppressResumePromptRef = useRef(false);
  const currentConvRef = useRef<string | null>(null);
  // D-2：导航只分离正在跑的流，不中断它；后台流结束前新消息先排队。
  const [backgroundStreams, setBackgroundStreams] = useState(0);
  const [queuedMessages, setQueuedMessages] = useState<QueuedPanelMessage[]>([]);
  const [parkedRuns, setParkedRuns] = useState<ParkedRun[]>([]);
  const detachedControllersRef = useRef<Set<AbortController>>(new Set());
  const hasPendingActions = pendingActions.length > 0;
  const [reviewPending, setReviewPending] = useState(0);
  const hasPlanReview = runHasProposalPlan(activeRun);
  const planGroups = activeRun ? runPlanGroups(activeRun) : [];
  const planPendingGroupCount = planGroups.filter((group) => group.status === "pending").length;
  const hasPendingPlanReview = hasPlanReview && !["cancelled", "aborted"].includes(activeRun?.status || "") && (
    planPendingGroupCount > 0 || ["waiting_confirmation", "executing"].includes(activeRun?.status || "")
  );
  const runNeedsUser = hasPendingActions || hasPendingPlanReview || Boolean(interruptedRunId)
    || activeRun?.status === "waiting_input";
  const agentBusy = loading || backgroundStreams > 0 || reviewPending > 0;

  const latestResponse = useMemo(() => {
    return [...messages].reverse().find((message) => message.response)?.response;
  }, [messages]);

  const latestMode = latestResponse?.active_skill?.name || latestResponse?.mode || "ready";
  const latestStage = latestResponse?.user_stage || importedStage || "unknown";

  // The last Run's frozen Skill is display-only; it never changes the user's auto/manual choice.
  const resolvedSkillId =
    activeRun?.skill_id && activeRun.skill_id !== AUTO_SKILL_ID ? activeRun.skill_id : "";
  const resolvedSkill = skills.find((skill) => skill.id === resolvedSkillId);
  const resolvedSkillName = resolvedSkillId
    ? (latestResponse?.active_skill?.id === resolvedSkillId && latestResponse.active_skill.name)
      || resolvedSkill?.name
      || activeRun?.skill_snapshot?.name
      || resolvedSkillId
    : "";
  const resolvedRoutingReason = latestResponse?.active_skill?.id === resolvedSkillId
    ? latestResponse.active_skill.routing?.reason
    : undefined;

  const refreshConversations = async () => {
    try {
      const result = await agentSupportApi.conversations();
      setConversations(result.conversations || []);
    } catch {
      setConversations([]);
    }
  };

  useEffect(() => {
    const cleared = () => {
      // Backend reset already ended the old session. Clear its local
      // projection without cancelling or approving any surviving receipt.
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
      sendRequestPendingRef.current = false;
      suppressResumePromptRef.current = false;
      currentConvRef.current = null;
      setMessages([]);
      setInput("");
      setLoading(false);
      setStreamingText("");
      setToolStream(createInitialAgentStreamState());
      setActiveRun(null);
      setActiveRunId(null);
      setInterruptedRunId(null);
      setPendingActions([]);
      setReviewPending(0);
      setPlanReviewNotice("");
      setConversationId(null);
      setConversationTitle("新对话");
      setResumeCandidate(null);
      setConversations([]);
      setSelectedSkillId(AUTO_SKILL_ID);
      setImportedStage("unknown");
      setHostedSessions([]);
      setHostedDetail(null);
      setSelectedHostedSessionId(null);
      setHostedError("");
      setPlanReviewLoading(false);
      setError("");
    };
    window.addEventListener("offeru-career-reset", cleared);
    return () => window.removeEventListener("offeru-career-reset", cleared);
  }, []);

  useEffect(() => () => {
    const controller = abortControllerRef.current;
    abortControllerRef.current = null;
    controller?.abort();
  }, []);

  useEffect(() => {
    refreshConversations();
    agentRuntimeApi
      .skills()
      .then((result) => setSkills(result.skills || []))
      .catch(() => setSkills([]));
    hostedExecutorApi
      .sessions({ limit: 20 })
      .then((result) => setHostedSessions(result.items || []))
      .catch(() => setHostedSessions([]));
  }, []);

  useEffect(() => {
    if (!hostedOpen) return;
    let stopped = false;
    let timer: number | undefined;
    const refresh = async (silent = false) => {
      if (!silent) setHostedLoading(true);
      try {
        const result = await hostedExecutorApi.sessions({ limit: 20 });
        if (stopped) return;
        const items = result.items || [];
        setHostedSessions(items);
        const selectedId = (
          selectedHostedSessionId
          && items.some((item) => item.session_id === selectedHostedSessionId)
        )
          ? selectedHostedSessionId
          : items[0]?.session_id || null;
        setSelectedHostedSessionId(selectedId);
        if (selectedId) {
          const detail = await hostedExecutorApi.session(selectedId);
          if (!stopped) setHostedDetail(detail);
        } else {
          setHostedDetail(null);
        }
        setHostedError("");
        if (!stopped && items.some((item) => HOSTED_ACTIVE_STATUSES.has(item.status))) {
          timer = window.setTimeout(() => void refresh(true), 3000);
        }
      } catch (err: any) {
        if (!stopped) setHostedError(safeClientErrorMessage(err, "读取托管会话失败"));
      } finally {
        if (!stopped && !silent) setHostedLoading(false);
      }
    };
    void refresh();
    return () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [hostedOpen, hostedRefreshKey, selectedHostedSessionId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, loading]);

  /** 把等用户处理的 Run 收进停放条；状态已持久化，随时可回来处理。 */
  const parkActiveRun = () => {
    if (!activeRunId || !runNeedsUser) return;
    const status = interruptedRunId ? "interrupted" : activeRun?.status || "waiting_confirmation";
    const parkedId = activeRunId;
    setParkedRuns((current) => [
      ...current.filter((item) => item.id !== parkedId),
      { id: parkedId, status },
    ]);
    setActiveRunId(null);
    setActiveRun(null);
    setPendingActions([]);
    setInterruptedRunId(null);
    setPlanReviewNotice("");
    setPlanReviewLoading(false);
  };

  const enqueueMessage = (content: string, skillId?: string) => {
    setQueuedMessages((current) => [
      ...current,
      { id: `queued-${Date.now()}-${current.length}`, content, skillId },
    ]);
  };

  const sendMessage = async (text?: string, explicitSkillId?: string) => {
    const content = (text ?? input).trim();
    if (!content) return;
    if (text === undefined) setInput("");
    if (agentBusy || sendRequestPendingRef.current) {
      if (loading && activeRunId && reviewPending === 0 && !explicitSkillId) {
        try {
          const result = await agentRuntimeApi.steer(activeRunId, content);
          if (result.disposition === "steered") {
            setMessages((current) => [
              ...current,
              { id: `user-steer-${Date.now()}`, role: "user", content, steered: true },
            ]);
            return;
          }
        } catch {
          // 引导失败时退回排队，消息不能丢。
        }
      }
      enqueueMessage(content, explicitSkillId);
      return;
    }
    await startTurn(content, explicitSkillId);
  };

  const startTurn = async (content: string, explicitSkillId?: string) => {
    if (!content || loading || sendRequestPendingRef.current) return;
    parkActiveRun();
    const requestSkillId = explicitSkillId || selectedSkillId;
    const currentConversationId = conversationId;
    suppressResumePromptRef.current = true;
    setResumeCandidate(null);
    currentConvRef.current = currentConversationId;
    const controller = new AbortController();
    abortControllerRef.current = controller;
    sendRequestPendingRef.current = true;
    const userMessage: PanelMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      content,
    };
    const nextMessages = [...messages, userMessage];
    const isDetached = () => detachedControllersRef.current.has(controller) || controller.signal.aborted;

    setMessages(nextMessages);
    setLoading(true);
    setProgressText("正在启动内置助手...");
    setStreamingText("");
    setToolStream(createInitialAgentStreamState());
    setPlanReviewNotice("");
    setPlanReviewLoading(false);
    setError("");

    try {
      const runtimeResponse = await agentRuntimeApi.start(
        {
          message: content,
          skill_id: requestSkillId,
          conversation_id: currentConversationId,
        },
        (event, data) => {
          if (isDetached() || currentConvRef.current !== currentConversationId) return;
          setToolStream((current) => applyRuntimeToolEvent(current, event, data || {}));
          const eventRunId = String(data?.run_id || "");
          if (eventRunId) setActiveRunId(eventRunId);
          if (event === "run.started" || event === "run.created") {
            setProgressText("任务已保存，正在启动助手...");
          } else if (event === "executor.started" || event === "runtime.session_started") {
            setProgressText("助手已就绪，正在处理当前任务...");
          } else if (event === "tool.started" || event === "runtime.tool_started") {
            setProgressText("助手正在调用 OfferU 工具...");
          } else if (event === "operation.started") {
            setProgressText(`正在读取：${data?.payload?.operation || "OfferU 数据"}`);
          } else if (event === "proposal.plan_ready") {
            const planRunId = String(data?.run_id || data?.payload?.run_id || eventRunId || "");
            setPlanReviewNotice("改动组已生成，正在读取计划审核和回执状态…");
            if (planRunId) {
              setActiveRunId(planRunId);
              setPlanReviewLoading(true);
              void agentRuntimeApi.run(planRunId)
                .then(({ run }) => {
                  if (isDetached() || currentConvRef.current !== currentConversationId) return;
                  setActiveRun(run);
                  setPendingActions(pendingActionsFromRun(run));
                  setPlanReviewNotice(planReviewSummary(run, false));
                })
                .catch(() => {
                  if (currentConvRef.current === currentConversationId) {
                    setPlanReviewNotice("计划已生成，但暂时无法刷新组状态；可以打开计划审核重试读取。");
                  }
                })
                .finally(() => {
                  if (currentConvRef.current === currentConversationId) setPlanReviewLoading(false);
                });
            }
          } else if (event === "operation.proposed" || event === "approval.requested" || event === "decision.plan_proposed") {
            setProgressText("审核请求已生成，正在等待持久审核状态...");
          } else if (event === "input.required") {
            setProgressText("助手需要你的回答后继续...");
          } else if (event === "runtime.retry_started") {
            setProgressText("模型调用正在安全重试...");
          } else if (event === "runtime.compaction_started") {
            setProgressText("正在压缩本 Run 的模型上下文...");
          } else if (event === "stream.reconnecting") {
            setProgressText("连接中断，正在按事件游标恢复同一个 Run...");
          } else if (event === "assistant.delta" || event === "message.delta") {
            const delta = String(data?.payload?.delta || "");
            if (delta) setStreamingText((current) => current + delta);
          }
        },
        controller.signal,
      );
      if (isDetached() || currentConvRef.current !== currentConversationId) return;
      if (!runtimeResponse.ok) {
        setActiveRunId(runtimeResponse.run.id);
        setActiveRun(runtimeResponse.run);
        if (runtimeResponse.conversation_id) {
          currentConvRef.current = runtimeResponse.conversation_id;
          setConversationId(runtimeResponse.conversation_id);
        }
        throw new Error(runtimeResponse.errors?.join("；") || "内置助手执行失败");
      }
      const response = toPanelResponse(runtimeResponse);
      const assistantMessage: PanelMessage = {
        id: `assistant-${Date.now()}`,
        role: "assistant",
        content: response.assistant_message,
        response,
      };
      if (response.conversation_id) {
        currentConvRef.current = response.conversation_id;
        setConversationId(response.conversation_id);
      }
      if (response.conversation_title) setConversationTitle(response.conversation_title);
      setActiveRunId(runtimeResponse.run.id);
      setActiveRun(runtimeResponse.run);
      setMessages((prev) => [...prev, assistantMessage]);
      setPendingActions(response.proposed_actions || []);
      refreshConversations();
    } catch (err: any) {
      if (abortControllerRef.current !== controller) return;
      if (err instanceof Error && (err.name === "AbortError" || controller.signal.aborted)) return;
      setError(safeClientErrorMessage(err, "OfferU 请求失败"));
      setInput((current) => current || content);
    } finally {
      if (detachedControllersRef.current.delete(controller)) {
        setBackgroundStreams((count) => Math.max(0, count - 1));
      }
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
        sendRequestPendingRef.current = false;
        setStreamingText("");
        setLoading(false);
      }
    }
  };

  // 排队消息在 Agent 真正空闲且当前没有待用户处理的 Run 时自动发送。
  useEffect(() => {
    if (agentBusy || runNeedsUser || queuedMessages.length === 0) return;
    const [next, ...rest] = queuedMessages;
    setQueuedMessages(rest);
    void startTurn(next.content, next.skillId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentBusy, runNeedsUser, queuedMessages]);

  // 其他页面（如简历画布）交来的意图：一律先进待发送队列，由出队逻辑按 D-1 规则发送，
  // 避免一批消息在同一帧里并发开出多个 Run。
  useEffect(() => {
    const take = () => {
      const requests = drainAgentCompose();
      if (!requests.length) return;
      setQueuedMessages((current) => [
        ...current,
        ...requests.map((request, index) => ({
          id: `compose-${Date.now()}-${index}`,
          content: request.message,
          skillId: request.skillId,
        })),
      ]);
    };
    take();
    window.addEventListener(AGENT_COMPOSE_EVENT, take);
    return () => window.removeEventListener(AGENT_COMPOSE_EVENT, take);
  }, []);

  const sendQueuedNow = (id: string) => {
    if (agentBusy) return;
    const item = queuedMessages.find((entry) => entry.id === id);
    if (!item) return;
    setQueuedMessages((current) => current.filter((entry) => entry.id !== id));
    void startTurn(item.content, item.skillId);
  };

  const editQueued = (id: string) => {
    const item = queuedMessages.find((entry) => entry.id === id);
    if (!item) return;
    setQueuedMessages((current) => current.filter((entry) => entry.id !== id));
    setInput((current) => (current ? `${current}\n${item.content}` : item.content));
  };

  const restoreParkedRun = async (id: string) => {
    if (loading) return;
    try {
      const { run } = await agentRuntimeApi.run(id);
      parkActiveRun();
      setParkedRuns((current) => current.filter((item) => item.id !== id));
      if (!["waiting_confirmation", "waiting_decision", "waiting_input", "interrupted"].includes(run.status)) return;
      setActiveRunId(run.id);
      setActiveRun(run);
      setPendingActions(run.status === "waiting_confirmation" ? pendingActionsFromRun(run) : []);
      setInterruptedRunId(run.status === "interrupted" ? run.id : null);
      if (runHasProposalPlan(run)) setPlanReviewNotice(planReviewSummary(run, false));
    } catch (err: any) {
      setError(safeClientErrorMessage(err, "读取待处理任务失败"));
    }
  };

  const detachActiveStream = () => {
    const controller = abortControllerRef.current;
    abortControllerRef.current = null;
    sendRequestPendingRef.current = false;
    if (controller && loading && !controller.signal.aborted) {
      setBackgroundStreams((count) => count + 1);
      detachedControllersRef.current.add(controller);
    }
    setLoading(false);
  };

  const startNewConversation = () => {
    suppressResumePromptRef.current = true;
    setResumeCandidate(null);
    detachActiveStream();
    currentConvRef.current = null;
    setStreamingText("");
    setToolStream(createInitialAgentStreamState());
    setParkedRuns([]);
    setConversationId(null);
    setConversationTitle("新对话");
    setActiveRunId(null);
    setActiveRun(null);
    setInterruptedRunId(null);
    setPlanReviewNotice("");
    setPlanReviewLoading(false);
    setSelectedSkillId(AUTO_SKILL_ID);
    setPendingActions([]);
    setReviewPending(0);
    setHistoryOpen(false);
    setMessages([
      {
        id: `welcome-${Date.now()}`,
        role: "assistant",
        content: "新对话已开始。直接描述你的求职任务，助手会自动选择合适的 Skill；也可以在上方手动指定。",
      },
    ]);
  };

  const loadConversation = async (id: string) => {
    suppressResumePromptRef.current = true;
    setResumeCandidate(null);
    detachActiveStream();
    currentConvRef.current = id;
    setError("");
    setStreamingText("");
    setToolStream(createInitialAgentStreamState());
    setParkedRuns([]);
    try {
      const conversation = await agentSupportApi.conversation(id);
      setConversationId(conversation.id);
      setConversationTitle(conversation.title || "历史对话");
      setActiveRunId(null);
      setActiveRun(null);
      setInterruptedRunId(null);
      setPlanReviewNotice("");
      setPlanReviewLoading(false);
      setPendingActions([]);
      setReviewPending(0);
      setHistoryOpen(false);
      setMessages(
        (conversation.messages || []).map((message, index) => ({
          id: `${conversation.id}-${index}`,
          role: message.role,
          content: message.content,
        }))
      );
      const runResult = await agentRuntimeApi.runs({
        conversation_id: conversation.id,
        limit: 1,
      });
      const latestRun = runResult.runs[0];
      setActiveRun(latestRun || null);
      if (latestRun) {
        try {
          const history = await agentRuntimeApi.events(latestRun.id, 0, AbortSignal.timeout(5000));
          if (currentConvRef.current === id) setToolStream(history.events.reduce(
            (state, event) => applyRuntimeToolEvent(state, event.type, event), createInitialAgentStreamState(),
          ));
        } catch { /* Keep the saved conversation visible if event history is unavailable. */ }
      }
      if (latestRun?.status === "waiting_confirmation") {
        setActiveRunId(latestRun.id);
        setPendingActions(pendingActionsFromRun(latestRun));
      } else if (
        latestRun?.status === "waiting_decision"
        || latestRun?.status === "waiting_input"
      ) {
        setActiveRunId(latestRun.id);
      } else if (latestRun?.status === "interrupted") {
        setActiveRunId(latestRun.id);
        setInterruptedRunId(latestRun.id);
      }
    } catch (err: any) {
      setError(safeClientErrorMessage(err, "加载历史对话失败"));
    }
  };

  useEffect(() => {
    if (conversationId || conversations.length === 0 || suppressResumePromptRef.current) return;
    let cancelled = false;
    const findLatestActiveRun = async () => {
      const latestConversation = conversations[0];
      try {
        const result = await agentRuntimeApi.runs({
          conversation_id: latestConversation.id,
          limit: 1,
        });
        const latestRun = result.runs[0];
        if (!cancelled && !suppressResumePromptRef.current && latestRun
          && RESUMABLE_RUN_STATUSES.has(latestRun.status)) {
          setResumeCandidate({
            conversationId: latestConversation.id,
            conversationTitle: latestConversation.title || "历史对话",
            runId: latestRun.id,
            status: latestRun.status,
          });
        }
      } catch {
        // Keep the new conversation available if persisted Run state cannot be read.
      }
    };
    void findLatestActiveRun();
    return () => {
      cancelled = true;
    };
  }, [conversationId, conversations]);

  useEffect(() => {
    let disposed = false;
    let refreshSequence = 0;
    const handleRunReviewRefresh = (event: Event) => {
      const runId = String((event as CustomEvent<{ run_id?: string }>).detail?.run_id || "");
      if (!runId || runId !== activeRunId) return;
      const targetConversationId = currentConvRef.current;
      if (!targetConversationId) return;
      const sequence = ++refreshSequence;
      void (async () => {
        try {
          const { run } = await agentRuntimeApi.run(runId);
          if (
            disposed
            || sequence !== refreshSequence
            || currentConvRef.current !== targetConversationId
            || run.id !== runId
          ) return;
          setActiveRun(run);
          setPendingActions(pendingActionsFromRun(run));
          setInterruptedRunId(run.status === "interrupted" ? runId : null);

          // Read persisted conversation messages after the Run refresh. Never
          // turn a decision receipt/continuation envelope into an assistant reply.
          const conversation = await agentSupportApi.conversation(targetConversationId);
          if (
            disposed
            || sequence !== refreshSequence
            || currentConvRef.current !== targetConversationId
          ) return;
          const persistedAssistantMessages = (conversation.messages || [])
            .filter((message) => message.role === "assistant" && String(message.content || "").trim())
            .map((message, index) => ({
              id: `${targetConversationId}-refresh-${index}`,
              role: "assistant" as const,
              content: String(message.content),
            }));
          setMessages((current) => {
            const seen = new Set(current.filter((message) => message.role === "assistant").map((message) => message.content));
            const additions = persistedAssistantMessages.filter((message) => {
              if (seen.has(message.content)) return false;
              seen.add(message.content);
              return true;
            });
            return additions.length ? [...current, ...additions] : current;
          });
          setPlanReviewNotice(planReviewSummary(run, false));
        } catch {
          if (!disposed && currentConvRef.current === targetConversationId) {
            setPlanReviewNotice("统一审核入口已触发状态刷新，但当前 Run 暂时无法回读；请核对审核回执。 ");
          }
        }
      })();
    };
    window.addEventListener("offeru-run-review-refresh", handleRunReviewRefresh);
    return () => {
      disposed = true;
      refreshSequence += 1;
      window.removeEventListener("offeru-run-review-refresh", handleRunReviewRefresh);
    };
  }, [activeRunId]);

  const removeConversation = async (id: string) => {
    setError("");
    try {
      await agentSupportApi.deleteConversation(id);
      if (conversationId === id) await startNewConversation();
      await refreshConversations();
    } catch (err: any) {
      setError(safeClientErrorMessage(err, "删除历史对话失败"));
    }
  };

  const abortPendingRun = async () => {
    if (!activeRunId || loading) return;
    setLoading(true);
    setProgressText("正在取消当前 Run...");
    setError("");
    try {
      const result = await agentRuntimeApi.abort(activeRunId);
      setActiveRun(result.run);
      setActiveRunId(null);
      setInterruptedRunId(null);
      setPendingActions([]);
      setReviewPending(0);
      setPlanReviewNotice("当前 Run 已取消；取消本身不会批准待审核组，已执行节点以回执状态为准。");
      setMessages((prev) => [
        ...prev,
        {
          id: `assistant-abort-${Date.now()}`,
          role: "assistant",
          content: runHasProposalPlan(activeRun)
            ? "已取消当前 Run；计划组决定未因此批准，已执行节点状态以回执为准。"
            : "已取消当前 Run，未执行待确认写操作。",
        },
      ]);
    } catch (err: any) {
      setError(safeClientErrorMessage(err, "取消 Run 失败"));
    } finally {
      setLoading(false);
    }
  };
  // Ask 回答落地后刷新同一 Run；只有后端返回的助手消息才进入对话。
  const handleReviewChanged = (result: {
    run?: { id?: string; status?: string } & Record<string, unknown>;
  }) => {
    const runRecord = result.run as AgentRunRecord | undefined;
    if (runRecord) setActiveRun(runRecord);
    const runId = runRecord?.id || activeRunId;
    if (runId) window.dispatchEvent(new CustomEvent("offeru-run-review-refresh", { detail: { run_id: runId } }));
    setPlanReviewNotice("回答已提交；正在回读同一 Run 的持久状态和实际消息。");
  };

  const openPlanReview = () => {
    if (!activeRun) return;
    window.dispatchEvent(new CustomEvent("offeru-open-plan-review", {
      detail: { run_id: activeRun.id, plan_id: primaryPlanId(activeRun) },
    }));
  };

  const resumeInterruptedRun = async () => {
    if (!interruptedRunId || loading) return;
    setLoading(true);
    setProgressText("正在从已保存的 Agent 会话恢复任务...");
    setError("");
    try {
      const runtimeResponse = await agentRuntimeApi.resume(interruptedRunId);
      if (!runtimeResponse.ok) {
        throw new Error(runtimeResponse.errors?.join("；") || "恢复 Run 失败");
      }
      const response = toPanelResponse(runtimeResponse);
      setMessages((prev) => [
        ...prev,
        {
          id: `assistant-resume-${Date.now()}`,
          role: "assistant",
          content: response.assistant_message,
          response,
        },
      ]);
      setPendingActions(response.proposed_actions || []);
      setActiveRunId(runtimeResponse.run.id);
      setActiveRun(runtimeResponse.run);
      setInterruptedRunId(null);
      if (response.conversation_title) {
        setConversationTitle(response.conversation_title);
      }
      refreshConversations();
    } catch (err: any) {
      setError(safeClientErrorMessage(err, "恢复 Run 失败"));
    } finally {
      setLoading(false);
    }
  };

  const selectHostedSession = async (sessionId: string) => {
    setSelectedHostedSessionId(sessionId);
    setHostedLoading(true);
    setHostedError("");
    try {
      setHostedDetail(await hostedExecutorApi.session(sessionId));
    } catch (err: any) {
      setHostedError(safeClientErrorMessage(err, "读取托管会话失败"));
    } finally {
      setHostedLoading(false);
    }
  };

  const runHostedAction = async (action: "cancel" | "resume") => {
    if (!hostedDetail || hostedAction) return;
    if (
      action === "cancel"
      && !window.confirm("确认取消这个托管研究任务？已取消的外部会话不能恢复。")
    ) {
      return;
    }
    setHostedAction(action);
    setHostedError("");
    try {
      if (action === "cancel") {
        await hostedExecutorApi.cancel(hostedDetail.session_id);
      } else {
        await hostedExecutorApi.resume(hostedDetail.session_id);
      }
      const list = await hostedExecutorApi.sessions({ limit: 20 });
      setHostedSessions(list.items || []);
      setHostedDetail(await hostedExecutorApi.session(hostedDetail.session_id));
    } catch (err: any) {
      setHostedError(safeClientErrorMessage(err, `${action === "cancel" ? "取消" : "恢复"}托管任务失败`));
    } finally {
      setHostedAction(null);
    }
  };

  const exportMemory = async () => {
    setError("");
    try {
      const result = await agentSupportApi.exportMemory("markdown");
      await navigator.clipboard.writeText(String(result.content || ""));
      setMessages((prev) => [
        ...prev,
        {
          id: `memory-export-${Date.now()}`,
          role: "assistant",
          content: "已把当前 Agent 记忆导出为 Markdown，并放到剪贴板。",
        },
      ]);
    } catch (err: any) {
      setError(safeClientErrorMessage(err, "导出记忆失败"));
    }
  };

  const importMemoryFile = async (file: File) => {
    setError("");
    try {
      const text = await file.text();
      const result = await agentSupportApi.importMemory(text);
      setImportedStage(result.memory.user_stage);
      setMessages((prev) => [
        ...prev,
        {
          id: `memory-import-${Date.now()}`,
          role: "assistant",
          content: `已导入本地记忆。当前识别为：${STAGE_LABELS[result.memory.user_stage] || result.memory.user_stage}。`,
        },
      ]);
    } catch (err: any) {
      setError(safeClientErrorMessage(err, "导入记忆失败"));
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  return (
    <div className="offeru-agent-panel flex h-full min-h-0 flex-col">
      <div className="border-b border-[var(--border)] p-3">
        <AgentConnectionStatus />
      </div>
      {/* 对话状态行 */}
      <div className="flex items-center justify-between gap-2 border-b border-[var(--border)] px-3 py-2">
        <button
          type="button"
          onClick={() => setHistoryOpen((value) => !value)}
          className="flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-[12px] font-medium text-[var(--foreground-soft)] transition-colors duration-[var(--dur-quick)] hover:bg-[var(--surface-muted)] hover:text-[var(--foreground)]"
          title="打开历史对话"
        >
          <History size={13} />
          <span className="truncate">{conversationTitle || "历史对话"}</span>
        </button>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => setHostedOpen((value) => !value)}
            className={`bauhaus-chip !flex !items-center !gap-1 !py-0.5 !text-[10.5px] ${
              hostedOpen ? "!border-[var(--border-strong)] !bg-[var(--surface-muted)]" : ""
            }`}
            title="查看外部 Coding Agent 托管会话"
          >
            <Activity size={11} />
            托管 {hostedSessions.filter((item) => HOSTED_ACTIVE_STATUSES.has(item.status)).length || hostedSessions.length}
            {hostedOpen ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
          </button>
          <span className="bauhaus-chip !py-0.5 !text-[10.5px]">内置助手</span>
          <Link href={MODEL_SETTINGS_ROUTE} className="text-[11px] text-[var(--foreground-muted)] underline underline-offset-4 hover:text-[var(--foreground)] focus-visible:ring-2">模型设置</Link>
          {activeRun && activeRun.harness_name && (
            <span
              className="bauhaus-chip !py-0.5 !text-[10.5px]"
              title={`harness=${activeRun.harness_name} v${activeRun.harness_version || "?"} · adapter=${activeRun.adapter_name || "?"} v${activeRun.adapter_version || "?"} · lease=${activeRun.lease_id ? activeRun.lease_id.slice(0, 12) + "…" : "无"}`}
            >
              {activeRun.harness_name} {activeRun.lease_id ? "· 已配对" : "· 未配对"}
            </span>
          )}
          <span className="bauhaus-chip !py-0.5 !text-[10.5px]">{STAGE_LABELS[latestStage] || latestStage}</span>
          <span className="bauhaus-chip !py-0.5 !text-[10.5px]">{latestMode}</span>
        </div>
      </div>

      {historyOpen && (
        <div className="border-b border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-[12px] font-semibold text-[var(--foreground)]">历史对话</p>
            <button
              type="button"
              onClick={startNewConversation}
              className="bauhaus-button bauhaus-button-sm"
            >
              <Plus size={12} />
              新建
            </button>
          </div>
          <div className="max-h-40 space-y-1 overflow-y-auto">
            {conversations.length === 0 && (
              <p className="rounded-md px-2 py-1.5 text-[12px] text-[var(--foreground-muted)]">暂无历史对话</p>
            )}
            {conversations.map((conversation) => (
              <div
                key={conversation.id}
                className={`flex items-center gap-1 rounded-md px-2 py-1.5 transition-colors duration-[var(--dur-quick)] ${
                  conversation.id === conversationId
                    ? "bg-[var(--surface)] text-[var(--foreground)]"
                    : "hover:bg-[var(--surface-hover)]"
                }`}
              >
                <button
                  type="button"
                  onClick={() => loadConversation(conversation.id)}
                  className="min-w-0 flex-1 text-left"
                >
                  <p className="truncate text-[12px] font-medium text-[var(--foreground)]">
                    {conversation.title || "历史对话"}
                  </p>
                  <p className="mt-0.5 truncate text-[11px] text-[var(--foreground-muted)]">
                    {conversation.message_count} 条 / {conversation.last_message}
                  </p>
                </button>
                <button
                  type="button"
                  aria-label="删除历史对话"
                  onClick={() => removeConversation(conversation.id)}
                  className="rounded p-1 text-[var(--foreground-muted)] transition-colors duration-[var(--dur-quick)] hover:bg-[var(--status-blush)] hover:text-[var(--primary-red)]"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {resumeCandidate && !conversationId && (
        <div role="status" className="border-b border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5">
          <p className="text-[12px] font-semibold text-[var(--foreground)]">上次任务仍在等待处理</p>
          <p className="mt-0.5 text-[11px] leading-4 text-[var(--foreground-soft)]">
            {resumeCandidate.conversationTitle} · {resumeCandidate.status}。你可以先继续查看，也可以留到稍后。
          </p>
          <div className="mt-2 flex gap-1.5">
            <button
              type="button"
              onClick={() => { void loadConversation(resumeCandidate.conversationId); }}
              className="bauhaus-button bauhaus-button-red !min-h-8 !flex-1 !justify-center !py-1 !text-[11px]"
            >
              继续上次任务
            </button>
            <button
              type="button"
              onClick={() => {
                suppressResumePromptRef.current = true;
                setResumeCandidate(null);
              }}
              className="bauhaus-button bauhaus-button-outline !min-h-8 !flex-1 !justify-center !py-1 !text-[11px]"
            >
              稍后
            </button>
          </div>
        </div>
      )}

      {hostedOpen && (
        <section className="border-b border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5">
          <div className="flex items-center justify-between gap-2">
            <div>
              <p className="text-[12px] font-semibold text-[var(--foreground)]">外部执行器</p>
              <p className="mt-0.5 text-[10.5px] text-[var(--foreground-muted)]">
                一个重任务只绑定一个可审计会话
              </p>
            </div>
            <button
              type="button"
              aria-label="刷新托管会话"
              title="刷新托管会话"
              disabled={hostedLoading}
              onClick={() => setHostedRefreshKey((value) => value + 1)}
              className="rounded p-1 text-[var(--foreground-muted)] hover:bg-[var(--surface)] hover:text-[var(--foreground)] disabled:opacity-50"
            >
              <RefreshCw size={12} className={hostedLoading ? "animate-spin" : ""} />
            </button>
          </div>

          {hostedSessions.length === 0 && !hostedLoading ? (
            <div className="mt-2 rounded-md border border-dashed border-[var(--border-strong)] bg-[var(--surface)] px-2.5 py-2 text-[11.5px] leading-5 text-[var(--foreground-soft)]">
              还没有托管任务。确认深度任务后，执行器会话、授权范围和事件会显示在这里。
            </div>
          ) : (
            <>
              <div className="custom-scrollbar mt-2 flex gap-1.5 overflow-x-auto pb-1">
                {hostedSessions.map((session) => (
                  <button
                    key={session.session_id}
                    type="button"
                    onClick={() => void selectHostedSession(session.session_id)}
                    className={`min-w-[132px] rounded-md border px-2 py-1.5 text-left transition-colors duration-[var(--dur-quick)] ${
                      session.session_id === selectedHostedSessionId
                        ? "border-[var(--border-strong)] bg-[var(--surface)]"
                        : "border-[var(--border)] bg-transparent hover:bg-[var(--surface)]"
                    }`}
                  >
                    <span className="block truncate text-[11.5px] font-semibold text-[var(--foreground)]">
                      {executorLabel(session.executor_id)} · {HOSTED_STATUS_LABELS[session.status] || session.status}
                    </span>
                    <span className="mt-0.5 block truncate text-[10px] text-[var(--foreground-muted)]">
                      {session.task_type} / {shortTime(session.updated_at)}
                    </span>
                  </button>
                ))}
              </div>

              {hostedDetail && (
                <div className="mt-2 rounded-md border border-[var(--border)] bg-[var(--surface)] p-2.5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1">
                        <span
                          className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                            hostedDetail.status === "completed"
                              ? "bg-[var(--status-sage)] text-[var(--primary-green)]"
                              : ["failed", "cancelled"].includes(hostedDetail.status)
                                ? "bg-[var(--status-blush)] text-[var(--primary-red)]"
                                : "bg-[var(--surface-muted)] text-[var(--foreground)]"
                          }`}
                        >
                          {HOSTED_STATUS_LABELS[hostedDetail.status] || hostedDetail.status}
                        </span>
                        <span className="bauhaus-chip !py-0.5 !text-[10px]">{hostedDetail.executor_id}</span>
                        <span className="bauhaus-chip !py-0.5 !text-[10px]">
                          {hostedDetail.capability_grant?.network || "network disabled"}
                        </span>
                      </div>
                      <p className="mt-1 truncate font-mono text-[10px] text-[var(--foreground-muted)]" title={hostedDetail.external_session_id}>
                        {hostedDetail.external_session_id
                          ? `外部会话 ${hostedDetail.external_session_id}`
                          : "尚未绑定外部会话 ID"}
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      {hostedDetail.task_type === "job_research"
                        && ["failed", "interrupted"].includes(hostedDetail.status) && (
                          <button
                            type="button"
                            disabled={Boolean(hostedAction)}
                            onClick={() => void runHostedAction("resume")}
                            className="bauhaus-button bauhaus-button-sm"
                          >
                            {hostedAction === "resume"
                              ? <Loader2 size={11} className="animate-spin" />
                              : <RefreshCw size={11} />}
                            恢复
                          </button>
                        )}
                      {hostedDetail.task_type === "job_research"
                        && ["created", "starting", "running", "interrupted"].includes(hostedDetail.status) && (
                          <button
                            type="button"
                            disabled={Boolean(hostedAction)}
                            onClick={() => void runHostedAction("cancel")}
                            className="bauhaus-button bauhaus-button-sm"
                          >
                            {hostedAction === "cancel"
                              ? <Loader2 size={11} className="animate-spin" />
                              : <Square size={10} />}
                            取消
                          </button>
                        )}
                    </div>
                  </div>

                  {hostedDetail.error && (
                    <p className="mt-2 rounded bg-[var(--status-blush)] px-2 py-1.5 text-[10.5px] leading-4 text-[var(--primary-red)]">
                      {hostedDetail.error}
                    </p>
                  )}

                  <div className="custom-scrollbar mt-2 max-h-40 space-y-1 overflow-y-auto border-t border-[var(--border)] pt-2">
                    {hostedDetail.events.length === 0 && (
                      <p className="text-[10.5px] text-[var(--foreground-muted)]">等待第一个 Provider 事件…</p>
                    )}
                    {hostedDetail.events.slice(-12).map((event) => (
                      <div key={event.event_id} className="flex items-start gap-2 text-[10.5px] leading-4">
                        <span
                          className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
                            event.type.includes("failed")
                              || event.type.includes("denied")
                              || event.type.includes("error")
                              ? "bg-[var(--primary-red)]"
                              : event.type.includes("completed")
                                ? "bg-[var(--primary-green)]"
                                : "bg-[var(--foreground-muted)]"
                          }`}
                        />
                        <span className="min-w-0 flex-1 text-[var(--foreground-soft)]">
                          {hostedEventLabel(event)}
                        </span>
                        <span className="shrink-0 font-mono text-[9.5px] text-[var(--foreground-muted)]">
                          #{event.sequence}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          {hostedError && (
            <p className="mt-2 rounded bg-[var(--status-blush)] px-2 py-1.5 text-[10.5px] text-[var(--primary-red)]">
              {hostedError}
            </p>
          )}
        </section>
      )}

      {/* 快捷技能 */}
      <div className="flex flex-wrap gap-1.5 border-b border-[var(--border)] px-3 py-2">
        <select
          aria-label="当前 Agent Skill"
          title="默认由助手按任务自动选择 Skill"
          value={selectedSkillId}
          onChange={(event) => setSelectedSkillId(event.target.value)}
          className="min-w-0 flex-1 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-[11.5px] text-[var(--foreground)] outline-none disabled:opacity-50"
        >
          <option value={AUTO_SKILL_ID}>自动选择技能</option>
          {skills.map((skill) => (
            <option key={skill.id} value={skill.id}>
              {skill.name}{skill.status === "partial" ? "（部分能力）" : ""}
            </option>
          ))}
          {selectedSkillId !== AUTO_SKILL_ID
            && !skills.some((skill) => skill.id === selectedSkillId) && (
            <option value={selectedSkillId}>{selectedSkillId}</option>
          )}
        </select>
        {selectedSkillId === AUTO_SKILL_ID && resolvedSkillName && (
          <span
            className="bauhaus-chip !py-0.5 !text-[10.5px]"
            title={resolvedRoutingReason || `本 Run 已解析为 ${resolvedSkillId}；选择仍保持自动`}
          >
            本轮：{resolvedSkillName}
          </span>
        )}
        <div className="basis-full" />
        {QUICK_ACTIONS.map((action) => (
          <button
            key={action.label}
            type="button"
            onClick={() => sendMessage(action.prompt, action.skillId)}
            className="bauhaus-chip cursor-pointer transition-colors duration-[var(--dur-quick)] hover:border-[var(--border-strong)] hover:bg-[var(--surface-hover)] hover:text-[var(--foreground)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {action.label}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-0.5">
          <input
            ref={fileInputRef}
            type="file"
            accept=".md,.markdown,.json,.txt"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) importMemoryFile(file);
            }}
          />
          <button
            type="button"
            aria-label="导入本地记忆"
            title="导入外部 Harness / 本地 Markdown 或 JSON 记忆"
            onClick={() => fileInputRef.current?.click()}
            className="rounded-md p-1.5 text-[var(--foreground-muted)] transition-colors duration-[var(--dur-quick)] hover:bg-[var(--surface-muted)] hover:text-[var(--foreground)]"
          >
            <Upload size={14} />
          </button>
          <button
            type="button"
            aria-label="导出助手记忆"
            title="导出记忆为 Markdown"
            onClick={exportMemory}
            className="rounded-md p-1.5 text-[var(--foreground-muted)] transition-colors duration-[var(--dur-quick)] hover:bg-[var(--surface-muted)] hover:text-[var(--foreground)]"
          >
            <Download size={14} />
          </button>
        </div>
      </div>

      {/* 消息流 */}
      <div ref={scrollRef} className="custom-scrollbar min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <div className="space-y-3">
          {messages.map((message) => (
            <PanelMessageBubble key={message.id} message={message} onSuggestion={sendMessage} />
          ))}
          {streamingText && (
            <div className="flex justify-start">
              <div className="max-w-[94%] whitespace-pre-wrap rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-left text-[13px] leading-6 text-[var(--foreground)]">
                {streamingText}
              </div>
            </div>
          )}
          <ToolExecutionList executions={toolStream.toolExecutions} />
          {loading && (
            <div className="inline-flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-[12.5px] text-[var(--foreground-soft)]">
              <Loader2 size={13} className="animate-spin" />
              {progressText}
            </div>
          )}
        </div>
      </div>

      {interruptedRunId && (
        <div className="border-t border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5">
          <p className="text-[12px] font-semibold text-[var(--foreground)]">检测到中断的 Agent Run</p>
          <p className="mt-1 text-[11.5px] leading-5 text-[var(--foreground-soft)]">
            OfferU 不会自动重放工具。你可以从已保存的 Agent 会话恢复，或取消本次任务。
          </p>
          <div className="mt-2 flex gap-1.5">
            <Button
              onPress={resumeInterruptedRun}
              isDisabled={loading}
              className="bauhaus-button bauhaus-button-red !min-h-8 !flex-1 !justify-center !py-1 !text-[12px]"
            >
              恢复 Run
            </Button>
            <Button
              onPress={abortPendingRun}
              isDisabled={loading}
              className="bauhaus-button bauhaus-button-outline !min-h-8 !flex-1 !justify-center !py-1 !text-[12px]"
            >
              取消
            </Button>
          </div>
        </div>
      )}

      {hasPlanReview && activeRun && (
        <div data-testid="agent-plan-review" className="space-y-2 border-t border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5">
          <div className="flex items-start gap-2">
            {planReviewLoading ? <Loader2 size={13} className="mt-0.5 animate-spin text-[var(--primary-blue)]" /> : <ClipboardCheck size={13} className="mt-0.5 text-[var(--primary-blue)]" />}
            <div className="min-w-0 flex-1">
              <p className="text-[12px] font-semibold text-[var(--foreground)]">计划组审核状态</p>
              <p role="status" className="mt-0.5 text-[11px] leading-4 text-[var(--foreground-soft)]">
                {planReviewNotice || planReviewSummary(activeRun, planReviewLoading)}
              </p>
              {planPendingGroupCount > 0 && (
                <p className="mt-0.5 text-[10px] text-[var(--foreground-muted)]">{planPendingGroupCount} 个组等待一次组级决定。</p>
              )}
            </div>
          </div>
          <div className="flex gap-1.5">
            <button
              type="button"
              aria-label="打开计划审核"
              onClick={openPlanReview}
              className="bauhaus-button bauhaus-button-red !min-h-8 !flex-1 !justify-center !py-1 !text-[11px]"
            >
              打开计划审核
            </button>
            {hasPendingPlanReview && activeRunId && (
              <Button
                onPress={abortPendingRun}
                isDisabled={loading}
                className="bauhaus-button bauhaus-button-outline !min-h-8 !flex-1 !justify-center !py-1 !text-[11px]"
              >
                取消本次 Run
              </Button>
            )}
          </div>
        </div>
      )}

      {hasPendingActions && (
        <div className="border-t border-[var(--border)] bg-[var(--status-blush)] px-3 py-2.5">
          <p className="text-[12px] font-semibold text-[var(--foreground)]">有 {pendingActions.length} 项待审核请求</p>
          <p className="mt-1 text-[11px] leading-4 text-[var(--foreground-soft)]">请在工作台统一审核入口查看并决定。这个 Run 面板只显示状态，不直接批准或拒绝动作。</p>
          <div className="mt-2 flex gap-1.5">
            <Button
              onPress={() => window.dispatchEvent(new Event("offeru-open-pending-proposals"))}
              className="bauhaus-button bauhaus-button-red !min-h-8 !flex-1 !justify-center !py-1 !text-[11px]"
            >
              打开统一审核
            </Button>
            <Button
              onPress={abortPendingRun}
              isDisabled={loading}
              className="bauhaus-button bauhaus-button-outline !min-h-8 !flex-1 !justify-center !py-1 !text-[11px]"
            >
              取消本次 Run
            </Button>
          </div>
        </div>
      )}
      {activeRunId && activeRun?.status === "waiting_input" && (
        <div data-testid="agent-ask-panel">
          <AgentAskPanel
          runId={activeRunId}
          onAnswered={handleReviewChanged}
          onPendingChange={setReviewPending}
        />
        </div>
      )}


      {parkedRuns.length > 0 && (
        <div data-testid="agent-parked-runs" className="space-y-1 border-t border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2">
          {parkedRuns.map((item) => (
            <div key={item.id} className="flex items-center gap-2 text-[11.5px]">
              <ClipboardCheck size={12} className="shrink-0 text-[var(--primary-blue)]" />
              <span className="min-w-0 flex-1 truncate text-[var(--foreground-soft)]">
                之前的任务{PARKED_RUN_LABELS[item.status] || "等你处理"}，状态已保存
              </span>
              <button type="button" onClick={() => void restoreParkedRun(item.id)} disabled={loading}
                className="shrink-0 font-semibold text-[var(--foreground)] underline disabled:opacity-50">
                回去处理
              </button>
            </div>
          ))}
        </div>
      )}

      {queuedMessages.length > 0 && (
        <div data-testid="agent-message-queue" className="space-y-1 border-t border-[var(--border)] px-3 py-2">
          <p className="text-[10.5px] text-[var(--foreground-muted)]">
            {agentBusy ? "待发送：助手空闲后按顺序发送" : runNeedsUser ? "待发送：当前任务在等你，处理完会自动发送" : "待发送"}
          </p>
          {queuedMessages.map((item) => (
            <div key={item.id} className="flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-[11.5px]">
              <span className="min-w-0 flex-1 truncate text-[var(--foreground)]">{item.content}</span>
              {!agentBusy && runNeedsUser && (
                <button type="button" onClick={() => sendQueuedNow(item.id)} className="shrink-0 font-semibold underline">现在发送</button>
              )}
              <button type="button" onClick={() => editQueued(item.id)} className="shrink-0 text-[var(--foreground-muted)] underline">改</button>
              <button type="button" aria-label="删除待发送消息"
                onClick={() => setQueuedMessages((current) => current.filter((entry) => entry.id !== item.id))}
                className="shrink-0 text-[var(--foreground-muted)] underline">删</button>
            </div>
          ))}
        </div>
      )}

      {error && (
        <div role="alert" className="space-y-2 border-t border-[var(--border)] bg-[var(--status-blush)] px-3 py-3 text-[12px]">
          <p className="font-semibold text-[var(--foreground)]">{agentRecovery(error).title}</p>
          <p className="break-words text-[var(--primary-red)]">{error}</p>
          <p className="text-[var(--foreground-muted)]">{agentRecovery(error).hint}</p>
          {agentRecovery(error).configure && <Link href={MODEL_SETTINGS_ROUTE} className="inline-flex rounded-md bg-[var(--foreground)] px-3 py-2 font-medium text-[var(--surface)] focus-visible:ring-2">配置内置 Agent</Link>}
        </div>
      )}

      {/* 输入区 */}
      <footer className="border-t border-[var(--border)] p-2.5">
        <div className="flex items-end gap-1.5">
          <Textarea
            value={input}
            onValueChange={setInput}
            minRows={1}
            maxRows={4}
            placeholder={
              loading
                ? "补充或纠正，助手会在下一步读到..."
                : agentBusy
                  ? "可以继续输入，空闲后按顺序发送..."
                  : "问 OfferU，或说你要推进哪一步..."
            }
            variant="bordered"
            className="flex-1"
            classNames={bauhausFieldClassNames}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                sendMessage();
              }
            }}
          />
          <Button
            isIconOnly
            aria-label="发送"
            onPress={() => sendMessage()}
            isDisabled={!input.trim()}
            className="bauhaus-button bauhaus-button-outline !min-h-9 !min-w-9 !px-0 !py-0"
          >
            <Send size={14} />
          </Button>
        </div>
      </footer>
    </div>
  );
}

function PanelMessageBubble({
  message,
  onSuggestion,
}: {
  message: PanelMessage;
  onSuggestion: (prompt: string) => void;
}) {
  const isUser = message.role === "user";
  const response = message.response;

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div className={`max-w-[94%] ${isUser ? "text-right" : ""}`}>
        <div
          className={`inline-block whitespace-pre-wrap rounded-lg border border-[var(--border)] px-3 py-2 text-left text-[13px] leading-6 ${
            isUser ? "bg-[var(--surface-muted)]" : "bg-[var(--surface)]"
          } text-[var(--foreground)]`}
        >
          {message.content}
        </div>
        {message.steered && (
          <p className="mt-0.5 text-[10px] text-[var(--foreground-muted)]">已交给正在进行的任务</p>
        )}
        {response && (
          <div className="mt-2 space-y-2 text-left">
            {response.alerts && response.alerts.length > 0 && <AlertList alerts={response.alerts} />}
            {response.proactive_suggestions && response.proactive_suggestions.length > 0 && (
              <SuggestionList suggestions={response.proactive_suggestions} onSuggestion={onSuggestion} />
            )}
            {response.transferable_skills_summary && (
              <div className="rounded-md border border-[var(--border)] bg-[var(--surface)] p-2.5 text-[12px] leading-5 text-[var(--foreground-soft)]">
                {response.transferable_skills_summary}
              </div>
            )}
            {response.career_paths && response.career_paths.length > 0 && (
              <CareerPathList paths={response.career_paths} />
            )}
            {response.job_cards && response.job_cards.length > 0 && <JobCardList jobs={response.job_cards} />}
            {response.tool_calls && response.tool_calls.length > 0 && <ToolCallList calls={response.tool_calls} />}
            {response.next_steps && response.next_steps.length > 0 && (
              <ul className="space-y-1 rounded-md border border-[var(--border)] bg-[var(--surface-muted)] p-2.5 text-[12px] text-[var(--foreground-soft)]">
                {response.next_steps.map((step) => (
                  <li key={step}>- {step}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function AlertList({ alerts }: { alerts: NonNullable<AgentResponse["alerts"]> }) {
  return (
    <div className="space-y-1.5">
      {alerts.map((alert) => (
        <div
          key={alert.code}
          className="rounded-md border border-[var(--border)] bg-[var(--status-blush)] p-2.5 text-[12px] text-[var(--foreground)]"
        >
          <div className="flex items-start gap-2">
            <AlertTriangle size={14} className="mt-0.5 shrink-0 text-[var(--primary-red)]" />
            <div>
              <p className="font-semibold">{alert.title}</p>
              <p className="mt-0.5 leading-5 text-[var(--foreground-soft)]">{alert.message}</p>
              {alert.action && <p className="mt-0.5 font-medium">{alert.action}</p>}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function SuggestionList({
  suggestions,
  onSuggestion,
}: {
  suggestions: NonNullable<AgentResponse["proactive_suggestions"]>;
  onSuggestion: (prompt: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      {suggestions.map((suggestion) => (
        <button
          key={`${suggestion.title}-${suggestion.prompt}`}
          type="button"
          onClick={() => onSuggestion(suggestion.prompt)}
          className="w-full rounded-md border border-[var(--border)] bg-[var(--surface)] p-2.5 text-left text-[12px] text-[var(--foreground)] transition-colors duration-[var(--dur-quick)] hover:border-[var(--border-strong)] hover:bg-[var(--surface-muted)]"
        >
          <p className="font-semibold">{suggestion.title}</p>
          <p className="mt-0.5 leading-5 text-[var(--foreground-soft)]">{suggestion.description}</p>
        </button>
      ))}
    </div>
  );
}

function CareerPathList({ paths }: { paths: AgentCareerPath[] }) {
  return (
    <div className="space-y-1.5">
      {paths.map((path) => (
        <div key={path.title} className="rounded-md border border-[var(--border)] bg-[var(--surface)] p-2.5">
          <div className="flex items-start gap-2">
            <Sparkles size={14} className="mt-0.5 shrink-0 text-[var(--primary-yellow)]" />
            <div className="min-w-0">
              <p className="text-[13px] font-semibold text-[var(--foreground)]">{path.title}</p>
              <p className="mt-0.5 text-[11px] text-[var(--foreground-muted)]">{path.industry}</p>
              <p className="mt-1 text-[12px] leading-5 text-[var(--foreground-soft)]">{path.fit_reason}</p>
              <p className="mt-1 text-[12px] font-medium text-[var(--foreground)]">{path.salary_range}</p>
              <div className="mt-1.5 flex flex-wrap gap-1">
                {path.search_keywords.map((keyword) => (
                  <span key={keyword} className="bauhaus-chip !py-0.5 !text-[10.5px]">
                    {keyword}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function JobCardList({ jobs }: { jobs: AgentJobCard[] }) {
  return (
    <div className="space-y-1.5">
      {jobs.map((job) => (
        <div key={job.id} className="rounded-md border border-[var(--border)] bg-[var(--surface)] p-2.5">
          <div className="flex items-start gap-2">
            <Briefcase size={14} className="mt-0.5 shrink-0 text-[var(--primary-blue)]" />
            <div className="min-w-0">
              <p className="text-[13px] font-semibold text-[var(--foreground)]">{job.company}</p>
              <p className="mt-0.5 text-[12px] font-medium text-[var(--foreground-soft)]">{job.title}</p>
              <p className="mt-0.5 text-[11px] text-[var(--foreground-muted)]">
                {[job.location, job.salary_text, job.source].filter(Boolean).join(" / ")}
              </p>
              {job.apply_url && (
                <ExternalUrlLink
                  href={job.apply_url}
                  className="mt-1 inline-block text-[12px] font-medium text-[var(--primary-blue)] underline"
                >
                  打开投递链接
                </ExternalUrlLink>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function ToolCallList({ calls }: { calls: AgentResponse["tool_calls"] }) {
  return (
    <div className="space-y-1.5">
      {calls.map((call, index) => {
        const presentation = presentAgentToolCall(call);
        return (
          <details
            key={`${call.tool}-${index}`}
            className="rounded-md border border-[var(--border)] bg-[var(--surface)] p-2 text-[12px] text-[var(--foreground-soft)]"
          >
            <summary className="flex cursor-pointer items-center gap-1.5 font-medium text-[var(--foreground)]">
              <Wrench size={12} />
              {call.tool}
            </summary>
            {presentation && (
              <p className="mt-1.5 border-l-2 border-[var(--border-strong)] pl-2 leading-5 text-[var(--foreground)]">
                {presentation}
              </p>
            )}
            <pre className="custom-scrollbar mt-1.5 max-h-28 overflow-auto whitespace-pre-wrap rounded bg-[var(--surface-muted)] p-2">
              {previewJson(call.result)}
            </pre>
          </details>
        );
      })}
    </div>
  );
}
