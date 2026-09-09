"use client";

import { useState } from "react";
import { Button, Modal, ModalBody, ModalContent, ModalHeader } from "@nextui-org/react";
import {
  AlertCircle, ArrowRight, Check, CheckCircle2, ChevronDown, Circle,
  Copy, ExternalLink, Laptop, Loader2, Plug, RefreshCw, Waypoints,
} from "lucide-react";
import { type AgentConnection } from "@/lib/api";
import { connectionTime, useAgentConnection } from "@/lib/agentConnection";
import { SHOWCASE } from "@/lib/showcase/router";

const STATUS = {
  missing: { label: "未检测到", tone: "text-[var(--foreground-muted)]", title: "先准备好本机 Agent", detail: "打开官方指南完成安装，然后回到这里重新检查。" },
  incompatible: { label: "需要修复", tone: "text-amber-700", title: "已找到程序，还需要修复连接", detail: "当前版本或运行组件未通过检查。按官方指南更新后重试。" },
  check_required: { label: "待检查", tone: "text-[var(--foreground-muted)]", title: "检查一下，就知道能否接入", detail: "OfferU 会检查本机程序和连接能力。已有的登录由你的 Agent 继续管理。" },
  ready: { label: "检查通过", tone: "text-emerald-700", title: "准备好了，把工作交给你的 Agent", detail: "本机连接与登录检查已通过。复制下面的接入指令，发给你的 Agent，核对它实际读到的内容。" },
  auth_required: { label: "等待登录", tone: "text-amber-700", title: "还差一步：登录你的 Agent", detail: "请在 Agent 自己的界面完成登录，再回来检查。可以沿用已有订阅。" },
  blocked: { label: "需要处理", tone: "text-red-700", title: "上次任务遇到了连接问题", detail: "查看下面的原因，在 Agent 中完成修复后重试原任务。本机检查通过后，任务仍需验证服务商响应。" },
  failed: { label: "检查失败", tone: "text-red-700", title: "这次没有连上，可以重试", detail: "确认本机 Agent 能正常启动，再重新检查。" },
};

const CAPABILITY_LABELS: Array<[keyof AgentConnection, string]> = [
  ["live_model_state", "真实模型"],
  ["structured_output_state", "结构化输出"],
  ["streaming_state", "流式"],
  ["resume_state", "继续"],
  ["cancel_state", "取消"],
  ["web_search_state", "网页搜索"],
];

const CAPABILITY_STATE_LABEL: Record<string, string> = {
  SUPPORTED: "已声明",
  VERIFIED: "已验证",
  UNSUPPORTED: "不支持",
  NOT_VERIFIED: "未验证",
  BLOCKED_AUTH: "认证阻塞",
  UNAVAILABLE: "不可用",
  ERROR: "检查失败",
};

function capabilityState(value: unknown) {
  const state = String(value || "NOT_VERIFIED");
  return {
    state,
    label: CAPABILITY_STATE_LABEL[state] || "未验证",
    tone: state === "VERIFIED" ? "text-emerald-700" : state === "SUPPORTED" ? "text-blue-700" : state === "ERROR" || state === "BLOCKED_AUTH" ? "text-red-700" : "text-[var(--foreground-muted)]",
  };
}

function currentStatus(item: AgentConnection) {
  if (item.status === "ready" && (!item.checked_at || Date.now() - Date.parse(item.checked_at) > 120000)) {
    return STATUS.check_required;
  }
  return STATUS[item.status] || STATUS.check_required;
}

