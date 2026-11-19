"use client";

// =============================================
// OfferU 主 Agent 面板 — Python Run Host → migrated Agent kernel
// 对话仍是交互记录；任务、Run、事件、提案、确认和审计由后端控制。
// =============================================

import { ToolExecutionList } from "./EmbeddedAgentStreamView";
import { AgentToolError } from "./AgentToolErrorCard";
import { isToolFailure } from "@/lib/agentToolError";
import { AgentAskPanel } from "./AgentAskPanel";
import { AgentMarkdown } from "./AgentMarkdown";
import { applyRuntimeToolEvent, createInitialAgentStreamState, type AgentStreamState } from "@/lib/embeddedAgentStream";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Button, Textarea } from "@heroui/react";
import {
  Activity,
  AlertTriangle,
  Briefcase,
  ClipboardCheck,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  ArrowUp,
  Hand,
  Library,
  Lock,
  History,
  ListTodo,
  Loader2,
  Mail,
  MoreHorizontal,
  Paperclip,
  PenLine,
  Plus,
  RefreshCw,
  Sparkles,
  Square,
  Trash2,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import { Menu } from "@/components/ui";
import {
  agentSupportApi,
  hostedExecutorApi,
  agentRuntimeApi,
  type AgentCareerPath,
  type AgentConversationSummary,
  type AgentJobCard,
  type AgentResponse,
  type AgentRunRecord,
  type AgentToolCall,
  type HostedExecutorEvent,
  type HostedExecutorSession,
  type HostedExecutorSessionDetail,
  type AgentRunResponse,
} from "@/lib/api";
import { AGENT_COMPOSE_EVENT, drainAgentCompose } from "@/lib/agentCompose";
import { presentAgentToolCall } from "@/lib/agentToolPresentation";
import { safeClientErrorMessage } from "@/lib/safe-error";
import { AgentConnectionStatus } from "./AgentConnectionPanel";
import { ExternalUrlLink } from "@/components/ExternalUrlLink";
import { SHOWCASE } from "@/lib/showcase";
import { getBridgeState, subscribeBridge } from "@/lib/bridge";
import { DemoAgentPanel } from "./DemoAgentPanel";
import { AgentHistoryList } from "./AgentHistoryList";
import { AgentScrollToLatest, AgentTurnTimeline, smoothScrollTo, type TurnTimelineHandle } from "./AgentConversationNav";
import { AgentCopyButton, AgentImageViewer, AgentQuoteBranchActions, AgentQuoteChip } from "./AgentMessageActions";
import { quotePreview, splitQuote, withQuote } from "@/lib/agentQuote";
import { branchUpto, canBranchFrom, isWelcomeMessage } from "@/lib/agentMessageBranch";
import { isAwayFromBottom, nextStickToBottom, splitConversationTurns, turnIndexByMessage } from "@/lib/agentConversationNav";
import { AgentSlashMenu, useAgentSlash, type SlashAction } from "./AgentSlashMenu";
import { contextUsageFromEvent, type AgentContextUsage } from "@/lib/agentContextUsage";
import { ContextUsageRing } from "@/components/ui/agent/ContextUsageRing";
import Link from "next/link";
import { agentRecovery, MODEL_SETTINGS_ROUTE } from "@/lib/agentRecovery";
import { quickActionsForStage } from "@/lib/quickActions";
import { AgentComposerControls, resolveComposerChoice, useComposerOptions, useModelCatalog } from "./AgentComposerControls";
import { AgentOrb, AnimatedPlaceholder, ComposerGrip, useComposerWidth } from "./AgentComposerChrome";
import { AgentOrbIcon, AgentWorkingOrb } from "./AgentWorkingOrb";
import { agentOrbState } from "@/lib/agentWorkingOrb";
import { AgentAttachmentTray, AgentMessageAttachments, type SentAttachment } from "./AgentAttachmentTray";
import { useComposerAttachments, type ComposerAttachment } from "./useComposerAttachments";
import { AGENT_ATTACHMENT_ACCEPT, ATTACHMENT_ONLY_MESSAGE, hasDraggedFiles } from "@/lib/agentAttachments";
import { createFrameBatcher, partialReplyFrom } from "@/lib/agentStreaming";
import { AgentThinkingBlock } from "./AgentThinkingBlock";
import { AgentQueueTray } from "./AgentQueueTray";
import { AgentSkillHub } from "./AgentSkillHub";
import {
  composerKeyIntent, enqueue, enqueueFront, loadQueue, nextArmed, queuedFor, rebindConversation, removeQueued, saveQueue,
  type QueuedMessage,
} from "@/lib/agentSteerQueue";

interface PanelMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  response?: AgentResponse;
  attachments?: SentAttachment[];
  /** 这一轮的思考过程（只在本次会话里有，不落盘）。 */
  thinking?: { text: string; ms: number };
  /** Run 中断 / 失败前已经流出的半截回答：本地保留，不在服务端对话里。 */
  partial?: "cancelled" | "failed";
  /** Run 在跑时用 Enter 插进去的话（服务端也存进了对话）。 */
  steered?: boolean;
}

function browserStorage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
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
  /** 思考过程（reasoning.delta）；开始 / 结束时间给思考块计时，正文一开始就算结束。 */
  reasoningText?: string;
  reasoningStartedAt?: number;
  reasoningEndedAt?: number;
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

const agentComposerFieldClassNames = {
  inputWrapper: "!min-h-0 !border-0 !bg-transparent !px-1.5 !py-1 !shadow-none",
  input: "!text-[13px] !leading-[22px] !outline-0 focus-visible:!outline-0 placeholder:!text-[var(--foreground-faint)]",
};

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

export function AgentPanel({ onClose }: { onClose?: () => void } = {}) {
  const bridge = useSyncExternalStore(subscribeBridge, getBridgeState, getBridgeState);
  return SHOWCASE && !bridge.active ? <DemoAgentPanel /> : <BackendAgentPanel onClose={onClose} />;
}

