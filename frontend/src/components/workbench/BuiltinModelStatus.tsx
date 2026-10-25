"use client";

// 内置助手的 BYOK 模型状态：显示当前使用的模型与密钥来源，入口指向模型设置（配置 / 管理密钥）。
// 外置 Coding Agent 的接入只保留在侧栏「使用我的 Agent」，这里不再重复。

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AlertCircle, ArrowRight, KeyRound, Loader2 } from "lucide-react";
import { configApi } from "@/lib/api";
import { MODEL_SETTINGS_ROUTE } from "@/lib/agentRecovery";
import { SHOWCASE } from "@/lib/showcase";

type LlmSource = "active_config" | "legacy_env" | "ollama";

interface ActiveLlmSummary {
  provider_id: string;
  service_name: string;
  model: string;
  base_url: string;
  source: LlmSource;
}

interface ModelConfigSnapshot {
  active_llm_summary?: ActiveLlmSummary | null;
  vault_status?: { available: boolean; error: string } | null;
}

type StatusState =
  | { status: "loading" }
  | { status: "ready"; summary: ActiveLlmSummary | null; vaultError: string }
  | { status: "error" };

const SOURCE_DETAIL: Record<LlmSource, string> = {
  active_config: "使用你自己的密钥 · 点击管理密钥与模型",
  legacy_env: "使用环境变量中的密钥 · 点击改为在设置中管理",
  ollama: "使用本机 Ollama，无需密钥 · 点击切换模型",
};

export function BuiltinModelStatus() {
  const [state, setState] = useState<StatusState>({ status: "loading" });

  const load = useCallback(async () => {
    try {
      const config = (await configApi.get()) as ModelConfigSnapshot | null;
      const vault = config?.vault_status;
      setState({
        status: "ready",
        summary: config?.active_llm_summary || null,
        vaultError: vault && !vault.available ? vault.error || "系统钥匙串不可用" : "",
      });
    } catch {
      setState({ status: "error" });
    }
  }, []);

  useEffect(() => {
    if (SHOWCASE) return;
    void load();
    // 从模型设置改完密钥回到工作台时自动刷新。
    const refresh = () => { if (!document.hidden) void load(); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [load]);

  let label = "正在读取模型配置...";
  let detail = "内置助手使用你自己的模型密钥";
  let warn = false;
  if (SHOWCASE) {
    label = "演示模型";
    detail = "网页演示不需要密钥；本机版可配置自己的模型密钥";
  } else if (state.status === "error") {
    label = "模型配置读取失败";
    detail = "点击前往模型设置检查密钥";
    warn = true;
  } else if (state.status === "ready") {
    if (!state.summary) {
      label = "配置模型密钥";
      detail = "内置助手需要你自己的模型密钥（BYOK），点击添加";
      warn = true;
    } else {
      label = state.summary.service_name + " · " + state.summary.model;
      detail = state.vaultError ? "密钥无法读取：" + state.vaultError : SOURCE_DETAIL[state.summary.source] || SOURCE_DETAIL.active_config;
      warn = Boolean(state.vaultError);
    }
  }

  const icon = state.status === "loading" && !SHOWCASE
    ? <Loader2 size={16} className="shrink-0 motion-safe:animate-spin" />
    : warn ? <AlertCircle size={16} className="shrink-0 text-amber-600" /> : <KeyRound size={16} className="shrink-0" />;
  const className = "group flex min-h-10 items-center gap-2.5 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-left text-[var(--foreground)] transition-colors hover:border-[var(--border-strong)] focus-visible:ring-2";
  const body = (
    <>
      {icon}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-semibold">{label}</span>
        <span className="mt-1 block truncate text-[10.5px] text-[var(--foreground-muted)]">{detail}</span>
      </span>
      {!SHOWCASE && <ArrowRight size={13} className="shrink-0 text-[var(--foreground-muted)]" />}
    </>
  );

  if (SHOWCASE) {
    return <div data-testid="builtin-model-status" className={className}>{body}</div>;
  }
  return (
    <Link href={MODEL_SETTINGS_ROUTE} data-testid="builtin-model-status" aria-label={label + "，管理内置助手的模型密钥"} className={className}>
      {body}
    </Link>
  );
}