export function AgentConnectionStatus({ compact = false }: { compact?: boolean }) {
  const state = useAgentConnection();
  const ready = state.snapshot?.items.find((item) => currentStatus(item) === STATUS.ready);
  const hasProblem = Boolean(state.error || state.stale || state.sync.status === "failed");
  const pending = Boolean(state.loading || state.probing || state.sync.status === "syncing");
  const label = SHOWCASE ? "Agent · 展示模式" : hasProblem ? "Agent · 需要处理"
    : pending ? "Agent · 正在检查 / 同步" : ready ? "Agent · 接入检查通过" : "连接本机 Agent";
  const detail = state.sync.status === "failed" ? "内容同步失败，点击重试"
    : state.error || state.stale ? "状态未更新，点击查看"
    : ready ? `最近同步 ${connectionTime(state.sync.confirmedAt)}` : "自动检测 · 沿用已有登录";

  return (
    <button type="button" onClick={() => state.setOpen(true)} aria-label={`${label}，查看接入与同步状态`}
      data-testid="agent-connection-status"
      className={`group flex min-h-10 items-center gap-2.5 rounded-xl border border-[var(--border)] bg-[var(--surface)] text-left text-[var(--foreground)] transition-colors hover:border-[var(--border-strong)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ${compact ? "px-3 py-2" : "w-full px-3 py-3"}`}>
      {pending && !hasProblem ? <Loader2 size={16} className="shrink-0 motion-safe:animate-spin" />
        : <span className={`h-2 w-2 shrink-0 rounded-full ${hasProblem ? "bg-amber-500" : ready ? "bg-emerald-600" : "bg-[var(--foreground-faint)]"}`} />}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-semibold">{label}</span>
        {!compact && <span className="mt-1 block truncate text-[10.5px] text-[var(--foreground-muted)]">{detail}</span>}
      </span>
      <ArrowRight size={13} className="shrink-0 text-[var(--foreground-muted)]" />
    </button>
  );
}

