"use client";

// =============================================
// OfferU 主 Agent 面板 — Python Run Host → migrated Agent kernel
// 对话仍是交互记录；任务、Run、事件、提案、确认和审计由后端控制。
// =============================================

import { ToolExecutionList } from "./EmbeddedAgentStreamView";
import { AgentAskPanel } from "./AgentAskPanel";
import { AgentMarkdown } from "./AgentMarkdown";
import { applyRuntimeToolEvent, createInitialAgentStreamState, type AgentStreamState } from "@/lib/embeddedAgentStream";
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
import { SHOWCASE } from "@/lib/showcase";
import Link from "next/link";
import { agentRecovery, MODEL_SETTINGS_ROUTE } from "@/lib/agentRecovery";
import { quickActionsForStage } from "@/lib/quickActions";

interface PanelMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  response?: AgentResponse;
}

interface ResumeCandidate {
  conversationId: string;
  conversationTitle: string;
  runId: string;
  status: string;
}

/** 一个正在跑的发送：每轮自己的流式文字、工具进度和进度提示，并发时互不覆盖。 */
interface InFlightTurn {
  id: string;
  progressText: string;
  streamingText: string;
  toolStream: AgentStreamState;
}

interface ParkedRun {
  id: string;
  status: string;
}

const PARKED_RUN_LABELS: Record<string, string> = {
  waiting_input: "等你回答",
  interrupted: "已中断，可恢复",
};

const STAGE_LABELS: Record<string, string> = {
  campus: "校招",
  experienced: "社招",
  unknown: "待确认",
};

