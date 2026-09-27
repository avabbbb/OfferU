"use client";

import { useState } from "react";
import { Button, Modal, ModalBody, ModalContent, ModalHeader } from "@nextui-org/react";
import { AlertCircle, ArrowRight, Check, Copy, Loader2, Plug, RefreshCw } from "lucide-react";
import { connectionTime, useAgentConnection } from "@/lib/agentConnection";
import { OFFERU_CONNECT_PROMPT } from "@/lib/agentConnectionPrompt";
import { SHOWCASE } from "@/lib/showcase/router";

export function AgentConnectionStatus({ compact = false }: { compact?: boolean }) {
  const state = useAgentConnection();
  const syncing = state.sync.status === "syncing";
  const label = state.sync.status === "failed" ? "OfferU 页面同步失败" : "连接本地 Agent";
  const detail = state.sync.status === "failed"
    ? "点击查看同步问题和接入提示词"
    : state.promptCopied
      ? "提示词已复制，粘贴到你正在使用的本地 Agent"
      : "复制一段提示词，交给你正在使用的本地 Agent";

  return (
    <button type="button" onClick={() => state.setOpen(true)} aria-label={`${label}，查看接入提示词`}
      data-testid="agent-connection-status"
      className={`group flex min-h-10 items-center gap-2.5 rounded-xl border border-[var(--border)] bg-[var(--surface)] text-left text-[var(--foreground)] transition-colors hover:border-[var(--border-strong)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ${compact ? "px-3 py-2" : "w-full px-3 py-3"}`}>
      {syncing ? <Loader2 size={16} className="shrink-0 motion-safe:animate-spin" /> : <Plug size={16} className="shrink-0" />}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-semibold">{label}</span>
        {!compact && <span className="mt-1 block truncate text-[10.5px] text-[var(--foreground-muted)]">{detail}</span>}
      </span>
      <ArrowRight size={13} className="shrink-0 text-[var(--foreground-muted)]" />
    </button>
  );
}

export function AgentConnectionPanel({ embedded = false }: { embedded?: boolean }) {
  const state = useAgentConnection();
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  const copyPrompt = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
      await navigator.clipboard.writeText(OFFERU_CONNECT_PROMPT);
      state.markPromptCopied();
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };

  return (
    <section id={embedded ? undefined : "agent-connection"} data-testid={embedded ? "agent-provider-health-dialog" : "agent-provider-health"}
      className={`${embedded ? "shrink-0 " : ""}overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] text-[var(--foreground)]`}>
      <div className="border-b border-[var(--border)] px-5 py-6 sm:px-7">
        <span className="inline-flex items-center gap-2 text-[11px] font-semibold tracking-wide text-[var(--foreground-muted)]"><Plug size={14} /> 本地 Agent</span>
        <h3 className="mt-4 text-xl font-semibold tracking-tight sm:text-2xl">把 OfferU 交给你正在使用的 Agent。</h3>
        <p className="mt-2 max-w-xl text-sm leading-relaxed text-[var(--foreground-muted)]">
          复制一次接入提示词，粘贴到本地 coding Agent。它会从 GitHub 获取官方 OfferU Skill，再连接本机运行时。
        </p>
      </div>

      {SHOWCASE ? <p role="status" className="p-6 text-sm text-[var(--foreground-muted)]">展示模式不连接本地 Agent。请在本机 OfferU 中复制接入提示词。</p> : <div className="space-y-5 p-5 sm:p-7">
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" onPress={() => void copyPrompt()} startContent={copyState === "copied" ? <Check size={14} /> : <Copy size={14} />}
            className="bg-[var(--foreground)] px-4 text-xs font-semibold text-[var(--surface)]">
            {copyState === "copied" ? "已复制接入提示词" : "复制接入提示词"}
          </Button>
          {copyState === "copied" && <span role="status" className="text-xs text-emerald-700">现在切换到你的本地 Agent，粘贴并发送。</span>}
        </div>
        {copyState === "failed" && <p role="alert" className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs leading-relaxed text-amber-900">
          <AlertCircle size={14} className="mt-0.5 shrink-0" />自动复制失败。提示词仍显示在下方；点击文本框后全选并手动复制。
        </p>}
        <label htmlFor="offeru-connect-prompt" className="block text-xs font-semibold">接入提示词</label>
        <textarea id="offeru-connect-prompt" readOnly value={OFFERU_CONNECT_PROMPT} rows={8}
          onFocus={(event) => event.currentTarget.select()}
          className="w-full resize-y rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-3 text-xs leading-6 text-[var(--foreground)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2" />
        <p className="text-[11px] leading-relaxed text-[var(--foreground-muted)]">
          复制只代表提示词已准备好，不代表 Agent 已连接。OfferU 不会替你改动 Agent 的账号、模型、凭据或代理。
        </p>

        <div className="rounded-xl border border-[var(--border)] p-4" aria-label="OfferU 当前页面同步状态">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-semibold">当前页面同步</p>
            <span role="status" className={`text-xs ${state.sync.status === "failed" ? "text-red-700" : "text-[var(--foreground-muted)]"}`}>
              {state.sync.status === "syncing" ? "同步中…" : state.sync.status === "synced" ? "已同步到 OfferU" : state.sync.status === "failed" ? "同步失败" : "等待同步"}
            </span>
          </div>
          <p className="mt-2 break-words text-xs text-[var(--foreground-muted)]">
            {state.sync.status === "failed" ? state.sync.error : state.sync.title || "打开一个页面或选中岗位即可同步。"}
          </p>
          {state.sync.confirmedAt && <p className="mt-1 text-[11px] text-[var(--foreground-muted)]">上次成功 {connectionTime(state.sync.confirmedAt)} · 版本 {state.sync.version}</p>}
          {state.sync.status === "failed" && <Button size="sm" variant="light" onPress={state.retrySync}
            startContent={<RefreshCw size={12} />} className="mt-2 text-xs text-[var(--foreground)]">重试同步</Button>}
        </div>
      </div>}
    </section>
  );
}

export function AgentConnectionDialog() {
  const { open, setOpen } = useAgentConnection();
  return <Modal isOpen={open} onOpenChange={setOpen} size="2xl" scrollBehavior="inside" placement="center"
    classNames={{ base: "bg-[var(--background)] text-[var(--foreground)]", closeButton: "mt-2 mr-2" }}>
    <ModalContent>
      <ModalHeader className="px-6 pb-3 pt-5 text-sm font-semibold">连接本地 Agent</ModalHeader>
      <ModalBody className="px-3 pb-4 sm:px-5"><AgentConnectionPanel embedded /></ModalBody>
    </ModalContent>
  </Modal>;
}
