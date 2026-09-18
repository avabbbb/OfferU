// =============================================
// NextUI + SWR Provider 包装 + Onboarding 引导
// =============================================

"use client";

import { NextUIProvider } from "@nextui-org/react";
import { SWRConfig } from "swr";
import { AnimatePresence } from "framer-motion";
import { usePathname } from "next/navigation";
import { lazy, Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useOnboarding } from "@/lib/useOnboarding";
import { SHOWCASE } from "@/lib/showcase/router";
import { resolveApiBase } from "@/lib/apiBase";

const OnboardingWizard = lazy(() =>
  import("@/components/onboarding/OnboardingWizard").then((module) => ({
    default: module.OnboardingWizard,
  })),
);

const API_BASE = resolveApiBase();
const APP_VERSION = import.meta.env.VITE_APP_VERSION || "0.0.0";
const BACKEND_STARTUP_TIMEOUT_MS = 45_000;
const BACKEND_STARTUP_SLOW_HINT_MS = 8_000;

function OnboardingGate({ children }: { children: React.ReactNode }) {
  const { shouldShowWizard, completeWizard, skipWizard } = useOnboarding();
  const pathname = usePathname();
  const canShowWizard = pathname === "/";
  if (SHOWCASE) return children; // 展示模式不弹引导向导

  return (
    <>
      {children}
      <AnimatePresence>
        {shouldShowWizard && canShowWizard && (
          <Suspense fallback={null}>
            <OnboardingWizard
              onComplete={completeWizard}
              onSkip={skipWizard}
            />
          </Suspense>
        )}
      </AnimatePresence>
    </>
  );
}

function BackendReadyGate({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(SHOWCASE);
  const [startupError, setStartupError] = useState(false);
  const [slowHint, setSlowHint] = useState(false);
  const [probeNonce, setProbeNonce] = useState(0);
  const [startupRecovery, setStartupRecovery] = useState<{
    status: string;
    failed_checks: string[];
    checks: Record<string, { error_id?: string }>;
  } | null>(null);

  useEffect(() => {
    if (SHOWCASE) return; // 展示模式无 Python 后端，直接放行
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let slowHintTimer: ReturnType<typeof setTimeout> | undefined;
    setReady(false);
    setStartupError(false);
    setSlowHint(false);
    const deadline = Date.now() + BACKEND_STARTUP_TIMEOUT_MS;
    slowHintTimer = setTimeout(() => {
      if (!cancelled) setSlowHint(true);
    }, BACKEND_STARTUP_SLOW_HINT_MS);
    const probe = async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1200);
      try {
        const response = await fetch(`${API_BASE}/api/health`, {
          cache: "no-store",
          redirect: "error",
          signal: controller.signal,
        });
        const payload = response.ok ? await response.json() : null;
        if (
          !cancelled
          && payload?.status === "ok"
          && payload?.service === "OfferU"
          && payload?.runtime === "python"
          && payload?.version === APP_VERSION
        ) {
          setStartupRecovery(payload.startup_recovery || null);
          setStartupError(false);
          setReady(true);
          return;
        }
      } catch {
        // Desktop startup is expected to race the Python process once.
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
        >
          <span
            className={`mt-1 h-5 w-5 shrink-0 ${startupError ? "bg-[var(--primary-red)]" : "animate-pulse bg-[var(--primary-red)]"}`}
            aria-hidden="true"
          />
          <div className="min-w-0">
            <p className="bauhaus-label text-[var(--foreground-muted)]">OfferU</p>
            {startupError ? (
              <>
                <p className="text-sm font-semibold">无法连接 OfferU 后端</p>
                <p className="mt-2 text-xs leading-5 text-[var(--foreground-muted)]">
                  请确认本地 API 正在 <code>http://127.0.0.1:8766</code> 运行。网页入口是 <code>http://127.0.0.1:7410</code>；8080 只是模型接口，不是网页地址。
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
                      连接时间较长，仍在重试。若本地服务未启动，请先在终端启动后端（端口 8766）。
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
          <OnboardingGate>
            {children}
          </OnboardingGate>
        </BackendReadyGate>
      </NextUIProvider>
    </SWRConfig>
  );
}
