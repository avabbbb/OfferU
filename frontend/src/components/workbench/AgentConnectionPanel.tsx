"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { Button, Modal, ModalBody, ModalContent, ModalHeader } from "@heroui/react";
import { AlertCircle, ArrowRight, Check, Copy, Loader2, Plug, RefreshCw } from "lucide-react";
import { connectionTime, useAgentConnection } from "@/lib/agentConnection";
import { OFFERU_MATERIAL_COLLABORATION_PROMPT } from "@/lib/agentConnectionPrompt";
import { agentRuntimeApi, type AgentConnectionsSnapshot } from "@/lib/api";
import { safeClientErrorMessage } from "@/lib/safe-error";
import { SHOWCASE } from "@/lib/showcase";
import { isLiteRuntime } from "@/lib/liteSession";

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

type AgentConnectionItem = AgentConnectionsSnapshot["items"][number];

const SKILL_LABEL: Record<string, string> = { INSTALLED: "已安装", OUTDATED: "需更新", NOT_INSTALLED: "未安装", ERROR: "异常", NOT_SUPPORTED: "不支持" };
const MCP_LABEL: Record<string, string> = { REGISTERED: "已注册", NOT_REGISTERED: "未注册", NOT_SUPPORTED: "不适用", UNKNOWN: "无法读取" };

function agentStatusLabel(item: AgentConnectionItem): string {
  if (item.connection_verified && item.status === "ready") return "已验证连接";
  switch (item.status) {
    case "missing": return "未安装";
    case "incompatible": return "版本不兼容";
    case "integration_missing": return "未接入";
    case "outdated": return "接入需更新";
    case "auth_required": return "需要登录";
    case "blocked": return "被阻止";
    case "failed": return "接入失败";
    default: return item.skill_status === "INSTALLED" ? "已安装，待验证" : "待检查";
  }
}