function BackendAgentPanel({ onClose }: { onClose?: () => void }) {
  const [messages, setMessages] = useState<PanelMessage[]>([
    {
      id: "welcome",
      role: "assistant",
      content: SHOWCASE
        ? "这是 OfferU 网页演示 Agent。它只使用演示数据，不连接你电脑里的 Coding Agent；真实本地数据与外置 Agent 请在本机安装 OfferU。"
        : "改简历、排待办、读邮件里的邀约都可以直接说。要用本机的 Coding Agent，去「接入与同步」连上。",
    },
  ]);
  const [input, setInput] = useState("");
  const [pendingActionCount, setPendingActionCount] = useState(0);
  const [runActionPending, setRunActionPending] = useState(false);
  const [inFlightTurns, setInFlightTurns] = useState<InFlightTurn[]>([]);
  const [toolStream, setToolStream] = useState(createInitialAgentStreamState);
  const [progressText, setProgressText] = useState("");
  const [error, setError] = useState("");
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [contextUsage, setContextUsage] = useState<AgentContextUsage | null>(null);
  useEffect(() => setContextUsage(null), [conversationId]);
  const [conversationTitle, setConversationTitle] = useState("新对话");
  const [resumeCandidate, setResumeCandidate] = useState<ResumeCandidate | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [activeRun, setActiveRun] = useState<AgentRunRecord | null>(null);
  const [interruptedRunId, setInterruptedRunId] = useState<string | null>(null);
  const [composerOptions, setComposerOptions] = useComposerOptions();
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [skillHubOpen, setSkillHubOpen] = useState(false);
  const modelCatalog = useModelCatalog(modelMenuOpen);
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
  // 输入框附件：拖入、粘贴或点 + 号添加，选中即上传
  const attachmentInputRef = useRef<HTMLInputElement | null>(null);
  const composerWidth = useComposerWidth();
  const composerInputRef = useRef<HTMLTextAreaElement>(null);
  // 引用回复：整条消息或选中的一段，发送时以 Markdown 引用块放在正文前（lib/agentQuote）。
  const [quote, setQuote] = useState<string | null>(null);
  const [branching, setBranching] = useState(false);
  const dragDepthRef = useRef(0);
  const [dragActive, setDragActive] = useState(false);
  const composerAttachments = useComposerAttachments(agentRuntimeApi.uploadAttachment);
  const scrollRef = useRef<HTMLDivElement>(null);
  // 跟随底部：用户往上翻就停，回到底部（或点「回到最新」）再跟；流式输出不会把人拉回去。
  const stickRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const timelineRef = useRef<TurnTimelineHandle>(null);
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
  // 同一时间只跑一个 Run：在跑时 Enter 是插话（/steer），Tab 是排队（托盘，这一轮结束后依次发）。
  const loading = inFlightTurns.length > 0 || runActionPending;
  const busyRef = useRef(loading);
  busyRef.current = loading;
  const [queue, setQueue] = useState<QueuedMessage[]>(() => loadQueue(browserStorage()));
  useEffect(() => { saveQueue(browserStorage(), queue); }, [queue]);
  const visibleQueue = queuedFor(queue, conversationId);
  // 输入框：能发就是「发送」胶囊；正在跑又没东西可发时，发送键收成一个小像素格加载（参考 Inspora「composer mockup」）。
  const canSend = (Boolean(input.trim()) || composerAttachments.readyCount > 0) && !composerAttachments.uploading;
  const working = loading;
  // 输入框左侧的点阵球和最新一轮的运行胶囊同一个阶段。
  const latestTurn = inFlightTurns[inFlightTurns.length - 1];
  const composerOrbState = agentOrbState(latestTurn ? latestTurn.progressText : progressText, { streaming: Boolean(latestTurn?.streamingText) });
  const [sentPulse, setSentPulse] = useState(false);
  const pulseTimer = useRef<number | null>(null);
  useEffect(() => () => { if (pulseTimer.current) window.clearTimeout(pulseTimer.current); }, []);
  const sendFromComposer = () => {
    if (!canSend) return;
    setSentPulse(true);
    if (pulseTimer.current) window.clearTimeout(pulseTimer.current);
    pulseTimer.current = window.setTimeout(() => setSentPulse(false), 520);
    void sendMessage();
  };

  const latestResponse = useMemo(() => {
    return [...messages].reverse().find((message) => message.response)?.response;
  }, [messages]);

  const latestMode = latestResponse?.mode || "ready";
  const latestStage = latestResponse?.user_stage || "unknown";

  // 「/」命令：对话、输入和快捷任务；选中后 "/xx" 从输入框里拿掉再执行。快捷任务只填进输入框，Enter 再发。
  const fillComposer = (text: string) => {
    setInput(text);
    window.requestAnimationFrame(() => composerInputRef.current?.focus());
  };
  const slashCommands: SlashAction[] = [
    { id: "new", label: "新对话", description: "清空当前窗格，开一个新对话", group: "对话", hint: "/new", keywords: ["new", "clear", "清空"], icon: <Plus size={15} />, run: () => startNewConversation() },
    { id: "history", label: "历史对话", description: "↑↓ 选择，Enter 打开", group: "对话", hint: "/history", keywords: ["history", "切换", "对话"], icon: <History size={15} />, run: () => { void refreshConversations(); setHistoryOpen(true); } },
    { id: "model", label: "切换模型", description: "服务 › 模型 › 思考强度", group: "输入", hint: "/model", keywords: ["model", "模型", "思考", "强度", "effort"], icon: <Sparkles size={15} />, run: () => setModelMenuOpen(true) },
    { id: "ask", label: "模式 · 询问", description: "每一步写入都先问你", group: "输入", hint: "/ask", keywords: ["mode", "模式"], icon: <Hand size={15} />, run: () => setComposerOptions({ approvalMode: "ask" }) },
    { id: "auto", label: "模式 · 自动", description: "可撤销的直接做，不可撤销的才问你", group: "输入", hint: "/auto", keywords: ["mode", "模式"], icon: <Zap size={15} />, run: () => setComposerOptions({ approvalMode: "auto" }) },
    { id: "skills", label: "Skill Hub", description: "看 OfferU 的技能和沙箱设置", group: "输入", hint: "/skills", keywords: ["skill", "技能", "方法", "hub", "沙箱", "sandbox"], icon: <Library size={15} />, run: () => setSkillHubOpen(true) },
    { id: "readonly", label: "沙箱 · 只读", description: "只查、只给建议，写入一律拦下", group: "输入", hint: "/readonly", keywords: ["sandbox", "沙箱", "只读", "read"], icon: <Lock size={15} />, run: () => setComposerOptions({ sandbox: "read_only" }) },
    { id: "write", label: "沙箱 · 可写", description: "可以改档案、岗位和文档（可撤销）", group: "输入", hint: "/write", keywords: ["sandbox", "沙箱", "可写", "write"], icon: <PenLine size={15} />, run: () => setComposerOptions({ sandbox: "workspace_write" }) },
    { id: "attach", label: "添加附件", description: "图片、PDF 或 PPT", group: "输入", hint: "/attach", keywords: ["file", "image", "附件", "图片", "文件"], icon: <Paperclip size={15} />, run: () => attachmentInputRef.current?.click() },
    ...[...quickActionsForStage(latestStage), ...EMPTY_SUGGESTIONS.map((item) => ({ label: item.label, prompt: item.prompt }))].map((action, index): SlashAction => ({
      id: `quick-${index}`, label: action.label, description: action.prompt, group: "快捷任务", keywords: [action.prompt], icon: <ListTodo size={15} />, run: () => fillComposer(action.prompt),
    })),
  ];
  const slash = useAgentSlash({ input, setInput, inputRef: composerInputRef, commands: slashCommands });


  const quoteIntoComposer = (text: string) => {
    if (!text.trim()) return;
    setQuote(text);
    window.requestAnimationFrame(() => composerInputRef.current?.focus());
  };

  /** 从这条消息分叉：服务端复制前面的消息成新对话（原对话不动），然后打开它接着聊。 */
  const branchFromMessage = async (message: PanelMessage) => {
    if (!conversationId || branching) return;
    setBranching(true);
    setError("");
    try {
      const upto = branchUpto(messages, message.id);
      if (upto < 1) throw new Error("这条消息还没保存，不能分叉");
      const branched = await agentSupportApi.branchConversation(conversationId, {
        upto,
        content: message.content,
        role: message.role,
      });
      await loadConversation(branched.id);
      void refreshConversations();
      window.requestAnimationFrame(() => composerInputRef.current?.focus());
    } catch (err: any) {
      setError(safeClientErrorMessage(err, "分叉失败"));
    } finally {
      setBranching(false);
    }
  };

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
    if (!stickRef.current) return;
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, inFlightTurns]);

  const onThreadScroll = () => {
    const element = scrollRef.current;
    if (!element) return;
    const metrics = { scrollTop: element.scrollTop, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight };
    stickRef.current = nextStickToBottom(stickRef.current, metrics, lastScrollTopRef.current);
    lastScrollTopRef.current = element.scrollTop;
    setAwayFromBottom(isAwayFromBottom(metrics));
  };
  const scrollToLatest = () => {
    stickRef.current = true;
    const element = scrollRef.current;
    if (element) smoothScrollTo(element, element.scrollHeight);
  };
  // 每条用户消息是一轮的起点：刻度条据此定位。
  const turns = useMemo(() => splitConversationTurns(messages.map((item) => ({ id: item.id, role: item.role, text: item.content }))), [messages]);
  const turnIndexById = useMemo(() => turnIndexByMessage(messages.map((item) => ({ id: item.id, role: item.role, text: item.content }))), [messages]);
  // 面板里的导航快捷键：Alt+PageUp / Alt+PageDown 逐轮跳，Alt+End 回到最新。
  const onPanelKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "PageUp" || event.key === "PageDown") {
      event.preventDefault();
      stickRef.current = false;
      timelineRef.current?.step(event.key === "PageUp" ? -1 : 1);
    } else if (event.key === "End") {
      event.preventDefault();
      scrollToLatest();
    }
  };

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

  /** Run 在跑时把一句话交给它（Enter / 发送键 / 托盘里的「插话」）。没送到就放回队首，不丢。 */
  const steerActiveRun = async (content: string) => {
    const runId = activeRunId;
    const conversationAtSteer = conversationId;
    if (!runId) {
      setQueue((current) => enqueueFront(current, content, conversationAtSteer));
      return;
    }
    const messageId = "user-steer-" + Date.now() + "-" + ++turnSeqRef.current;
    setMessages((prev) => [...prev, { id: messageId, role: "user", content, steered: true }]);
    const putBack = () => {
      setMessages((prev) => prev.filter((message) => message.id !== messageId));
      setQueue((current) => enqueueFront(current, content, conversationAtSteer));
    };
    try {
      const result = await agentRuntimeApi.steer(runId, content);
      if (result.disposition !== "steered") putBack();
    } catch (err: any) {
      putBack();
      setError(safeClientErrorMessage(err, "插话没送到，已放回队列"));
    }
  };

  /** Tab：排到这一轮之后。 */
  const queueFromComposer = () => {
    const text = withQuote(input.trim(), quote);
    if (!input.trim()) return;
    setQueue((current) => enqueue(current, text, conversationId));
    setInput("");
    setQuote(null);
  };

  const sendQueued = (id: string) => {
    const item = queue.find((entry) => entry.id === id);
    if (!item) return;
    setQueue((current) => removeQueued(current, id));
    if (busyRef.current) void steerActiveRun(item.text);
    else void startTurn(item.text, [], { fromQueue: true });
  };

  const editQueued = (id: string) => {
    const item = queue.find((entry) => entry.id === id);
    if (!item) return;
    setQueue((current) => removeQueued(current, id));
    setInput((current) => (current.trim() ? current + "\n" + item.text : item.text));
    window.requestAnimationFrame(() => composerInputRef.current?.focus());
  };

  const sendMessage = async (text?: string) => {
    const typed = (text ?? input).trim();
    const fromComposer = text === undefined;
    if (busyRef.current) {
      // 不并发第二个 Run：输入框里的话插进正在跑的这一轮，别处来的（建议胶囊等）排队。
      if (!typed) {
        if (fromComposer && composerAttachments.readyCount > 0) setError("这一轮还在跑：附件等它结束再发，文字可以先插话（Enter）或排队（Tab）。");
        return;
      }
      if (!fromComposer) {
        setQueue((current) => enqueue(current, typed, conversationId));
        return;
      }
      const steered = withQuote(typed, quote);
      setInput("");
      setQuote(null);
      await steerActiveRun(steered);
      return;
    }
    // 附件还在上传时不发，免得模型看不到它们
    if (fromComposer && composerAttachments.uploading) return;
    const withAttachments = fromComposer && composerAttachments.readyCount > 0;
    if (!typed && !withAttachments) return;
    const attachments = withAttachments ? composerAttachments.takeForSend() : [];
    const quoted = fromComposer ? quote : null;
    if (fromComposer) { setInput(""); setQuote(null); }
    await startTurn(withQuote(typed || ATTACHMENT_ONLY_MESSAGE, quoted), attachments);
  };

  const patchTurn = (turnId: string, patch: (turn: InFlightTurn) => InFlightTurn) => {
    setInFlightTurns((current) => current.map((turn) => (turn.id === turnId ? patch(turn) : turn)));
  };

  const startTurn = async (
    content: string,
    attachments: ComposerAttachment[] = [],
    options: { fromQueue?: boolean } = {},
  ) => {
    if (!content) return;
    // 双击 / 连按回车防重：同一段文字 800ms 内只开一轮（队列里的不算重复）。
    const now = Date.now();
    const last = lastSendRef.current;
    if (!options.fromQueue && last && last.content === content && now - last.at < 800) {
      composerAttachments.restore(attachments);
      return;
    }
    lastSendRef.current = { content, at: now };
    parkActiveRun();
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
    // 已经流出的正文 / 思考：Run 中断或失败时用它保留半截回答，完成时挂上思考过程。
    const streamed = { text: "", reasoning: "", reasoningStartedAt: 0, reasoningEndedAt: 0 };
    const deltaBatcher = createFrameBatcher<{ text: string; reasoning: string; at: number }>((items) => {
      if (isDetached()) return;
      const text = items.map((item) => item.text).join("");
      const reasoning = items.map((item) => item.reasoning).join("");
      const firstReasoning = items.find((item) => item.reasoning);
      const firstText = items.find((item) => item.text);
      if (firstReasoning && !streamed.reasoningStartedAt) streamed.reasoningStartedAt = firstReasoning.at;
      if (firstText && streamed.reasoningStartedAt && !streamed.reasoningEndedAt) streamed.reasoningEndedAt = firstText.at;
      const { reasoningStartedAt, reasoningEndedAt } = streamed;
      patchTurn(turnId, (turn) => ({
        ...turn,
        streamingText: turn.streamingText + text,
        reasoningText: (turn.reasoningText || "") + reasoning,
        reasoningStartedAt: reasoningStartedAt || undefined,
        reasoningEndedAt: reasoningEndedAt || undefined,
      }));
    });

    const sentAttachments: SentAttachment[] = attachments.map((item) => ({
      id: item.attachmentId,
      name: item.name,
      kind: item.kind,
    }));
    setMessages((prev) => [
      ...prev,
      { id: "user-" + turnId, role: "user", content, attachments: sentAttachments },
    ]);
    setInFlightTurns((current) => [
      ...current,
      { id: turnId, progressText: "正在发送...", streamingText: "", toolStream: streamState },
    ]);
    setError("");

    const choice = resolveComposerChoice(modelCatalog, composerOptions);
    try {
      const runtimeResponse = await agentRuntimeApi.start(
        {
          message: content,
          conversation_id: currentConversationId,
          llm_config_id: choice.service?.config_id ?? composerOptions.llmConfigId,
          model: choice.modelId,
          reasoning_effort: choice.reasoningEffort,
          approval_mode: composerOptions.approvalMode,
          sandbox: composerOptions.sandbox === "read_only" ? "read_only" : "workspace_write",
          attachments: sentAttachments.map((item) => item.id),
        },
        (event, data) => {
          if (isDetached()) return;
          const delta = event === "assistant.delta" || event === "message.delta"
            ? String(data?.payload?.delta || "")
            : "";
          const reasoningDelta = event === "reasoning.delta" ? String(data?.payload?.delta || "") : "";
          if (delta || reasoningDelta) {
            // 正文 / 思考增量每帧合并一次再更新界面。
            streamed.text += delta;
            streamed.reasoning += reasoningDelta;
            deltaBatcher.push({ text: delta, reasoning: reasoningDelta, at: Date.now() });
            return;
          }
          if (event === "assistant.delta" || event === "message.delta" || event === "reasoning.delta") return;
          deltaBatcher.flush();
          streamState = applyRuntimeToolEvent(streamState, event, data || {});
          const nextStream = streamState;
          const eventRunId = String(data?.run_id || "");
          if (eventRunId) setActiveRunId(eventRunId);
          const progress = progressForEvent(event, data?.payload?.operation);
          const usage = contextUsageFromEvent(data);
          if (usage) setContextUsage(usage);
          patchTurn(turnId, (turn) => ({
            ...turn,
            toolStream: nextStream,
            progressText: progress ?? turn.progressText,
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
      deltaBatcher.flush();
      const response = toPanelResponse(runtimeResponse);
      const thinkingText = streamed.reasoning.trim();
      const assistantMessage: PanelMessage = {
        id: "assistant-" + turnId,
        role: "assistant",
        content: response.assistant_message,
        response,
        thinking: thinkingText
          ? { text: thinkingText, ms: Math.max(0, (streamed.reasoningEndedAt || Date.now()) - (streamed.reasoningStartedAt || Date.now())) }
          : undefined,
      };
      if (response.conversation_id) {
        currentConvRef.current = response.conversation_id;
        setConversationId(response.conversation_id);
        // 新对话第一次保存：排在「新对话」下的消息跟过去。
        if (!currentConversationId) setQueue((current) => rebindConversation(current, null, response.conversation_id!));
      }
      if (response.conversation_title) setConversationTitle(response.conversation_title);
      setActiveRunId(runtimeResponse.run.id);
      setActiveRun(runtimeResponse.run);
      setMessages((prev) => [...prev, assistantMessage]);
      setToolStream(streamState);
      setPendingActionCount(pendingCountOf(runtimeResponse.run));
      refreshConversations();
    } catch (err: any) {
      deltaBatcher.cancel();
      if (isDetached()) return;
      if (err instanceof Error && err.name === "AbortError") return;
      // Run 中断 / 失败：已经流出来的文字留在对话里（本地，标明没写完），不随错误一起消失。
      const partial = partialReplyFrom(streamed.text, err);
      if (partial) setMessages((prev) => [...prev, { id: "assistant-partial-" + turnId, role: "assistant", ...partial }]);
      setError(safeClientErrorMessage(err, "OfferU 请求失败"));
      setInput((current) => current || (content === ATTACHMENT_ONLY_MESSAGE && attachments.length > 0 ? "" : content));
      composerAttachments.restore(attachments);
    } finally {
      deltaBatcher.cancel();
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
        // 同一时间只跑一个 Run：在跑就排队，这一轮结束后自动发。
        if (busyRef.current) setQueue((current) => enqueue(current, request.message, currentConvRef.current));
        else void startTurnRef.current(request.message);
      }
    };
    take();
    window.addEventListener(AGENT_COMPOSE_EVENT, take);
    return () => window.removeEventListener(AGENT_COMPOSE_EVENT, take);
  }, []);

  // 这一轮结束（且不在等用户、没有报错）→ 发队列里下一条本次排的消息。
  useEffect(() => {
    if (loading || runNeedsUser || error) return;
    const next = nextArmed(queue, conversationId);
    if (!next) return;
    setQueue((current) => removeQueued(current, next.id));
    void startTurnRef.current(next.text, [], { fromQueue: true });
  }, [loading, runNeedsUser, error, queue, conversationId]);

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
    setPendingActionCount(0);
    setReviewPending(0);
    setHistoryOpen(false);
    setMessages([
      {
        id: `welcome-${Date.now()}`,
        role: "assistant",
        content: "新对话已开始，直接描述你的求职任务。",
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
          attachments: message.role === "user" ? message.attachments : undefined,
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


  // 提醒和「接下来可以」每轮都会重算，只跟在最新一条回复下面，旧回复不重复贴。
  const guidanceMessageId = messages.reduce<string | undefined>((last, item) => (item.response ? item.id : last), undefined);

  return (
    <div className="offeru-agent-panel flex h-full min-h-0 flex-col" onKeyDown={onPanelKeyDown}>
      <div className="agent-head">
        <span className="agent-head-mark" aria-hidden><Sparkles size={14} strokeWidth={2} /></span>
        <button
          type="button"
          onClick={() => setHistoryOpen((value) => !value)}
          className="agent-head-title"
          title="历史对话"
          aria-expanded={historyOpen}
        >
          <span className="truncate">{conversationTitle || "新对话"}</span>
          <ChevronDown size={13} className={"agent-head-chevron" + (historyOpen ? " is-open" : "")} />
        </button>
        <div className="agent-head-actions">
          <Menu align="end" label="对话操作" items={[
            { label: "新对话", icon: <Plus size={15} />, onSelect: startNewConversation },
            { label: "历史对话", icon: <History size={15} />, onSelect: () => { void refreshConversations(); setHistoryOpen(true); } },
            ...(hostedSessions.length > 0 ? [{ label: "外部执行器会话", icon: <Activity size={15} />, onSelect: () => setHostedOpen((value) => !value) }] : []),
          ]} trigger={
            <button type="button" className="agent-head-button" aria-label="更多" title="更多">
              <MoreHorizontal size={16} strokeWidth={2} />
            </button>
          } />
          {onClose && (
            <button type="button" className="agent-head-button" aria-label="收起 OfferU" title="收起" onClick={onClose}>
              <X size={16} strokeWidth={2} />
            </button>
          )}
        </div>
      </div>

      {historyOpen && (
        <>
        <div className="fixed inset-0 z-20" aria-hidden onClick={() => setHistoryOpen(false)} />
        <AgentHistoryList
          conversations={conversations}
          currentId={conversationId}
          onOpen={(id) => { void loadConversation(id); }}
          onDelete={(id) => { void removeConversation(id); }}
          onNew={startNewConversation}
          onClose={() => { setHistoryOpen(false); composerInputRef.current?.focus(); }}
        />
        </>
      )}

      {resumeCandidate && !conversationId && (
        <div role="status" className="agent-notice px-3 py-2.5">
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
        <section className="agent-notice px-3 py-2.5">
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

                  {HOSTED_ACTIVE_STATUSES.has(hostedDetail.status) && (
                    <div className="mt-2">
                      <AgentWorkingOrb
                        size={20}
                        label={hostedDetail.events.length > 0
                          ? hostedEventLabel(hostedDetail.events[hostedDetail.events.length - 1])
                          : "正在启动外部执行器"}
                      />
                    </div>
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
      <div className="agent-thread-wrap">
      <div ref={scrollRef} onScroll={onThreadScroll} className="agent-thread custom-scrollbar min-h-0 flex-1 overflow-y-auto px-3.5 py-4">
        <div className="space-y-4">
          {messages.map((message) => (
            <PanelMessageBubble key={message.id} message={message} showGuidance={message.id === guidanceMessageId} onSuggestion={sendMessage}
              turnIndex={message.role === "user" ? turnIndexById.get(message.id) : undefined}
              onQuote={quoteIntoComposer}
              onBranch={conversationId && canBranchFrom(message) ? () => { void branchFromMessage(message); } : undefined}
              branchDisabled={branching || inFlightTurns.length > 0}
              alone={messages.length === 1 && inFlightTurns.length === 0} />
          ))}
          {inFlightTurns.map((turn) => (
            <div key={turn.id} id={"agent-turn-" + turn.id} data-testid="agent-inflight-turn" className="space-y-2">
              {turn.reasoningText && turn.reasoningStartedAt && (
                <AgentThinkingBlock text={turn.reasoningText} startedAt={turn.reasoningStartedAt} endedAt={turn.reasoningEndedAt ?? null} />
              )}
              {turn.streamingText && (
                <div className="agent-msg agent-msg-assistant">
                  <AgentMarkdown text={turn.streamingText} streaming />
                </div>
              )}
              <ToolExecutionList executions={turn.toolStream.toolExecutions} />
              <AgentRunPill
                text={turn.progressText}
                steps={Object.keys(turn.toolStream.toolExecutions).length}
                streaming={Boolean(turn.streamingText)}
                toolRunning={Object.values(turn.toolStream.toolExecutions).some((tool) => tool.status === "running")}
              />
            </div>
          ))}
          {inFlightTurns.length === 0 && <ToolExecutionList executions={toolStream.toolExecutions} />}
          {runActionPending && (
            <AgentRunPill text={progressText} />
          )}
        </div>
      </div>
      <AgentTurnTimeline ref={timelineRef} scrollerRef={scrollRef} turns={turns} onJump={() => { stickRef.current = false; }} />
      <AgentScrollToLatest visible={awayFromBottom} onClick={scrollToLatest} />
      <AgentImageViewer />
      <AgentSkillHub open={skillHubOpen} onOpenChange={setSkillHubOpen}
        sandbox={composerOptions.sandbox === "read_only" ? "read_only" : "workspace_write"}
        onSandboxChange={(mode) => setComposerOptions({ sandbox: mode })}
        onTry={fillComposer} />
      </div>

      {interruptedRunId && (
        <div className="agent-notice px-3 py-2.5">
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
        <div className="agent-notice agent-notice-warn px-3 py-2.5">
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
        <div role="alert" className="agent-notice agent-notice-warn space-y-2 px-3 py-3 text-[length:var(--ou-type-xs)]">
          <p className="font-semibold text-[var(--foreground)]">{agentRecovery(error).title}</p>
          <p className="break-words text-[var(--primary-red)]">{error}</p>
          <p className="text-[var(--foreground-muted)]">{agentRecovery(error).hint}</p>
          {agentRecovery(error).configure && <Link href={MODEL_SETTINGS_ROUTE} className="ou-button ou-button-primary ou-button-sm no-underline">配置内置 Agent</Link>}
        </div>
      )}

      {(parkedRuns.length > 0 || inFlightTurns.length > 1) && (
        <div data-testid="agent-task-strip" className="agent-notice px-3 py-2">
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
                  <AgentOrbIcon state={agentOrbState(turn.progressText, { streaming: Boolean(turn.streamingText) })} />
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
      <footer className="agent-foot">
        <AgentQueueTray items={visibleQueue} busy={loading} paused={Boolean(error) || runNeedsUser} onSend={sendQueued} onEdit={editQueued}
          onRemove={(id) => setQueue((current) => removeQueued(current, id))} />
        <div
          ref={composerWidth.ref}
          className={dragActive ? "agent-composer is-drag-active" : "agent-composer"}
          style={composerWidth.width === null ? undefined : { width: composerWidth.width }}
          data-testid="agent-composer"
          data-ou-listbox-anchor=""
          data-mode={composerOptions.approvalMode}
          data-working={working || undefined}
          data-has-input={input ? "" : undefined}
          data-sent={sentPulse || undefined}
          onDragEnter={(event) => {
            if (!hasDraggedFiles(event.dataTransfer.types)) return;
            event.preventDefault();
            dragDepthRef.current += 1;
            setDragActive(true);
          }}
          onDragOver={(event) => {
            if (!hasDraggedFiles(event.dataTransfer.types)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
          }}
          onDragLeave={(event) => {
            if (!hasDraggedFiles(event.dataTransfer.types)) return;
            dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
            if (dragDepthRef.current === 0) setDragActive(false);
          }}
          onDrop={(event) => {
            if (!hasDraggedFiles(event.dataTransfer.types)) return;
            event.preventDefault();
            dragDepthRef.current = 0;
            setDragActive(false);
            composerAttachments.addFiles(event.dataTransfer.files);
          }}
        >
          <ComposerGrip side="left" width={composerWidth.width} onReset={composerWidth.reset}
            onPointerDown={(event) => composerWidth.startDrag("left", event)}
            onKeyDown={(event) => composerWidth.onGripKey("left", event)} />
          <ComposerGrip side="right" width={composerWidth.width} onReset={composerWidth.reset}
            onPointerDown={(event) => composerWidth.startDrag("right", event)}
            onKeyDown={(event) => composerWidth.onGripKey("right", event)} />
          <div className="agent-composer-main">
          <AgentOrb working={working} state={composerOrbState} />
          {quote && <AgentQuoteChip quote={quote} onClear={() => { setQuote(null); composerInputRef.current?.focus(); }} />}
          {!input && !runNeedsUser && !quote && !working && <AnimatedPlaceholder />}
          <Textarea
            value={input}
            onValueChange={setInput}
            minRows={3}
            maxRows={6}
            placeholder={
              working
                ? "Enter 插话，交给正在跑的这一轮 · Tab 排到这一轮之后"
                : runNeedsUser
                  ? "继续对话或说明如何调整；当前待处理的任务会先保存，随时可回来"
                  : ""
            }
            aria-label="问 OfferU"
            variant="flat"
            className="w-full"
            classNames={agentComposerFieldClassNames}
            onPaste={(event) => {
              const files = Array.from(event.clipboardData.files);
              if (files.length === 0) return;
              event.preventDefault();
              composerAttachments.addFiles(files);
            }}
            ref={composerInputRef}
            onSelect={slash.syncCaret}
            onKeyUp={slash.syncCaret}
            onClick={slash.syncCaret}
            onInput={slash.syncCaret}
            onKeyDown={(event) => {
              if (slash.onKeyDown(event)) return;
              if (event.key === "Escape" && quote && !input && !event.nativeEvent.isComposing) {
                event.preventDefault();
                setQuote(null);
                return;
              }
              const intent = composerKeyIntent(
                { key: event.key, shiftKey: event.shiftKey, altKey: event.altKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey, isComposing: event.nativeEvent.isComposing },
                { busy: loading, hasText: Boolean(input.trim()) },
              );
              if (intent === "send" || intent === "steer") {
                event.preventDefault();
                sendFromComposer();
              } else if (intent === "queue") {
                event.preventDefault();
                queueFromComposer();
              }
            }}
          />
          </div>
          <AgentAttachmentTray items={composerAttachments.items} onRemove={composerAttachments.remove}
            onExit={() => composerInputRef.current?.focus()} />
          <AgentSlashMenu slash={slash} anchorRef={composerWidth.ref} />
          {dragActive && <span className="agent-drop-hint" aria-hidden>松开即可添加图片、PDF 或 PPT</span>}
          <div className="agent-composer-controls">
            <input
              ref={attachmentInputRef}
              type="file"
              multiple
              accept={AGENT_ATTACHMENT_ACCEPT}
              className="hidden"
              data-testid="agent-attachment-input"
              onChange={(event) => {
                const files = event.target.files;
                if (files) composerAttachments.addFiles(Array.from(files));
                event.target.value = "";
              }}
            />
            <button
              type="button"
              aria-label="添加图片、PDF 或 PPT"
              title="添加图片、PDF 或 PPT（也可以拖入或粘贴）"
              onClick={() => attachmentInputRef.current?.click()}
              className="agent-composer-attach"
            >
              <Plus size={16} strokeWidth={2} />
              {composerAttachments.items.length > 0 && (
                <span key={composerAttachments.items.length} className="agent-composer-badge">{composerAttachments.items.length}</span>
              )}
            </button>
            <AgentComposerControls options={composerOptions} onChange={setComposerOptions} services={modelCatalog}
              modelOpen={modelMenuOpen} onModelOpenChange={setModelMenuOpen} />
            {contextUsage && (
              <ContextUsageRing used={contextUsage.used} limit={contextUsage.window}
                nearAt={Math.round((contextUsage.compactAt / contextUsage.window) * 100)} />
            )}
            <button
              type="button"
              aria-label={working && !canSend ? "OfferU 正在处理" : working ? "插话（Enter）" : "发送"}
              onClick={() => sendFromComposer()}
              disabled={!canSend}
              data-working={working && !canSend ? "" : undefined}
              className="agent-composer-send"
            >
              {working && !canSend ? (
                <PixelLoader />
              ) : (
                <>
                  <span className="agent-composer-send-label">{working ? "插话" : "发送"}</span>
                  <ArrowUp size={15} strokeWidth={2.2} aria-hidden />
                </>
              )}
            </button>
          </div>
        </div>
      </footer>
    </div>
  );
}

function PanelMessageBubble({
  message,
  showGuidance,
  onSuggestion,
  turnIndex,
  onQuote,
  onBranch,
  branchDisabled,
  alone = false,
}: {
  message: PanelMessage;
  showGuidance: boolean;
  onSuggestion: (prompt: string) => void;
  /** 用户消息是第几轮的开头（刻度条定位用）。 */
  turnIndex?: number;
  /** 引用到输入框：有选中文字且选区在这条消息里就引用选中的部分，否则引用整条。 */
  onQuote?: (text: string) => void;
  /** 从这里分叉（新对话，含这条及之前的消息）；没有已保存的对话时不给。 */
  onBranch?: () => void;
  branchDisabled?: boolean;
  /** 对话里只有这条欢迎语：画成完整的空状态（问候 + 建议胶囊）。 */
  alone?: boolean;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const quoted = message.role === "user" ? splitQuote(message.content) : { body: message.content };
  const isUser = message.role === "user";
  const response = message.response;

  if (!isUser && isWelcomeMessage(message)) {
    return alone ? <AgentEmptyState note={message.content} onSuggestion={onSuggestion} /> : <p className="agent-welcome-note">{message.content}</p>;
  }

  return (
    <div ref={rowRef} className={isUser ? "flex justify-end pl-10" : "flex justify-start"} data-message-row="" data-turn-index={turnIndex}>
      <div className={isUser ? "min-w-0 max-w-full" : "w-full min-w-0"}>
        {isUser && message.attachments && message.attachments.length > 0 && (
          <AgentMessageAttachments attachments={message.attachments} imageUrl={agentRuntimeApi.attachmentUrl} />
        )}
        {!isUser && message.thinking && (
          <AgentThinkingBlock text={message.thinking.text} startedAt={0} endedAt={message.thinking.ms} />
        )}
        {isUser && message.steered && <span className="agent-msg-steer-tag" data-testid="agent-steer-tag">插话</span>}
        <div className={isUser ? "agent-msg agent-msg-user" : "agent-msg agent-msg-assistant"} data-partial={message.partial}>
          {isUser && quoted.quote && <blockquote className="agent-msg-quote">{quotePreview(quoted.quote)}</blockquote>}
          {isUser ? quoted.body : <AgentMarkdown text={message.content} />}
        </div>
        {message.partial && (
          <p className="agent-msg-partial-note" data-testid="agent-partial-note">
            {message.partial === "cancelled" ? "Run 已中断，以上是中断前已经写出的部分。" : "Run 失败，以上是失败前已经写出的部分；可以重试或说「继续」。"}
          </p>
        )}
        {message.content.trim() && (
          <div className="agent-msg-actions" data-align={isUser ? "end" : undefined} role="toolbar" aria-label="消息操作">
            <AgentCopyButton text={message.content} label={isUser ? "复制这条消息" : "复制回答（Markdown）"} />
            <AgentQuoteBranchActions rowRef={rowRef} fallbackText={isUser ? quoted.body : message.content}
              onQuote={onQuote} onBranch={onBranch} branchDisabled={branchDisabled} />
          </div>
        )}
        {response && (
          <div className="mt-2 space-y-2 text-left">
            {showGuidance && response.alerts && response.alerts.length > 0 && <AlertList alerts={response.alerts} />}
            {showGuidance && response.proactive_suggestions && response.proactive_suggestions.length > 0 && (
              <SuggestionList suggestions={response.proactive_suggestions} onSuggestion={onSuggestion} />
            )}
            {response.transferable_skills_summary && (
              <div className="agent-card px-3 py-2 text-[length:var(--agent-fs-sm)] leading-relaxed text-[var(--foreground-soft)]">
                {response.transferable_skills_summary}
              </div>
            )}
            {response.career_paths && response.career_paths.length > 0 && (
              <CareerPathList paths={response.career_paths} />
            )}
            {response.job_cards && response.job_cards.length > 0 && <JobCardList jobs={response.job_cards} />}
            {response.tool_calls && response.tool_calls.length > 0 && <ToolCallList calls={response.tool_calls} />}
            {response.next_steps && response.next_steps.length > 0 && (
              <ul className="space-y-1 pl-1 text-[length:var(--agent-fs-sm)] leading-relaxed text-[var(--foreground-soft)]">
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

/** 5×5 像素格加载：亮着的格子按固定顺序游走，一步一格（steps），不是平滑渐变。 */
const PIXEL_ORDER = [0, 1, 2, 3, 4, 9, 14, 19, 24, 23, 22, 21, 20, 15, 10, 5, 6, 7, 8, 13, 18, 17, 16, 11, 12];
function PixelLoader() {
  return (
    <span className="agent-pixel" aria-hidden>
      {Array.from({ length: 25 }, (_, cell) => <i key={cell} style={{ ["--p" as string]: PIXEL_ORDER.indexOf(cell) }} />)}
    </span>
  );
}

// 空状态：一句问候 + 几颗和 OfferU 主线相关的建议胶囊，点一下就发出去（参考 Inspora「composer mockup」）。
const EMPTY_SUGGESTIONS: Array<{ icon: typeof Sparkles; label: string; prompt: string }> = [
  { icon: PenLine, label: "把字节那段实习写得更量化", prompt: "把我简历里字节跳动那段实习改写得更量化：每条要点都带上数字和结果，先给我看改前改后" },
  { icon: ListTodo, label: "今天有哪些要做的事", prompt: "按截止时间帮我列出今天要做的事，每件说明为什么现在做" },
  { icon: Mail, label: "帮我整理最近的面试邀约", prompt: "帮我整理最近收到的笔试和面试邀约：时间、岗位、要准备什么，并把还没记的加进日程" },
  { icon: Briefcase, label: "我收藏的岗位先投哪个", prompt: "对比我收藏但还没投的岗位，按匹配度排个先后，说明理由" },
];

function AgentEmptyState({ note, onSuggestion }: { note: string; onSuggestion: (prompt: string) => void }) {
  return (
    <div className="agent-empty" data-testid="agent-empty">
      <span className="agent-empty-mark" aria-hidden><Sparkles size={18} strokeWidth={1.9} /></span>
      <p className="agent-empty-title">今天想让 OfferU 帮你做什么？</p>
      <p className="agent-empty-note">{note}</p>
      <div className="agent-empty-chips" role="list" aria-label="试试这些">
        {EMPTY_SUGGESTIONS.map(({ icon: Icon, label, prompt }, i) => (
          <button key={label} type="button" role="listitem" className="agent-chip ou-enter" style={{ ["--i" as string]: i }} onClick={() => onSuggestion(prompt)}>
            <Icon size={14} strokeWidth={1.9} aria-hidden />
            <span className="truncate">{label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function AlertList({ alerts }: { alerts: NonNullable<AgentResponse["alerts"]> }) {
  return (
    <div className="space-y-2.5">
      {alerts.map((alert) => (
        <div key={alert.code} className="agent-card agent-card-alert pl-2.5 text-[length:var(--agent-fs-sm)] leading-relaxed">
          <p className="flex items-center gap-1.5 font-medium text-[var(--foreground)]">
            <AlertTriangle size={12} className="shrink-0 text-[var(--primary-red)]" />
            {alert.title}
          </p>
          <p className="text-[var(--foreground-soft)]">{alert.message}</p>
          {alert.action && <p className="text-[var(--foreground)]">→ {alert.action}</p>}
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
    <div className="pt-1">
      <p className="px-[0.6em] pb-0.5 text-[length:var(--agent-fs-xs)] text-[var(--foreground-muted)]">接下来可以</p>
      {suggestions.map((suggestion) => (
        <button
          key={suggestion.title + "-" + suggestion.prompt}
          type="button"
          onClick={() => onSuggestion(suggestion.prompt)}
          className="agent-suggestion"
        >
          <span className="text-[length:var(--agent-fs-sm)] font-medium text-[var(--foreground)]">{suggestion.title}</span>
          <span className="text-[length:var(--agent-fs-xs)] leading-normal text-[var(--foreground-muted)]">{suggestion.description}</span>
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

/**
 * 运行中：一个胶囊 = Thinking Orbs 点阵球（按阶段换形态）+ 静态的一行步骤 + 已用时间 / 步数。
 * 参考 Inspora 5-8 · Jakub Antalik「Thinking orbs」；胶囊与换场见 AgentWorkingOrb。
 */
function AgentRunPill({ text, steps = 0, streaming, toolRunning }: { text: string; steps?: number; streaming?: boolean; toolRunning?: boolean }) {
  const [startedAt] = useState(() => Date.now());
  const [now, setNow] = useState(startedAt);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  return (
    <AgentWorkingOrb
      testId="agent-run-pill"
      label={text}
      context={{ streaming, toolRunning }}
      meta={<>{steps > 0 && <span className="ou-orb-meta-extra">{steps} 步 · </span>}{seconds}s</>}
    />
  );
}

function ToolCallList({ calls }: { calls: AgentResponse["tool_calls"] }) {
  return (
    <details className="ou-activity">
      <summary>
        <ChevronRight size={12} className="ou-chevron" aria-hidden />
        已处理 · {calls.length} 次工具调用
      </summary>
      <ToolCallRows calls={calls} />
    </details>
  );
}

function ToolCallRows({ calls }: { calls: AgentResponse["tool_calls"] }) {
  return (
    <div className="agent-tool-group" role="list" aria-label="本轮工具调用">
      {calls.map((call, index) => {
        const presentation = presentAgentToolCall(call);
        // 结果是给模型看的：出错时画错误卡片 / 一句话，成功时只留人话摘要，不再露 JSON 原文。
        const failed = isToolFailure(call.result);
        return (
          <details key={call.tool + "-" + index} role="listitem" className="group ou-enter" data-status={failed ? "error" : undefined} open={failed || undefined} style={{ ["--i" as string]: index }}>
            <summary className="agent-tool-row cursor-pointer list-none">
              <span className="agent-tool-node" aria-hidden>
                <Wrench size={9} strokeWidth={2} />
              </span>
              <span className="shrink-0 font-mono text-[11px] text-[var(--foreground)]">{call.tool}</span>
              {presentation && (
                <span className="min-w-0 flex-1 truncate text-[var(--foreground-muted)]">{presentation}</span>
              )}
              <span className="agent-tool-index" aria-label={`第 ${index + 1} 步，共 ${calls.length} 步`}>
                {index + 1}/{calls.length}
              </span>
              <ChevronDown size={11} className="ml-auto shrink-0 text-[var(--foreground-muted)] transition-transform duration-[var(--dur-quick)] group-open:rotate-180" />
            </summary>
            <div className="agent-tool-detail space-y-1">
              {presentation && (
                <p className="text-[11.5px] leading-5 text-[var(--foreground-soft)]">{presentation}</p>
              )}
              {failed ? (
                <AgentToolError result={call.result} />
              ) : (
                !presentation && <p className="text-[length:var(--agent-fs-xs)] leading-5 text-[var(--foreground-muted)]">已完成</p>
              )}
            </div>
          </details>
        );
      })}
    </div>
  );
}
