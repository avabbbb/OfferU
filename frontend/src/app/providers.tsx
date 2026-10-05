// =============================================
// NextUI + SWR Provider 包装 + Onboarding 引导
// =============================================

"use client";

import { NextUIProvider } from "@nextui-org/react";
import { SWRConfig } from "swr";
import { useEffect, useState } from "react";
import Link from "next/link";
import { SHOWCASE } from "@/lib/showcase/router";
import { resolveApiBase } from "@/lib/apiBase";
import {
  getDesktopRuntimeIdentity,
  getDesktopBackendStatus,
  isDesktopRuntime,
  matchesDesktopRuntimeIdentity,
} from "@/lib/runtimeIdentityApi";

const API_BASE = resolveApiBase();
const APP_VERSION = import.meta.env.VITE_APP_VERSION || "0.0.0";
const BACKEND_STARTUP_TIMEOUT_MS = 45_000;
const BACKEND_STARTUP_SLOW_HINT_MS = 8_000;

export function BackendReadyGate({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(SHOWCASE);
  const [startupError, setStartupError] = useState(false);
  const [slowHint, setSlowHint] = useState(false);
  const [readinessState, setReadinessState] = useState<"waiting" | "connection" | "identity-mismatch" | "native-identity-unavailable" | "backend-failed">("waiting");
  const [probeNonce, setProbeNonce] = useState(0);
  const [startupRecovery, setStartupRecovery] = useState<{
    status: string;
    failed_checks: string[];
    checks: Record<string, { error_id?: string }>;
  } | null>(null);

  useEffect(() => {
    if (SHOWCASE) return; // 展示模式无 Python 后端，直接放行
    const desktopRuntime = isDesktopRuntime();
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let slowHintTimer: ReturnType<typeof setTimeout> | undefined;
    setReady(false);
    setStartupError(false);
    setSlowHint(false);
    setReadinessState("waiting");
    const deadline = Date.now() + BACKEND_STARTUP_TIMEOUT_MS;
    slowHintTimer = setTimeout(() => {
      if (!cancelled) setSlowHint(true);
    }, BACKEND_STARTUP_SLOW_HINT_MS);
    const probe = async () => {
      if (desktopRuntime) {
        const status = await getDesktopBackendStatus();
        if (cancelled) return;
        if (status?.state === "failed") {
          setReadinessState("backend-failed");
          setStartupError(true);
          clearTimeout(slowHintTimer);
          return;
        }
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1200);
      try {
        const response = await fetch(`${API_BASE}/api/health`, {
          cache: "no-store",
          redirect: "error",
          signal: controller.signal,
        });
        const payload = response.ok ? await response.json() : null;
        const isDev = import.meta.env.DEV;
        const versionOk = payload?.version === APP_VERSION;
        if (desktopRuntime) {
          const expected = await getDesktopRuntimeIdentity();
          if (!expected) {
            if (!cancelled) setReadinessState("native-identity-unavailable");
          } else if (matchesDesktopRuntimeIdentity(expected, payload, isDev ? "source" : "release")) {
            if (!cancelled) {
              setStartupRecovery(payload.startup_recovery || null);
              setStartupError(false);
              setReadinessState("waiting");
              setReady(true);
            }
            return;
          } else if (!cancelled) {
            setReadinessState("identity-mismatch");
          }
        } else if (
          !cancelled
          && payload?.status === "ok"
          && payload?.service === "OfferU"
          && payload?.runtime === "python"
          && (versionOk || isDev)
        ) {
          if (!versionOk && isDev) {
            console.warn(`Version mismatch: frontend=${APP_VERSION}, backend=${payload?.version}`);
          }
          setStartupRecovery(payload.startup_recovery || null);
          setStartupError(false);
          setReadinessState("waiting");
          setReady(true);
          return;
        } else if (!cancelled) {
          setReadinessState("connection");
        }
      } catch {
        // Desktop startup is expected to race the Python process once.
        if (!cancelled) setReadinessState("connection");
      } finally {
        clearTimeout(timeout);
      }
      if (!cancelled && Date.now() >= deadline) {
        setStartupError(true);
        return;
      }
      if (!cancelled) retryTimer = setTimeout(probe, 250);
    };

    probe();
    return () => {
      cancelled = true;
      clearTimeout(retryTimer);
      clearTimeout(slowHintTimer);
    };
  }, [probeNonce]);

  if (!ready) {
    return (
      <div className="offeru-viewport-min-height grid w-full place-items-center bg-[var(--background)] px-6">
        <div
          className="bauhaus-panel flex max-w-[520px] items-start gap-4 bg-[var(--surface)] px-6 py-5"
          data-testid="backend-ready-gate"
          data-readiness-state={readinessState}
        >
          <span
            className={`mt-1 h-5 w-5 shrink-0 ${startupError ? "bg-[var(--primary-red)]" : "animate-pulse bg-[var(--primary-red)]"}`}
            aria-hidden="true"
          />
          <div className="min-w-0">
            <p className="bauhaus-label text-[var(--foreground-muted)]">OfferU</p>
            {startupError ? (
              <>
                <p className="text-sm font-semibold">
                  {readinessState === "backend-failed" ? "OfferU 后端启动失败" : readinessState === "identity-mismatch" || readinessState === "native-identity-unavailable"
                    ? "无法验证当前桌面运行身份"
                    : "无法连接 OfferU 后端"}
                </p>
                <p className="mt-2 text-xs leading-5 text-[var(--foreground-muted)]">
                  {isDesktopRuntime() ? (
                    <>请关闭并重新打开 OfferU。如果仍未恢复，请更新或重新安装当前版本；保留本地数据与诊断记录。</>
                  ) : readinessState === "identity-mismatch" || readinessState === "native-identity-unavailable" ? (
                    <>检测到本地服务与当前桌面实例不匹配，或安装包身份资料缺失。请关闭并重新打开 OfferU；如果仍未恢复，请更新或重新安装当前版本。</>
                  ) : (
                    <>请确认本地 API 正在 <code>http://127.0.0.1:8766</code> 运行。网页入口是 <code>http://127.0.0.1:7410</code>；8080 只是模型接口，不是网页地址。</>
                  )}
                </p>
                <button
                  type="button"
                  className="bauhaus-button bauhaus-button-red mt-3 !px-4 !py-2 !text-[11px]"
                  data-testid="backend-ready-retry"
                  onClick={() => setProbeNonce((value) => value + 1)}
                >
                  重新检查
                </button>
              </>
            ) : (
              <>
                <p className="text-sm font-semibold">正在启动 Python 工作台…</p>
                {slowHint && (
                  <>
                    <p className="mt-2 text-xs leading-5 text-[var(--foreground-muted)]">
                      {isDesktopRuntime() ? "首次启动可能需要较长时间，仍在检查本地服务。" : "连接时间较长，仍在重试。若本地服务未启动，请先在终端启动后端（端口 8766）。"}
                    </p>
                    <button
                      type="button"
                      className="bauhaus-button bauhaus-button-red mt-3 !px-4 !py-2 !text-[11px]"
                      onClick={() => setProbeNonce((value) => value + 1)}
                    >
                      立即重试
                    </button>
                  </>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  const failedChecks = startupRecovery?.failed_checks || [];
  const recoveryLabels: Record<string, string> = {
    agent_runs: "Agent 运行",
    career_tasks: "后台任务",
    automation_events: "自动化事件",
    research_runs: "岗位研究",
    interview_state: "面试状态",
    hosted_executors: "执行器",
    authorized_research: "授权研究",
  };

  return (
    <>
      {startupRecovery?.status === "degraded" && failedChecks.length > 0 && (
        <div
          className="sticky top-0 z-50 border-b border-amber-300 bg-amber-50 px-4 py-2 text-sm font-semibold text-amber-950"
          role="status"
          data-testid="startup-recovery-warning"
        >
          <div className="mx-auto flex max-w-[1200px] flex-wrap items-center justify-between gap-2">
            <span>
              部分后台恢复未完成：{failedChecks.map((name) => recoveryLabels[name] || name).join("、")}。核心数据仍可使用，请稍后重试。
            </span>
            <Link className="font-black underline underline-offset-2" href="/settings">
              查看设置与诊断
            </Link>
          </div>
        </div>
      )}
      {children}
    </>
  );
}

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SWRConfig
      value={{
        revalidateOnFocus: false,
        revalidateOnReconnect: false,
        dedupingInterval: 5000,
      }}
    >
      <NextUIProvider>
        <BackendReadyGate>
          {children}
        </BackendReadyGate>
      </NextUIProvider>
    </SWRConfig>
  );
}
