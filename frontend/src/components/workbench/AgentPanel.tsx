"use client";

// =============================================
// OfferU 主 Agent 面板 — Python Run Host → Pi SDK Worker
// 对话仍是交互记录；任务、Run、事件、提案、确认和审计由后端控制。
// =============================================

import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Textarea } from "@nextui-org/react";
import {
  Activity,
  AlertTriangle,
  Briefcase,
  CheckCircle2,
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
  piAgentApi,
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
  type PiAgentRunResponse,
} from "@/lib/api";
import { presentAgentToolCall } from "@/lib/agentToolPresentation";
import { bauhausFieldClassNames } from "@/lib/bauhaus";

interface PanelMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  response?: AgentResponse;
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

function toPanelResponse(response: PiAgentRunResponse): AgentResponse {
  const guardian = response.guardian || {};
  return {
    assistant_message: response.assistant_message,
    mode: response.run.mode,
    active_skill: response.active_skill,
    requires_confirmation: response.pending_actions.length > 0,
    tool_calls: [],
    proposed_actions: response.pending_actions,
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
  return (run.steps || [])
    .filter((step) => step.status === "waiting_confirmation")
    .map((step) => ({
      id: step.id,
      tool: step.tool,
      summary: step.summary,
      risk_level: step.risk_level,
      requires_confirmation: step.requires_confirmation,
      args: step.args,
    }));
}

export function AgentPanel() {
  const [messages, setMessages] = useState<PanelMessage[]>([
    {
      id: "welcome",
      role: "assistant",
      content:
        "我是 OfferU 内置 Agent。每次任务都会创建可审计 Run；读取直接执行，写入会先请你确认。",
    },
  ]);
  const [input, setInput] = useState("");
  const [pendingActions, setPendingActions] = useState<AgentProposedAction[]>([]);
  const [loading, setLoading] = useState(false);
  const [progressText, setProgressText] = useState("正在连接 Python AgentKernel...");
  const [streamingText, setStreamingText] = useState("");
  const [error, setError] = useState("");
  const [importedStage, setImportedStage] = useState<string>("unknown");
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [conversationTitle, setConversationTitle] = useState("新对话");
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [interruptedRunId, setInterruptedRunId] = useState<string | null>(null);
  const [activeSkillId, setActiveSkillId] = useState("discovery");
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

  const hasPendingActions = pendingActions.length > 0;

  const latestResponse = useMemo(() => {
    return [...messages].reverse().find((message) => message.response)?.response;
  }, [messages]);

  const latestMode = latestResponse?.active_skill?.name || latestResponse?.mode || "ready";
  const latestStage = latestResponse?.user_stage || importedStage || "unknown";

  const refreshConversations = async () => {
    try {
      const result = await agentSupportApi.conversations();
      setConversations(result.conversations || []);
    } catch {
      setConversations([]);
    }
  };

  useEffect(() => {
    refreshConversations();
    piAgentApi
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
        if (!stopped) setHostedError(err.message || "读取托管会话失败");
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

  const sendMessage = async (text?: string, skillId?: string) => {
    const content = (text ?? input).trim();
    if (!content || loading || hasPendingActions || interruptedRunId) return;
    const selectedSkillId = skillId || activeSkillId;
    const userMessage: PanelMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      content,
    };
    const nextMessages = [...messages, userMessage];

    setMessages(nextMessages);
    setInput("");
    setLoading(true);
    setProgressText("正在创建任务 Run 并启动 Pi Session...");
    setStreamingText("");
    setError("");

    try {
      const runtimeResponse = await piAgentApi.start(
        {
          message: content,
          skill_id: selectedSkillId,
          conversation_id: conversationId,
        },
        (event, data) => {
          const eventRunId = String(data?.run_id || "");
          if (eventRunId) setActiveRunId(eventRunId);
          if (event === "run.created") {
            setProgressText("Run 已持久化，正在启动 Pi Session...");
          } else if (event === "runtime.session_started") {
            setProgressText("Pi Session 已就绪，正在执行当前 Skill...");
          } else if (event === "runtime.tool_started") {
            setProgressText("Pi 正在调用 OfferU Operation...");
          } else if (event === "operation.started") {
            setProgressText(`正在读取：${data?.payload?.operation || "OfferU 数据"}`);
          } else if (event === "operation.proposed") {
            setProgressText("写操作已形成提案，等待本轮回答完成...");
          } else if (event === "runtime.retry_started") {
            setProgressText("模型调用正在安全重试...");
          } else if (event === "runtime.compaction_started") {
            setProgressText("正在压缩本 Run 的模型上下文...");
          } else if (event === "stream.reconnecting") {
            setProgressText("连接中断，正在按事件游标恢复同一个 Run...");
          } else if (event === "message.delta") {
            const delta = String(data?.payload?.delta || "");
            if (delta) setStreamingText((current) => current + delta);
          }
        }
      );
      if (!runtimeResponse.ok) {
        throw new Error(runtimeResponse.errors?.join("；") || "Pi Agent Run 执行失败");
      }
      const response = toPanelResponse(runtimeResponse);
      const assistantMessage: PanelMessage = {
        id: `assistant-${Date.now()}`,
        role: "assistant",
        content: response.assistant_message,
        response,
      };
      if (response.conversation_id) setConversationId(response.conversation_id);
      if (response.conversation_title) setConversationTitle(response.conversation_title);
      setActiveRunId(runtimeResponse.run.id);
      setActiveSkillId(runtimeResponse.active_skill.id);
      setMessages((prev) => [...prev, assistantMessage]);
      setPendingActions(response.proposed_actions || []);
      refreshConversations();
    } catch (err: any) {
      setError(err.message || "OfferU 请求失败");
    } finally {
      setStreamingText("");
      setLoading(false);
    }
  };

  const startNewConversation = async () => {
    if (activeRunId && (hasPendingActions || interruptedRunId)) {
      try {
        await piAgentApi.abort(activeRunId);
      } catch {
        // 新对话仍可开始；后端会让残留 Worker 冲突显式失败。
      }
    }
    setConversationId(null);
    setConversationTitle("新对话");
    setActiveRunId(null);
    setInterruptedRunId(null);
    setActiveSkillId("discovery");
    setPendingActions([]);
    setHistoryOpen(false);
    setMessages([
      {
        id: `welcome-${Date.now()}`,
        role: "assistant",
        content: "新对话已开始。选择上方技能，或直接描述你要推进的求职任务。",
      },
    ]);
  };

  const loadConversation = async (id: string) => {
    setError("");
    try {
      if (activeRunId && (hasPendingActions || interruptedRunId)) {
        await piAgentApi.abort(activeRunId);
      }
      const conversation = await agentSupportApi.conversation(id);
      setConversationId(conversation.id);
      setConversationTitle(conversation.title || "历史对话");
      setActiveRunId(null);
      setInterruptedRunId(null);
      setActiveSkillId("discovery");
      setPendingActions([]);
      setHistoryOpen(false);
      setMessages(
        (conversation.messages || []).map((message, index) => ({
          id: `${conversation.id}-${index}`,
          role: message.role,
          content: message.content,
        }))
      );
      const runResult = await piAgentApi.runs({
        conversation_id: conversation.id,
        limit: 1,
      });
      const latestRun = runResult.runs[0];
      if (latestRun?.status === "waiting_confirmation") {
        setActiveRunId(latestRun.id);
        setActiveSkillId(latestRun.skill_id || "discovery");
        setPendingActions(pendingActionsFromRun(latestRun));
      } else if (latestRun?.status === "interrupted") {
        setActiveRunId(latestRun.id);
        setInterruptedRunId(latestRun.id);
        setActiveSkillId(latestRun.skill_id || "discovery");
      }
    } catch (err: any) {
      setError(err.message || "加载历史对话失败");
    }
  };

  useEffect(() => {
    if (conversationId || conversations.length === 0) return;
    let cancelled = false;
    const restoreLatestActiveRun = async () => {
      const latestConversation = conversations[0];
      try {
        const result = await piAgentApi.runs({
          conversation_id: latestConversation.id,
          limit: 1,
        });
        const status = result.runs[0]?.status;
        if (
          !cancelled
          && (status === "waiting_confirmation" || status === "interrupted")
        ) {
          await loadConversation(latestConversation.id);
        }
      } catch {
        // 没有可恢复 Run 时保留新对话欢迎页。
      }
    };
    void restoreLatestActiveRun();
    return () => {
      cancelled = true;
    };
  }, [conversationId, conversations]);

  const removeConversation = async (id: string) => {
    setError("");
    try {
      await agentSupportApi.deleteConversation(id);
      if (conversationId === id) await startNewConversation();
      await refreshConversations();
    } catch (err: any) {
      setError(err.message || "删除历史对话失败");
    }
  };

  const confirmPendingActions = async () => {
    if (!activeRunId || pendingActions.length === 0 || loading) return;
    setLoading(true);
    setProgressText("正在通过 Registry 执行已确认动作...");
    setError("");
    try {
      let finalRun: AgentRunRecord | null = null;
      const toolCalls: AgentToolCall[] = [];
      for (const action of pendingActions) {
        const result = await piAgentApi.confirm(activeRunId, action.id);
        finalRun = result.run;
        toolCalls.push(...(result.tool_calls || []));
        if (result.errors?.length) {
          throw new Error(result.errors.join("；"));
        }
      }
      if (!finalRun) throw new Error("确认结果缺少 Agent Run");
      const remaining = pendingActionsFromRun(finalRun);
      const response: AgentResponse = {
        assistant_message:
          remaining.length > 0
            ? `已执行确认动作，仍有 ${remaining.length} 个动作等待确认。`
            : "已通过 OfferU Operation Registry 执行确认动作，并完成审计。",
        mode: finalRun.mode,
        active_skill: latestResponse?.active_skill,
        requires_confirmation: remaining.length > 0,
        tool_calls: toolCalls,
        proposed_actions: remaining,
      };
      setMessages((prev) => [
        ...prev,
        {
          id: `assistant-confirm-${Date.now()}`,
          role: "assistant",
          content: response.assistant_message,
          response,
        },
      ]);
      setPendingActions(remaining);
      if (remaining.length === 0) setActiveRunId(null);
    } catch (err: any) {
      setError(err.message || "确认动作失败");
    } finally {
      setLoading(false);
    }
  };

  const abortPendingRun = async () => {
    if (!activeRunId || loading) return;
    setLoading(true);
    setProgressText("正在取消当前 Run...");
    setError("");
    try {
      await piAgentApi.abort(activeRunId);
      setActiveRunId(null);
      setInterruptedRunId(null);
      setPendingActions([]);
      setMessages((prev) => [
        ...prev,
        {
          id: `assistant-abort-${Date.now()}`,
          role: "assistant",
          content: "已取消当前 Run，未执行待确认写操作。",
        },
      ]);
    } catch (err: any) {
      setError(err.message || "取消 Run 失败");
    } finally {
      setLoading(false);
    }
  };

  const resumeInterruptedRun = async () => {
    if (!interruptedRunId || loading) return;
    setLoading(true);
    setProgressText("正在从持久化 Pi Session 恢复 Run...");
    setError("");
    try {
      const runtimeResponse = await piAgentApi.resume(interruptedRunId);
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
      setInterruptedRunId(null);
      if (response.conversation_title) {
        setConversationTitle(response.conversation_title);
      }
      refreshConversations();
    } catch (err: any) {
      setError(err.message || "恢复 Run 失败");
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
      setHostedError(err.message || "读取托管会话失败");
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
      setHostedError(err.message || `${action === "cancel" ? "取消" : "恢复"}托管任务失败`);
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
      setError(err.message || "导出记忆失败");
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
      setError(err.message || "导入记忆失败");
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
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
          <span className="bauhaus-chip !py-0.5 !text-[10.5px]">Pi</span>
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
              还没有托管任务。确认“岗位公开调研”后，Codex 或 Claude 的会话、授权范围和事件会显示在这里。
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
                      {session.executor_id === "claude" ? "Claude" : "Codex"} · {HOSTED_STATUS_LABELS[session.status] || session.status}
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
          value={activeSkillId}
          disabled={loading || hasPendingActions || Boolean(interruptedRunId)}
          onChange={(event) => setActiveSkillId(event.target.value)}
          className="min-w-0 flex-1 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-[11.5px] text-[var(--foreground)] outline-none disabled:opacity-50"
        >
          {skills.length === 0 && <option value="discovery">技能中心</option>}
          {skills.map((skill) => (
            <option key={skill.id} value={skill.id}>
              {skill.name}{skill.status === "partial" ? "（部分能力）" : ""}
            </option>
          ))}
        </select>
        <div className="basis-full" />
        {QUICK_ACTIONS.map((action) => (
          <button
            key={action.label}
            type="button"
            disabled={loading || hasPendingActions || Boolean(interruptedRunId)}
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
            title="导入 Codex / Claude Code / 本地 Markdown 或 JSON 记忆"
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
            OfferU 不会自动重放工具。你可以从已持久化的 Pi Session 显式恢复，或取消本次 Run。
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

      {hasPendingActions && (
        <div className="border-t border-[var(--border)] bg-[var(--status-blush)] px-3 py-2.5">
          <p className="text-[12px] font-semibold text-[var(--foreground)]">需要确认的动作</p>
          <div className="mt-1.5 space-y-1.5">
            {pendingActions.map((action) => (
              <div
                key={action.id}
                className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-[12px] text-[var(--foreground)]"
              >
                {action.summary}
              </div>
            ))}
          </div>
          <Button
            onPress={confirmPendingActions}
            isDisabled={loading}
            startContent={loading ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}
            className="bauhaus-button bauhaus-button-red mt-2 !min-h-8 !w-full !justify-center !py-1 !text-[12px]"
          >
            确认执行
          </Button>
          <Button
            onPress={abortPendingRun}
            isDisabled={loading}
            className="bauhaus-button bauhaus-button-outline mt-1.5 !min-h-8 !w-full !justify-center !py-1 !text-[12px]"
          >
            取消本次 Run
          </Button>
        </div>
      )}

      {error && (
        <div className="border-t border-[var(--border)] bg-[var(--status-blush)] px-3 py-1.5 text-[12px] font-medium text-[var(--primary-red)]">
          {error}
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
              hasPendingActions || interruptedRunId
                ? "请先处理当前 Run"
                : "问 OfferU，或说你要推进哪一步..."
            }
            variant="bordered"
            className="flex-1"
            classNames={bauhausFieldClassNames}
            isDisabled={loading || hasPendingActions || Boolean(interruptedRunId)}
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
            isDisabled={!input.trim() || loading || hasPendingActions || Boolean(interruptedRunId)}
            className="bauhaus-button bauhaus-button-outline !min-h-9 !min-w-9 !px-0 !py-0"
          >
            {loading ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
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
                <a
                  href={job.apply_url}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1 inline-block text-[12px] font-medium text-[var(--primary-blue)] underline"
                >
                  打开投递链接
                </a>
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