function SetupStep({ index, title, done, busy, detail }: {
  index: number; title: string; done: boolean; busy?: boolean; detail: string;
}) {
  return (
    <li className="flex items-start gap-3">
      <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${done ? "bg-emerald-50 text-emerald-700" : "bg-[var(--surface-muted)] text-[var(--foreground-muted)]"}`}>
        {done ? <Check size={14} /> : busy ? <Loader2 size={14} className="motion-safe:animate-spin" /> : index}
      </span>
      <span className="min-w-0 pt-0.5">
        <span className="block text-[13px] font-semibold">{title}</span>
        <span className="mt-1 block text-xs leading-relaxed text-[var(--foreground-muted)]">{detail}</span>
      </span>
    </li>
  );
}

export function AgentConnectionPanel({ embedded = false }: { embedded?: boolean }) {
  const state = useAgentConnection();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState("");
  const candidates = state.snapshot?.items || [];
  const suggested = candidates.find((item) => item.id === "codex" && item.installed)
    || candidates.find((item) => item.compatible) || candidates[0];
  const selected = candidates.find((item) => item.id === selectedId) || suggested;
  const presentation = selected ? currentStatus(selected) : STATUS.check_required;
  const ready = presentation === STATUS.ready;
  const localReady = Boolean(selected?.connection_verified && selected.checked_at && Date.now() - Date.parse(selected.checked_at) <= 120000);
  const checking = Boolean(selected && state.probing === selected.id);
  const visible = showAll ? candidates : candidates.filter((item) => ["codex", "claude", "gemini", "opencode"].includes(item.id) || item.installed);
  const syncFailed = state.sync.status === "failed";
  const syncDone = state.sync.status === "synced";

  const copyPrompt = async () => {
    setCopyError("");
    try {
      await navigator.clipboard.writeText(state.snapshot?.connect_prompt || "");
      setCopied(true);
    } catch {
      setCopyError("未能复制。展开下方接入指令，手动复制后发给你的 Agent。");
    }
  };

  return (
    <section id={embedded ? undefined : "agent-connection"} data-testid={embedded ? "agent-provider-health-dialog" : "agent-provider-health"}
      className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] text-[var(--foreground)]">
      <div className="border-b border-[var(--border)] px-5 py-6 sm:px-7">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="inline-flex items-center gap-2 text-[11px] font-semibold tracking-wide text-[var(--foreground-muted)]"><Plug size={14} /> 本机 Agent</span>
          <span className="inline-flex items-center gap-1.5 text-[11px] text-[var(--foreground-muted)]"><Laptop size={13} /> 沿用本机配置</span>
        </div>
        <h3 className="mt-4 text-xl font-semibold tracking-tight sm:text-2xl">让熟悉的 Agent，接着帮你求职。</h3>
        <p className="mt-2 max-w-xl text-sm leading-relaxed text-[var(--foreground-muted)]">自动发现本机 Agent，检查接入，把当前工作交给它。同步进展随时可看。</p>
      </div>

      {SHOWCASE ? <p role="status" className="p-6 text-sm text-[var(--foreground-muted)]">这是展示模式。请在本机 OfferU 中连接 Agent，查看真实同步状态。</p> : <>
        {(state.error || state.stale) && <div role="alert" className="mx-5 mt-5 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs leading-relaxed text-amber-900">
          <AlertCircle size={15} className="mt-0.5 shrink-0" />
          <span className="flex-1">{state.error || "状态暂未更新，下面保留的是上次结果。"}</span>
          <button type="button" onClick={state.refresh} className="shrink-0 font-semibold underline underline-offset-2">重试</button>
        </div>}
        <div className="grid md:grid-cols-[210px_minmax(0,1fr)]">
          <div className="border-b border-[var(--border)] p-5 md:border-b-0 md:border-r">
            <div className="mb-3 flex items-center justify-between">
              <p className="text-xs font-semibold">检查哪个 Agent</p>
              <button type="button" onClick={state.refresh} disabled={state.refreshing || Boolean(state.probing)} aria-label="重新检测本机 Agent"
                className="rounded-md p-2 text-[var(--foreground-muted)] hover:bg-[var(--surface-muted)] disabled:opacity-50">
                <RefreshCw size={13} className={state.refreshing ? "motion-safe:animate-spin" : ""} />
              </button>
            </div>
            {state.loading && <div role="status" className="flex items-center gap-2 py-6 text-xs text-[var(--foreground-muted)]"><Loader2 size={15} className="motion-safe:animate-spin" /> 正在发现本机 Agent…</div>}
            {!state.loading && !candidates.length && <p className="py-3 text-xs leading-relaxed text-[var(--foreground-muted)]">{state.error ? "连接工作台后，即可发现本机 Agent。" : "尚未取得检测结果，请重新检测。"}</p>}
            <div className="grid grid-cols-2 gap-2 md:grid-cols-1" role="group" aria-label="本机 Agent 列表">
              {visible.map((item) => <button type="button" key={item.id} aria-pressed={selected?.id === item.id}
                onClick={() => { setSelectedId(item.id); setCopied(false); setCopyError(""); }}
                className={`flex min-w-0 items-center gap-2.5 rounded-xl border px-3 py-3 text-left transition-colors focus-visible:outline focus-visible:outline-2 ${selected?.id === item.id ? "border-[var(--foreground)] bg-[var(--surface-muted)]" : "border-transparent hover:bg-[var(--surface-muted)]"}`}>
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs font-bold">{item.id === "codex" ? ">_" : item.name.slice(0, 1)}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-semibold">{item.name.replace(" App Server", "").replace(" Agent SDK", " SDK").replace(" CLI", "")}</span>
                  <span className={`mt-1 block text-[10.5px] ${currentStatus(item).tone}`}>{state.probing === item.id ? "正在检查…" : currentStatus(item).label}</span>
                </span>
              </button>)}
            </div>
            {candidates.length > visible.length && <button type="button" onClick={() => setShowAll(true)} className="mt-3 flex items-center gap-1 py-2 text-xs text-[var(--foreground-muted)]">更多 Agent <ChevronDown size={12} /></button>}
            <p className="mt-4 text-[10.5px] leading-relaxed text-[var(--foreground-muted)]">检测到 {candidates.filter((item) => item.installed).length} 个本机运行环境。连接能力以检查结果为准。</p>
          </div>

          <div className="min-w-0 p-5 sm:p-7">
            {selected ? <>
              <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${presentation.tone}`}>
                {checking ? <Loader2 size={14} className="motion-safe:animate-spin" /> : ready ? <CheckCircle2 size={14} /> : <Circle size={9} />}
                {checking ? "正在检查本机连接…" : presentation.label}
              </span>
              <h4 className="mt-3 text-lg font-semibold tracking-tight">{checking ? "正在确认连接与登录状态" : presentation.title}</h4>
              <p className="mt-2 text-xs leading-6 text-[var(--foreground-muted)]">{presentation.detail}</p>
              {selected.last_error && <div role="alert" className="mt-3 break-words rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs leading-relaxed text-amber-900">{selected.last_error}</div>}
              <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-3" aria-label="本机 Agent 能力验证状态">
                {CAPABILITY_LABELS.map(([key, label]) => {
                  const state = capabilityState(selected[key]);
                  return <div key={String(key)} className="min-w-0 rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2">
                    <span className="block truncate text-[10px] text-[var(--foreground-muted)]">{label}</span>
                    <span className={`mt-1 block truncate text-[11px] font-semibold ${state.tone}`} title={state.state}>{state.label}</span>
                  </div>;
                })}
              </div>
              <ol className="my-6 space-y-5" aria-label="接入步骤">
                <SetupStep index={1} title="找到本机 Agent" done={selected.installed} detail={selected.installed ? selected.version || "已发现本机运行环境" : "安装后，OfferU 会自动发现它。"} />
                <SetupStep index={2} title="检查连接与登录" done={localReady} busy={checking}
                  detail={localReady ? `本机检查通过 · ${connectionTime(selected.checked_at)}` : selected.can_verify_login ? "点击下方按钮检查，通常只需几秒。" : "可检查本机组件；该 Agent 的登录仍需在其原生界面确认。"} />
                <SetupStep index={3} title="同步当前工作" done={syncDone} busy={state.sync.status === "syncing"}
                  detail={syncDone ? `工作台已收到「${state.sync.title}」，Agent 可按需读取。` : syncFailed ? "同步遇到问题，可在下方重试。" : "自动同步当前页面和显式选中的内容。"} />
              </ol>
              <div className="flex flex-wrap items-center gap-2">
                {(localReady || (selected.compatible && !selected.can_verify_login)) && state.snapshot?.connect_prompt ? <Button size="sm" onPress={() => void copyPrompt()} startContent={copied ? <Check size={14} /> : <Copy size={14} />}
                  className="bg-[var(--foreground)] px-4 text-xs font-semibold text-[var(--surface)]">{copied ? "已复制，发给你的 Agent" : localReady ? "复制接入指令" : "复制指令，在 Agent 中继续"}</Button>
                  : !selected.installed && selected.docs_url ? <a href={selected.docs_url} target="_blank" rel="noreferrer" className="inline-flex min-h-9 items-center gap-2 rounded-lg bg-[var(--foreground)] px-4 text-xs font-semibold text-[var(--surface)]">查看安装指南 <ExternalLink size={12} /></a> : null}
                <Button size="sm" onPress={() => void state.probe(selected.id)} isLoading={checking} isDisabled={Boolean(state.probing)}
                  className={ready || !selected.installed ? "border border-[var(--border)] bg-[var(--surface)] text-xs font-semibold text-[var(--foreground)]" : "bg-[var(--foreground)] px-4 text-xs font-semibold text-[var(--surface)]"}>
                  {checking ? "正在检查" : ready ? "重新检查" : selected.status === "auth_required" ? "登录后检查" : "检查接入"}
                </Button>
                {selected.installed && selected.docs_url && <a href={selected.docs_url} target="_blank" rel="noreferrer" className="inline-flex min-h-9 items-center gap-1.5 px-2 text-xs text-[var(--foreground-muted)]">{selected.status === "auth_required" ? "登录指南" : "官方指南"} <ExternalLink size={12} /></a>}
              </div>
              {copyError && <p role="alert" className="mt-3 text-xs text-amber-700">{copyError}</p>}
              {localReady && !state.snapshot?.connect_prompt && <p className="mt-3 text-xs leading-relaxed text-amber-700">当前安装包未提供外部 Agent 接入指令，请通过已配置的 OfferU 接入包继续。</p>}
              <details className="mt-5 text-xs text-[var(--foreground-muted)]">
                <summary className="w-fit cursor-pointer py-1">查看检查详情{state.snapshot?.connect_prompt ? "与接入指令" : ""}</summary>
                <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 leading-relaxed">
                  <dt>安装与能力</dt><dd>{selected.compatible ? "本机组件检查通过" : "尚未通过"}</dd>
                  <dt>本机登录</dt><dd>{selected.authenticated === true ? "已读取登录信息" : selected.authenticated === false ? "需要登录" : "尚未确认"}</dd>
                  <dt>服务商响应</dt><dd>{capabilityState(selected.live_model_state).label}</dd>
                  <dt>生命周期</dt><dd>继续 {capabilityState(selected.resume_state).label} · 取消 {capabilityState(selected.cancel_state).label}</dd>
                  <dt>流式输出</dt><dd>{capabilityState(selected.streaming_state).label}</dd>
                  <dt>网页搜索</dt><dd>{capabilityState(selected.web_search_state).label}</dd>
                  <dt>最近检测</dt><dd>{connectionTime(selected.detected_at)}</dd>
                </dl>
                {state.snapshot?.connect_prompt && <p className="mt-3 select-text whitespace-pre-wrap break-words rounded-lg bg-[var(--surface-muted)] p-3 leading-6">{state.snapshot.connect_prompt}</p>}
              </details>
            </> : <div className="flex min-h-48 flex-col items-center justify-center gap-3 text-center text-[var(--foreground-muted)]"><Laptop size={28} strokeWidth={1.25} /><p className="text-sm">连接工作台后，从这里开始。</p></div>}
          </div>
        </div>

        <div className="border-t border-[var(--border)] bg-[var(--surface-muted)]/50 p-5 sm:px-7">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="flex items-center gap-2 text-xs font-semibold"><Waypoints size={15} /> 当前内容同步
                <span role="status" className={`font-normal ${syncFailed ? "text-red-700" : "text-[var(--foreground-muted)]"}`}>{state.sync.status === "syncing" ? "同步中…" : syncDone ? "工作台已收到" : syncFailed ? "同步失败" : "等待同步"}</span>
              </p>
              <p className="mt-2 break-words text-xs text-[var(--foreground-muted)]">{syncFailed ? state.sync.error : state.sync.title || "打开一个页面或选中岗位即可同步。"}</p>
              {state.sync.confirmedAt && <p className="mt-1 text-[11px] text-[var(--foreground-muted)]">上次成功 {connectionTime(state.sync.confirmedAt)} · 版本 {state.sync.version}</p>}
            </div>
            <Button size="sm" variant="light" onPress={state.retrySync} isLoading={state.sync.status === "syncing"} startContent={<RefreshCw size={12} />}
              className="text-xs text-[var(--foreground)]">{syncFailed ? "重试同步" : "立即同步"}</Button>
          </div>
          <p className="mt-3 text-[11px] leading-relaxed text-[var(--foreground-muted)]">这里只确认工作台收到内容。Agent 读取后会在自己的会话中告诉你结果。</p>
          <details className="mt-4 text-xs text-[var(--foreground-muted)]">
            <summary className="w-fit cursor-pointer py-1">最近活动 · 本次打开以来</summary>
            <ol className="mt-3 space-y-2.5">
              {state.activity.map((event) => <li key={event.id} className="flex items-start gap-2 text-[11px]">
                {event.failed ? <AlertCircle size={12} className="mt-0.5 shrink-0 text-amber-700" /> : <Check size={12} className="mt-0.5 shrink-0" />}
                <span className="flex-1">{event.message}</span><time className="shrink-0 tabular-nums">{connectionTime(event.time)}</time>
              </li>)}
              {!state.activity.length && <li>还没有接入或同步活动。</li>}
            </ol>
          </details>
          <p className="mt-4 flex items-center gap-1.5 text-[10.5px] text-[var(--foreground-muted)]"><span className={`h-1.5 w-1.5 rounded-full ${state.error || state.stale ? "bg-amber-500" : "bg-[var(--foreground-muted)]"}`} />
            {state.refreshing ? "正在更新状态…" : `状态每 15 秒更新 · 最近 ${connectionTime(state.snapshot?.checked_at)}`}
            {state.offline && " · 系统提示网络离线"}
          </p>
        </div>
      </>}
    </section>
  );
}

export function AgentConnectionDialog() {
  const { open, setOpen } = useAgentConnection();
  return <Modal isOpen={open} onOpenChange={setOpen} size="3xl" scrollBehavior="inside" placement="center"
    classNames={{ base: "bg-[var(--background)] text-[var(--foreground)]", closeButton: "mt-2 mr-2" }}>
    <ModalContent>
      <ModalHeader className="px-6 pb-3 pt-5 text-sm font-semibold">Agent 接入与同步</ModalHeader>
      <ModalBody className="px-3 pb-4 sm:px-5"><AgentConnectionPanel embedded /></ModalBody>
    </ModalContent>
  </Modal>;
}
