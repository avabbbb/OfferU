"use client";

import { useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { Button, Modal, ModalBody, ModalContent, ModalHeader } from "@nextui-org/react";
import { AlertCircle, ArrowRight, Check, Copy, Loader2, Plug, RefreshCw } from "lucide-react";
import { connectionTime, useAgentConnection } from "@/lib/agentConnection";
import { OFFERU_MATERIAL_COLLABORATION_PROMPT } from "@/lib/agentConnectionPrompt";
import { agentRuntimeApi, type AgentConnectionsSnapshot } from "@/lib/api";
import { safeClientErrorMessage } from "@/lib/safe-error";
import { SHOWCASE } from "@/lib/showcase/router";

export function AgentConnectionStatus({ compact = false }: { compact?: boolean }) {
  const state = useAgentConnection();
  const syncing = state.sync.status === "syncing";
  const connected = state.connection?.connection_verified && state.connection.status === "ready";
  const label = state.sync.status === "failed" ? "OfferU 页面同步失败" : connected ? `${state.connection?.name} · 已验证连接` : "使用我的 Agent";
  const detail = state.sync.status === "failed"
    ? "点击查看同步问题和 Agent 接入"
    : "连接你已有的 Agent，查看任务与审核结果";

  return (
    <button type="button" onClick={() => state.setOpen(true)} aria-label={`${label}，查看 Agent 接入`}
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
  const [connections, setConnections] = useState<AgentConnectionsSnapshot | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [materialCopyState, setMaterialCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const desktop = isTauri();
  const candidates = connections?.items.filter((item) => item.installed && item.compatible && item.can_install_skill) || [];
  const selected = candidates.find((item) => item.id === selectedId)
    || candidates.find((item) => item.id === connections?.recommended_provider_id)
    || candidates[0];
  const applySnapshot = (snapshot: AgentConnectionsSnapshot) => {
    setConnections(snapshot);
    const available = snapshot.items.filter((item) => item.installed && item.compatible && item.can_install_skill);
    state.reportConnection(available.find((item) => item.id === selectedId)
      || available.find((item) => item.id === snapshot.recommended_provider_id) || available[0] || null);
  };

  const discover = async () => {
    if (!desktop || SHOWCASE) return;
    setBusy(true); setError("");
    setConnections(null); state.reportConnection(null);
    try {
      applySnapshot(await agentRuntimeApi.connections());
    } catch (cause) { setError(safeClientErrorMessage(cause, "读取本机 Agent 失败，请重试。")); }
    finally { setBusy(false); }
  };

  const connect = async () => {
    if (!desktop || SHOWCASE || !selected || busy) return;
    setBusy(true); setError("");
    state.reportConnection(null);
    try {
      applySnapshot(await (selected.skill_status === "INSTALLED"
        ? agentRuntimeApi.probeConnection(selected.id)
        : agentRuntimeApi.connectIntegration(selected.id, selected.skill_status === "OUTDATED" ? "update" : "install")));
    } catch (cause) { setError(safeClientErrorMessage(cause, "Agent 接入未完成，请重试。")); }
    finally { setBusy(false); }
  };

  const copyMaterialPrompt = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
      await navigator.clipboard.writeText(OFFERU_MATERIAL_COLLABORATION_PROMPT);
      setMaterialCopyState("copied");
    } catch {
      setMaterialCopyState("failed");
    }
  };

  return (
    <section id={embedded ? undefined : "agent-connection"} data-testid={embedded ? "agent-provider-health-dialog" : "agent-provider-health"}
      className={`${embedded ? "shrink-0 " : ""}overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] text-[var(--foreground)]`}>
      <div className="border-b border-[var(--border)] px-5 py-6 sm:px-7">
        <span className="inline-flex items-center gap-2 text-[11px] font-semibold tracking-wide text-[var(--foreground-muted)]"><Plug size={14} /> 你的 Agent</span>
        <h3 className="mt-4 text-xl font-semibold tracking-tight sm:text-2xl">把 OfferU 交给你正在使用的 Agent。</h3>
        <p className="mt-2 max-w-xl text-sm leading-relaxed text-[var(--foreground-muted)]">
          OfferU 为你的 Agent 提供职业档案、岗位工具和审核工作区。Desktop 会安装或更新接入，并检查真实读取结果；你也可以先用内置 Agent 操作 OfferU、准备岗位简历。
        </p>
      </div>

      {SHOWCASE ? <p role="status" className="p-6 text-sm text-[var(--foreground-muted)]">展示模式使用 Demo Agent 和虚构数据。真实 Agent 接入请使用 OfferU Desktop。</p> : <div className="space-y-5 p-5 sm:p-7">
        {desktop ? <div className="space-y-3">
          <Button size="sm" onPress={() => void discover()} isDisabled={busy} startContent={busy ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}>
            {connections ? "重新检查本机 Agent" : "发现本机 Agent"}
          </Button>
          {selected && <div className="rounded-xl border border-[var(--border)] p-4">
            <p className="text-sm font-semibold">{selected.name}</p>
            <p role="status" className="mt-2 text-xs text-[var(--foreground-muted)]">{busy ? "正在接入并检查真实读取，请稍候…" : selected.connection_verified && selected.status === "ready" ? "已验证连接：Agent 已完成真实工具读取。" : selected.last_error || (selected.skill_status === "INSTALLED" ? "接入文件已安装，真实连接尚未验证。" : "已发现 Agent，接入尚未完成。")}</p>
            <Button size="sm" onPress={() => void connect()} isDisabled={busy || (selected.connection_verified && selected.status === "ready")} className="mt-3">
              {selected.connection_verified && selected.status === "ready" ? "已验证连接" : selected.skill_status === "INSTALLED" ? "验证连接" : selected.skill_status === "OUTDATED" ? "更新接入并验证" : `连接 ${selected.name}`}
            </Button>
          </div>}
          {connections && !selected && <p role="status" className="text-xs text-[var(--foreground-muted)]">尚未发现可自动接入的本地 Agent。可以继续使用内置 Agent；消费级 Agent 的连接需由对应宿主支持。</p>}
          {candidates.length > 1 && <details className="text-xs"><summary className="cursor-pointer">其他已发现的 Agent</summary><div className="mt-2 flex flex-wrap gap-2">{candidates.filter((item) => item.id !== selected?.id).map((item) => <Button key={item.id} size="sm" isDisabled={busy} onPress={() => { setSelectedId(item.id); state.reportConnection(item); }}>{item.name}</Button>)}</div></details>}
        </div> : <p role="status" className="text-xs text-[var(--foreground-muted)]">请在 OfferU Desktop 中连接你的 Agent。当前网页不会扫描本机或安装接入文件。</p>}
        {error && <p role="alert" className="flex gap-2 text-xs text-amber-800"><AlertCircle size={14} />{error}</p>}
        <p className="text-[11px] leading-relaxed text-[var(--foreground-muted)]">
          检测到程序、安装接入文件和验证连接是三个不同状态。OfferU 不会替你改动 Agent 的账号、模型、凭据或代理。远程消费级 Connector 尚未接入，材料协作不会建立工具连接。
        </p>

        <details className="rounded-xl border border-[var(--border)] p-4">
          <summary className="cursor-pointer text-xs font-semibold">我的 Agent 只能聊天，使用材料协作</summary>
          <div className="mt-3 space-y-3">
            <p className="text-xs leading-relaxed text-[var(--foreground-muted)]">复制协作说明到你的聊天 Agent，再自行提供本次岗位和必要经历。先检查要分享的内容；OfferU 不会自动上传档案。审核结果后，将采用的内容保存到对应岗位工作区。</p>
            <Button size="sm" variant="bordered" onPress={() => void copyMaterialPrompt()} startContent={materialCopyState === "copied" ? <Check size={14} /> : <Copy size={14} />}>
              {materialCopyState === "copied" ? "已复制协作说明" : "复制协作说明"}
            </Button>
            {materialCopyState === "copied" && <p role="status" className="text-xs text-emerald-700">粘贴到你的聊天 Agent，再提供本次需要的材料。当前仍未连接 OfferU。</p>}
            {materialCopyState === "failed" && <p role="alert" className="text-xs text-amber-800">自动复制失败，请从下方文本框手动复制协作说明。</p>}
            <label htmlFor="offeru-material-prompt" className="block text-xs font-semibold">材料协作说明</label>
            <textarea id="offeru-material-prompt" readOnly value={OFFERU_MATERIAL_COLLABORATION_PROMPT} rows={8} onFocus={(event) => event.currentTarget.select()}
              className="w-full resize-y rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-3 text-xs leading-6 text-[var(--foreground)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2" />
          </div>
        </details>

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
      <ModalHeader className="px-6 pb-3 pt-5 text-sm font-semibold">使用我的 Agent</ModalHeader>
      <ModalBody className="px-3 pb-4 sm:px-5"><AgentConnectionPanel embedded /></ModalBody>
    </ModalContent>
  </Modal>;
}