export function AgentConnectionPanel({ embedded = false }: { embedded?: boolean }) {
  const state = useAgentConnection();
  const [connections, setConnections] = useState<AgentConnectionsSnapshot | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [materialCopyState, setMaterialCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const desktop = isTauri() || isLiteRuntime();
  const candidates = connections?.items.filter((item) => item.installed && item.compatible && item.can_install_skill) || [];
  const selected = candidates.find((item) => item.id === selectedId)
    || candidates.find((item) => item.id === connections?.recommended_provider_id)
    || candidates[0];
  const applySnapshot = useCallback((snapshot: AgentConnectionsSnapshot) => {
    setConnections(snapshot);
    const available = snapshot.items.filter((item) => item.installed && item.compatible && item.can_install_skill);
    state.reportConnection(available.find((item) => item.id === selectedId)
      || available.find((item) => item.id === snapshot.recommended_provider_id) || available[0] || null);
  }, [selectedId, state.reportConnection]);

  const polling = useRef(false);
  const awaitingReadback = Boolean(selected?.verification_challenge);
  useEffect(() => {
    if (!desktop || SHOWCASE || !awaitingReadback || busy || (!embedded && !state.open)) return;
    let active = true;
    const timer = window.setInterval(async () => {
      if (polling.current || document.hidden) return;
      polling.current = true;
      try {
        const snapshot = await agentRuntimeApi.connections();
        if (active) applySnapshot(snapshot);
      } catch (cause) {
        if (active) setError(safeClientErrorMessage(cause, "连接回读暂时无法更新，请重试。"));
      } finally { polling.current = false; }
    }, 2000);
    return () => { active = false; window.clearInterval(timer); };
  }, [desktop, awaitingReadback, busy, embedded, state.open, applySnapshot]);

  const discover = async () => {
    if (!desktop || SHOWCASE) return;
    setBusy(true); setError("");
    setConnections(null); state.reportConnection(null);
    try {
      applySnapshot(await agentRuntimeApi.connections());
    } catch (cause) { setError(safeClientErrorMessage(cause, "读取本机 Agent 失败，请重试。")); }
    finally { setBusy(false); }
  };

  const connect = async (target: AgentConnectionItem | undefined = selected) => {
    if (!desktop || SHOWCASE || !target || busy) return;
    setBusy(true); setError("");
    setSelectedId(target.id);
    state.reportConnection(null);
    try {
      applySnapshot(await (target.skill_status === "INSTALLED"
        ? agentRuntimeApi.probeConnection(target.id)
        : agentRuntimeApi.connectIntegration(target.id, target.skill_status === "OUTDATED" ? "update" : "install")));
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
          OfferU 为你已有的 Agent 提供职业档案、岗位工具和审核工作区。准备接入后，在你的 Agent 中使用 OfferU，连接结果会自动回读。你也可以先用内置 Agent 操作 OfferU、准备岗位简历。
        </p>
      </div>

      {SHOWCASE ? <p role="status" className="p-6 text-sm text-[var(--foreground-muted)]">展示模式使用 Demo Agent 和虚构数据。真实 Agent 接入请在本机安装 OfferU 后运行 offeru start。</p> : <div className="space-y-5 p-5 sm:p-7">
        {desktop ? <div className="space-y-3">
          <Button size="sm" onPress={() => void discover()} isDisabled={busy} startContent={busy ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}>
            {connections ? "重新检查本机 Agent" : "发现本机 Agent"}
          </Button>
          {connections && <ul className="divide-y divide-[var(--border)] rounded-xl border border-[var(--border)]" aria-label="本机 Agent 清单" data-testid="agent-checklist">
            {connections.items.filter((item) => item.installed || item.id === "external").map((item) => {
              const verified = item.connection_verified && item.status === "ready";
              return <li key={item.id} className="space-y-2 p-4" data-testid={"agent-row-" + item.id}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold">
                    {item.name}
                    {item.id === selected?.id && <span className="ml-2 text-[11px] font-normal text-[var(--foreground-muted)]">当前使用</span>}
                  </p>
                  <span role="status" className={"text-xs " + (verified ? "text-emerald-700" : "text-[var(--foreground-muted)]")}>{busy && item.id === selected?.id ? "处理中…" : agentStatusLabel(item)}</span>
                </div>
                <dl className="grid grid-cols-[4.5rem_1fr] gap-x-3 gap-y-1 text-[11px] text-[var(--foreground-muted)]">
                  <dt>程序</dt><dd className="break-all">{item.executable_path || (item.id === "external" ? "通用 Skill 目录，无需程序" : "未发现")}</dd>
                  <dt>Skill</dt><dd className="break-all">{SKILL_LABEL[item.skill_status] || item.skill_status}{item.skill_path ? " · " + item.skill_path : ""}</dd>
                  <dt>MCP</dt><dd>{MCP_LABEL[item.mcp_status || "UNKNOWN"]}</dd>
                  <dt>最后验证</dt><dd>{item.checked_at ? connectionTime(item.checked_at) : "从未验证"}</dd>
                </dl>
                {item.last_error && <p className="break-words text-[11px] text-amber-800">{item.last_error}</p>}
                {item.can_install_skill && item.compatible && <Button size="sm" variant="bordered" onPress={() => void connect(item)} isDisabled={busy || verified}>
                  {verified ? "已验证" : item.skill_status === "INSTALLED" ? "验证连接" : item.skill_status === "OUTDATED" ? "更新并验证" : "连接"}
                </Button>}
              </li>;
            })}
          </ul>}
          {connections && connections.items.some((item) => !item.installed && item.id !== "external") && <p className="text-[11px] text-[var(--foreground-muted)]">
            本机未发现：{connections.items.filter((item) => !item.installed && item.id !== "external").map((item) => item.name).join("、")}
          </p>}
          {awaitingReadback && <p role="status" className="text-xs leading-relaxed text-[var(--foreground-muted)]">接入已准备。到 {selected?.name} 里用一次 OfferU Skill，完成只读回读后这一行会变成「已验证连接」。</p>}
          {connections && !selected && <p role="status" className="text-xs text-[var(--foreground-muted)]">尚未发现可自动接入的本地 Agent。可以继续使用内置 Agent。</p>}
        </div> : <p role="status" className="text-xs text-[var(--foreground-muted)]">在终端运行 offeru connect，或用 offeru start 打开的工作台连接你的 Agent。当前网页不会扫描本机或安装接入文件。</p>}
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