const RESUMABLE_RUN_STATUSES = new Set([
  "queued",
  "running",
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

/** Irreversible steps the Agent queued for the user; the Run itself already finished. */
function pendingCountOf(run?: AgentRunRecord | null) {
  return Number(run?.final_result?.pending_action_count || 0);
}

function toPanelResponse(response: AgentRunResponse): AgentResponse {
  const guardian = response.guardian || {};
  return {
    assistant_message: response.assistant_message,
    mode: response.run.mode,
    active_skill: response.active_skill,
    requires_confirmation: pendingCountOf(response.run) > 0,
    tool_calls: [],
    proposed_actions: [],
    user_stage: guardian.user_stage,
    stage_confidence: guardian.stage_confidence,
    stage_signals: guardian.stage_signals,
    alerts: guardian.alerts,
    proactive_suggestions: guardian.proactive_suggestions,
    conversation_id: response.conversation_id,
    conversation_title: response.conversation_title,
  };
}

function progressForEvent(event: string, operation: unknown): string | null {
  switch (event) {
    case "run.started":
    case "run.created":
      return "正在思考...";
    case "executor.started":
    case "runtime.session_started":
      return "助手已就绪，正在处理当前任务...";
    case "tool.started":
    case "runtime.tool_started":
      return "助手正在调用 OfferU 工具...";
    case "operation.started":
      return "正在读取：" + String(operation || "OfferU 数据");
    case "approval.requested":
      return "有一步不可撤销，已放进待确认列表；助手继续做别的...";
    case "input.required":
      return "助手需要你的回答后继续...";
    case "runtime.retry_started":
      return "模型调用正在安全重试...";
    case "runtime.compaction_started":
      return "正在压缩本 Run 的模型上下文...";
    case "stream.reconnecting":
      return "连接中断，正在按事件游标恢复同一个 Run...";
    default:
      return null;
  }
}

export function AgentPanel() {
  const [slashIndex, setSlashIndex] = useState(0);
  const [messages, setMessages] = useState<PanelMessage[]>([
    {
      id: "welcome",
      role: "assistant",
      content: SHOWCASE
        ? "这是 OfferU 网页演示 Agent。它只使用演示数据，不连接你电脑里的 Coding Agent；真实本地数据与外置 Agent 请在本机安装 OfferU。"
        : "在这里查看 OfferU 任务与确认请求。需要时可从「接入与同步」连接本机 Coding Agent，把当前工作交给它。",
    },
  ]);
  const [input, setInput] = useState("");
  const [pendingActionCount, setPendingActionCount] = useState(0);
  const [runActionPending, setRunActionPending] = useState(false);
  const [inFlightTurns, setInFlightTurns] = useState<InFlightTurn[]>([]);
  const [toolStream, setToolStream] = useState(createInitialAgentStreamState);
  const [progressText, setProgressText] = useState("");
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
  const turnControllersRef = useRef<Map<string, AbortController>>(new Map());
  const lastSendRef = useRef<{ content: string; at: number } | null>(null);
  const turnSeqRef = useRef(0);
  const suppressResumePromptRef = useRef(false);
  const currentConvRef = useRef<string | null>(null);
  // D-2：导航只"分离"正在跑的流，不中断它；分离的流结果不再写进当前界面。
  const [parkedRuns, setParkedRuns] = useState<ParkedRun[]>([]);
  const detachedControllersRef = useRef<Set<AbortController>>(new Set());
  const [reviewPending, setReviewPending] = useState(0);
  // 当前 Run 在等用户回答 Ask 或可恢复。这只决定"新消息开新一轮前先把它停放"，
  // 从不禁用输入。待确认的不可逆操作不挡 Run：它们在全局待确认列表里。
  const runNeedsUser = Boolean(interruptedRunId) || reviewPending > 0;
  // 每次发送都开一个新 Run，可与其他 Run 并发；超过设置里的并发上限时后端直接报错。
  const loading = inFlightTurns.length > 0 || runActionPending;

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
      turnControllersRef.current.forEach((controller) => controller.abort());
      turnControllersRef.current.clear();
      lastSendRef.current = null;
      suppressResumePromptRef.current = false;
      currentConvRef.current = null;
      setMessages([]);
      setInput("");
      setRunActionPending(false);
      setInFlightTurns([]);
      setToolStream(createInitialAgentStreamState());
      setActiveRun(null);
      setActiveRunId(null);
      setInterruptedRunId(null);
      setPendingActionCount(0);
      setReviewPending(0);
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
      setError("");
    };
    window.addEventListener("offeru-career-reset", cleared);
    return () => window.removeEventListener("offeru-career-reset", cleared);
  }, []);

  useEffect(() => () => {
    const controllers = [...turnControllersRef.current.values()];
    turnControllersRef.current.clear();
    controllers.forEach((controller) => controller.abort());
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
  }, [messages, inFlightTurns]);

  /** 把等用户处理的 Run 收进"停放"条：状态已持久化，随时可回来处理，绝不隐式取消。 */
  const parkActiveRun = () => {
    if (!activeRunId || !runNeedsUser) return;
    const status = interruptedRunId ? "interrupted" : "waiting_input";
    const parkedId = activeRunId;
    setParkedRuns((current) => [
      ...current.filter((item) => item.id !== parkedId),
      { id: parkedId, status },
    ]);
    setActiveRunId(null);
    setActiveRun(null);
    setPendingActionCount(0);
    setInterruptedRunId(null);
  };

  const sendMessage = async (text?: string, explicitSkillId?: string) => {
    const content = (text ?? input).trim();
    if (!content) return;
    if (text === undefined) setInput("");
    await startTurn(content, explicitSkillId);
  };

  const patchTurn = (turnId: string, patch: (turn: InFlightTurn) => InFlightTurn) => {
    setInFlightTurns((current) => current.map((turn) => (turn.id === turnId ? patch(turn) : turn)));
  };

  const startTurn = async (content: string, explicitSkillId?: string) => {
    if (!content) return;
    // 双击 / 连按回车防重：同一段文字 800ms 内只开一轮。
    const now = Date.now();
    const last = lastSendRef.current;
    if (last && last.content === content && now - last.at < 800) return;
    lastSendRef.current = { content, at: now };
    parkActiveRun();
    const requestSkillId = explicitSkillId || selectedSkillId;
    const currentConversationId = conversationId;
    suppressResumePromptRef.current = true;
    setResumeCandidate(null);
    currentConvRef.current = currentConversationId;
    const turnId = "turn-" + now + "-" + ++turnSeqRef.current;
    const controller = new AbortController();
    turnControllersRef.current.set(turnId, controller);
    // 被导航分离到后台的流：结果只落在它自己的对话里，绝不写进当前界面。
    const isDetached = () => detachedControllersRef.current.has(controller) || controller.signal.aborted;
    let streamState = createInitialAgentStreamState();

    setMessages((prev) => [...prev, { id: "user-" + turnId, role: "user", content }]);
    setInFlightTurns((current) => [
      ...current,
      { id: turnId, progressText: "正在发送...", streamingText: "", toolStream: streamState },
    ]);
    setError("");

    try {
      const runtimeResponse = await agentRuntimeApi.start(
        {
          message: content,
          skill_id: requestSkillId,
          conversation_id: currentConversationId,
        },
        (event, data) => {
          if (isDetached()) return;
          streamState = applyRuntimeToolEvent(streamState, event, data || {});
          const nextStream = streamState;
          const eventRunId = String(data?.run_id || "");
          if (eventRunId) setActiveRunId(eventRunId);
          const progress = progressForEvent(event, data?.payload?.operation);
          const delta = event === "assistant.delta" || event === "message.delta"
            ? String(data?.payload?.delta || "")
            : "";
          patchTurn(turnId, (turn) => ({
            ...turn,
            toolStream: nextStream,
            progressText: progress ?? turn.progressText,
            streamingText: delta ? turn.streamingText + delta : turn.streamingText,
          }));
        },
        controller.signal,
      );
      if (isDetached()) return;
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
        id: "assistant-" + turnId,
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
      setToolStream(streamState);
      setPendingActionCount(pendingCountOf(runtimeResponse.run));
      refreshConversations();
    } catch (err: any) {
      if (isDetached()) return;
      if (err instanceof Error && err.name === "AbortError") return;
      setError(safeClientErrorMessage(err, "OfferU 请求失败"));
      setInput((current) => current || content);
    } finally {
      detachedControllersRef.current.delete(controller);
      turnControllersRef.current.delete(turnId);
      setInFlightTurns((current) => current.filter((turn) => turn.id !== turnId));
    }
  };

  // 其他页面（如简历画布）交来的意图：每条直接开一个新 Run，可与其他 Run 并发。
  const startTurnRef = useRef(startTurn);
  startTurnRef.current = startTurn;
  useEffect(() => {
    const take = () => {
      for (const request of drainAgentCompose()) {
        void startTurnRef.current(request.message, request.skillId);
      }
    };
    take();
    window.addEventListener(AGENT_COMPOSE_EVENT, take);
    return () => window.removeEventListener(AGENT_COMPOSE_EVENT, take);
  }, []);

  const restoreParkedRun = async (id: string) => {
    if (loading) return;
    try {
      const { run } = await agentRuntimeApi.run(id);
      parkActiveRun();
      setParkedRuns((current) => current.filter((item) => item.id !== id));
      setActiveRunId(run.id);
      setActiveRun(run);
      setPendingActionCount(pendingCountOf(run));
      setInterruptedRunId(run.status === "interrupted" ? run.id : null);
    } catch (err: any) {
      setError(safeClientErrorMessage(err, "读取待处理任务失败"));
    }
  };

  /**
   * D-2：切换或新建对话只把当前流"分离"到后台，不中断 Run，也不取消等用户处理的 Run。
   * 等待中的 Run 已持久化，可在历史对话、输入框上方的待处理条或统一审核入口继续处理。
   * 不 abort——abort 会断开 SSE 并让后端把 Run 标成 interrupted。
   */
  const detachActiveStream = () => {
    turnControllersRef.current.forEach((controller) => {
      if (!controller.signal.aborted) detachedControllersRef.current.add(controller);
    });
    turnControllersRef.current.clear();
    lastSendRef.current = null;
    setInFlightTurns([]);
  };

  const startNewConversation = () => {
    suppressResumePromptRef.current = true;
    setResumeCandidate(null);
    detachActiveStream();
    currentConvRef.current = null;
    setToolStream(createInitialAgentStreamState());
    setParkedRuns([]);
    setConversationId(null);
    setConversationTitle("新对话");
    setActiveRunId(null);
    setActiveRun(null);
    setInterruptedRunId(null);
    setSelectedSkillId(AUTO_SKILL_ID);
    setPendingActionCount(0);
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
    setToolStream(createInitialAgentStreamState());
    setParkedRuns([]);
    try {
      const conversation = await agentSupportApi.conversation(id);
      setConversationId(conversation.id);
      setConversationTitle(conversation.title || "历史对话");
      setActiveRunId(null);
      setActiveRun(null);
      setInterruptedRunId(null);
      setPendingActionCount(0);
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
      if (latestRun) {
        setActiveRunId(latestRun.id);
        setPendingActionCount(pendingCountOf(latestRun));
      }
      if (latestRun?.status === "interrupted") {
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
          setPendingActionCount(pendingCountOf(run));
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
        } catch {
          // The next refresh event or reload re-reads the persisted Run.
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
    setRunActionPending(true);
    setProgressText("正在取消当前 Run...");
    setError("");
    try {
      const result = await agentRuntimeApi.abort(activeRunId);
      setActiveRun(result.run);
      setActiveRunId(null);
      setInterruptedRunId(null);
      setPendingActionCount(0);
      setReviewPending(0);
      setMessages((prev) => [
        ...prev,
        {
          id: `assistant-abort-${Date.now()}`,
          role: "assistant",
          content: "已取消当前 Run。待确认列表里的操作不会因此执行。",
        },
      ]);
    } catch (err: any) {
      setError(safeClientErrorMessage(err, "取消 Run 失败"));
    } finally {
      setRunActionPending(false);
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
  };

  const resumeInterruptedRun = async () => {
    if (!interruptedRunId || loading) return;
    setRunActionPending(true);
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
      setPendingActionCount(pendingCountOf(runtimeResponse.run));
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
      setRunActionPending(false);
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

  const slashQuery = input.startsWith("/") && !/\s/.test(input) ? input.slice(1).toLowerCase() : null;
  const slashMatches = slashQuery === null
    ? []
    : skills
        .filter((skill) => skill.id.toLowerCase().includes(slashQuery) || skill.name.toLowerCase().includes(slashQuery))
        .slice(0, 8);
  const pickSlashSkill = (skillId: string) => {
    setInput(`/${skillId} `);
    setSlashIndex(0);
  };

  return (
    <div className="offeru-agent-panel flex h-full min-h-0 flex-col">
      <div className="agent-bar flex items-center justify-between gap-2 border-b border-[var(--border)] px-3 py-1.5">
        <button
          type="button"
          onClick={() => setHistoryOpen((value) => !value)}
          className="flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-[12.5px] font-medium text-[var(--foreground)] transition-colors duration-[var(--dur-quick)] hover:bg-[var(--surface-muted)]"
          title="历史对话"
        >
          <History size={13} className="shrink-0 text-[var(--foreground-muted)]" />
          <span className="truncate">{conversationTitle || "新对话"}</span>
        </button>
        <div className="flex shrink-0 items-center gap-0.5">
          {hostedSessions.length > 0 && (
            <button
              type="button"
              onClick={() => setHostedOpen((value) => !value)}
              aria-label="外部执行器"
              title="外部执行器会话"
              className="rounded-md p-1.5 text-[var(--foreground-muted)] transition-colors duration-[var(--dur-quick)] hover:bg-[var(--surface-muted)] hover:text-[var(--foreground)]"
            >
              <Activity size={13} />
            </button>
          )}
          <Link
            href={MODEL_SETTINGS_ROUTE}
            title="模型设置"
            className="rounded-md px-1.5 py-1 text-[11px] text-[var(--foreground-muted)] transition-colors duration-[var(--dur-quick)] hover:bg-[var(--surface-muted)] hover:text-[var(--foreground)]"
          >
            模型
          </Link>
          <button
            type="button"
            onClick={startNewConversation}
            aria-label="新对话"
            title="新对话"
            className="rounded-md p-1.5 text-[var(--foreground-muted)] transition-colors duration-[var(--dur-quick)] hover:bg-[var(--surface-muted)] hover:text-[var(--foreground)]"
          >
            <Plus size={14} />
          </button>
        </div>
      </div>

      {historyOpen && (
        <div className="border-b border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-[12px] font-semibold text-[var(--foreground)]">历史对话</p>
            <div className="flex items-center gap-0.5">
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
                className="rounded-md p-1.5 text-[var(--foreground-muted)] hover:bg-[var(--surface)] hover:text-[var(--foreground)]"
              >
                <Upload size={13} />
              </button>
              <button
                type="button"
                aria-label="导出助手记忆"
                title="导出记忆为 Markdown"
                onClick={exportMemory}
                className="rounded-md p-1.5 text-[var(--foreground-muted)] hover:bg-[var(--surface)] hover:text-[var(--foreground)]"
              >
                <Download size={13} />
              </button>
              <button
                type="button"
                onClick={startNewConversation}
                className="bauhaus-button bauhaus-button-sm"
              >
                <Plus size={12} />
                新建
              </button>
            </div>
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


      {/* 消息流 */}
      <div ref={scrollRef} className="agent-thread custom-scrollbar min-h-0 flex-1 overflow-y-auto px-3.5 py-4">
        <div className="space-y-4">
          {messages.map((message) => (
            <PanelMessageBubble key={message.id} message={message} onSuggestion={sendMessage} />
          ))}
          {inFlightTurns.map((turn) => (
            <div key={turn.id} id={"agent-turn-" + turn.id} data-testid="agent-inflight-turn" className="space-y-2">
              {turn.streamingText && (
                <div className="agent-msg agent-msg-assistant">
                  <AgentMarkdown text={turn.streamingText} />
                </div>
              )}
              <ToolExecutionList executions={turn.toolStream.toolExecutions} />
              <div className="inline-flex items-center gap-1.5 px-0.5 text-[12px] text-[var(--foreground-muted)]">
                <Loader2 size={12} className="animate-spin" />
                {turn.progressText}
              </div>
            </div>
          ))}
          {inFlightTurns.length === 0 && <ToolExecutionList executions={toolStream.toolExecutions} />}
          {runActionPending && (
            <div className="inline-flex items-center gap-1.5 px-0.5 text-[12px] text-[var(--foreground-muted)]">
              <Loader2 size={12} className="animate-spin" />
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

      {pendingActionCount > 0 && (
        <div className="border-t border-[var(--border)] bg-[var(--status-blush)] px-3 py-2.5">
          <p className="text-[12px] font-semibold text-[var(--foreground)]">有 {pendingActionCount} 步不可撤销的操作等你确认</p>
          <p className="mt-1 text-[11px] leading-4 text-[var(--foreground-soft)]">助手没有停下来等；你确认后才会执行，结果会在下一轮告诉它。</p>
          <Button
            onPress={() => window.dispatchEvent(new Event("offeru-open-agent-actions"))}
            className="bauhaus-button bauhaus-button-red mt-2 !min-h-8 !w-full !justify-center !py-1 !text-[11px]"
          >
            打开待确认
          </Button>
        </div>
      )}
      {activeRunId && (
        <div data-testid="agent-ask-panel">
          <AgentAskPanel
          runId={activeRunId}
          onAnswered={handleReviewChanged}
          onPendingChange={setReviewPending}
        />
        </div>
      )}


      {error && (
        <div role="alert" className="space-y-2 border-t border-[var(--border)] bg-[var(--status-blush)] px-3 py-3 text-[12px]">
          <p className="font-semibold text-[var(--foreground)]">{agentRecovery(error).title}</p>
          <p className="break-words text-[var(--primary-red)]">{error}</p>
          <p className="text-[var(--foreground-muted)]">{agentRecovery(error).hint}</p>
          {agentRecovery(error).configure && <Link href={MODEL_SETTINGS_ROUTE} style={{ background: "var(--foreground)", color: "#ffffff" }} className="inline-flex rounded-md px-3 py-2 font-medium no-underline transition-opacity hover:opacity-90 focus-visible:ring-2">配置内置 Agent</Link>}
        </div>
      )}

      {(parkedRuns.length > 0 || inFlightTurns.length > 1) && (
        <div data-testid="agent-task-strip" className="border-t border-[var(--border)] px-3 py-2">
          <p className="mb-1 px-1 text-[11px] font-semibold text-[var(--foreground-muted)]">
            任务 · {inFlightTurns.length + parkedRuns.length}
          </p>
          <div className="space-y-0.5">
            {inFlightTurns.map((turn) => {
              const prompt = messages.find((message) => message.id === "user-" + turn.id)?.content || "新任务";
              return (
                <button
                  key={turn.id}
                  type="button"
                  onClick={() => document.getElementById("agent-turn-" + turn.id)?.scrollIntoView({ behavior: "smooth", block: "nearest" })}
                  className="agent-task-row"
                >
                  <Loader2 size={12} className="shrink-0 animate-spin text-[var(--foreground-muted)]" />
                  <span className="min-w-0 flex-1 truncate text-left text-[var(--foreground)]">{prompt}</span>
                  <span className="max-w-[40%] shrink-0 truncate text-[10.5px] text-[var(--foreground-muted)]">
                    {turn.progressText || "进行中"}
                  </span>
                </button>
              );
            })}
            {parkedRuns.length > 0 && (
              <div data-testid="agent-parked-runs" className="space-y-0.5">
                {parkedRuns.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => void restoreParkedRun(item.id)}
                    disabled={loading}
                    className="agent-task-row disabled:opacity-50"
                  >
                    <ClipboardCheck size={12} className="shrink-0 text-[var(--primary-blue)]" />
                    <span className="min-w-0 flex-1 truncate text-left text-[var(--foreground-soft)]">
                      之前的任务{PARKED_RUN_LABELS[item.status] || "等你处理"}，状态已保存
                    </span>
                    <span className="shrink-0 text-[10.5px] font-semibold text-[var(--foreground)]">回去处理</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* 输入区 */}
      <footer className="agent-bar border-t border-[var(--border)] px-3 py-2.5">
        {slashMatches.length > 0 && (
          <div role="listbox" aria-label="技能" className="custom-scrollbar mb-1.5 max-h-56 overflow-y-auto rounded-md border border-[var(--border)] bg-[var(--surface)] py-1">
            {slashMatches.map((skill, index) => (
              <button
                key={skill.id}
                type="button"
                role="option"
                aria-selected={index === slashIndex}
                onMouseDown={(event) => {
                  event.preventDefault();
                  pickSlashSkill(skill.id);
                }}
                className={`flex w-full items-baseline gap-2 px-2.5 py-1.5 text-left text-[12px] ${
                  index === slashIndex ? "bg-[var(--surface-muted)]" : "hover:bg-[var(--surface-hover)]"
                }`}
              >
                <span className="shrink-0 font-mono text-[var(--foreground)]">/{skill.id}</span>
                <span className="truncate text-[var(--foreground-muted)]">{skill.name}</span>
                {skill.source?.startsWith("local") && (
                  <span className="ml-auto shrink-0 rounded border border-[var(--border)] px-1 text-[10px] leading-4 text-[var(--foreground-muted)]">本机</span>
                )}
              </button>
            ))}
          </div>
        )}
        <div className="flex items-end gap-1.5">
          <Textarea
            value={input}
            onValueChange={setInput}
            minRows={1}
            maxRows={4}
            placeholder={
              runNeedsUser
                ? "继续对话或说明如何调整；当前待处理的任务会先保存，随时可回来"
                : "问 OfferU，输入 / 选择技能..."
            }
            variant="bordered"
            className="flex-1"
            classNames={bauhausFieldClassNames}
            onKeyDown={(event) => {
              if (slashMatches.length > 0) {
                const count = slashMatches.length;
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setSlashIndex((value) => (value + 1) % count);
                  return;
                }
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setSlashIndex((value) => (value + count - 1) % count);
                  return;
                }
                if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
                  event.preventDefault();
                  pickSlashSkill(slashMatches[Math.min(slashIndex, count - 1)].id);
                  return;
                }
              }
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

  if (!isUser && message.id.startsWith("welcome")) {
    return (
      <p className="px-2 pt-8 text-center text-[12px] leading-5 text-[var(--foreground-muted)] opacity-80">
        {message.content}
      </p>
    );
  }

  return (
    <div className={isUser ? "flex justify-end pl-10" : "flex justify-start"}>
      <div className={isUser ? "min-w-0 max-w-full" : "w-full min-w-0"}>
        <div className={isUser ? "agent-msg agent-msg-user" : "agent-msg agent-msg-assistant"}>
          {isUser ? message.content : <AgentMarkdown text={message.content} />}
        </div>
        {response && (
          <div className="mt-2 space-y-2 text-left">
            {response.alerts && response.alerts.length > 0 && <AlertList alerts={response.alerts} />}
            {response.proactive_suggestions && response.proactive_suggestions.length > 0 && (
              <SuggestionList suggestions={response.proactive_suggestions} onSuggestion={onSuggestion} />
            )}
            {response.transferable_skills_summary && (
              <div className="agent-card px-3 py-2.5 text-[12px] leading-5 text-[var(--foreground-soft)]">
                {response.transferable_skills_summary}
              </div>
            )}
            {response.career_paths && response.career_paths.length > 0 && (
              <CareerPathList paths={response.career_paths} />
            )}
            {response.job_cards && response.job_cards.length > 0 && <JobCardList jobs={response.job_cards} />}
            {response.tool_calls && response.tool_calls.length > 0 && <ToolCallList calls={response.tool_calls} />}
            {response.next_steps && response.next_steps.length > 0 && (
              <ul className="agent-card space-y-1 px-3 py-2 text-[12px] leading-5 text-[var(--foreground-soft)]">
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
          className="agent-card agent-card-alert px-3 py-2.5 text-[12px] text-[var(--foreground)]"
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
          className="w-full agent-card px-3 py-2.5 text-left text-[12px] text-[var(--foreground)] transition-colors duration-[var(--dur-quick)] hover:border-[var(--border-strong)] hover:bg-[var(--surface-muted)]"
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
        <div key={path.title} className="agent-card px-3 py-2.5">
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
        <div key={job.id} className="agent-card px-3 py-2.5">
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
    <div className="agent-tool-group" role="list" aria-label="本轮工具调用">
      {calls.map((call, index) => {
        const presentation = presentAgentToolCall(call);
        return (
          <details key={call.tool + "-" + index} role="listitem" className="group">
            <summary className="agent-tool-row cursor-pointer list-none">
              <Wrench size={11} className="shrink-0 text-[var(--foreground-muted)]" />
              <span className="shrink-0 font-mono text-[11px] text-[var(--foreground)]">{call.tool}</span>
              {presentation && (
                <span className="min-w-0 flex-1 truncate text-[var(--foreground-muted)]">{presentation}</span>
              )}
              <ChevronDown size={11} className="ml-auto shrink-0 text-[var(--foreground-muted)] transition-transform duration-[var(--dur-quick)] group-open:rotate-180" />
            </summary>
            <div className="agent-tool-detail space-y-1">
              {presentation && (
                <p className="text-[11.5px] leading-5 text-[var(--foreground-soft)]">{presentation}</p>
              )}
              <pre className="custom-scrollbar max-h-28 overflow-auto whitespace-pre-wrap rounded-md border border-[var(--border)] bg-[var(--surface-muted)] px-2 py-1.5 font-mono text-[10.5px] leading-4 text-[var(--foreground-soft)]">
                {previewJson(call.result)}
              </pre>
            </div>
          </details>
        );
      })}
    </div>
  );
}
