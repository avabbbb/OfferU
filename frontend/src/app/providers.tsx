// =============================================
// NextUI + SWR Provider 包装 + Onboarding 引导
// =============================================

"use client";

import { NextUIProvider } from "@nextui-org/react";
import { SWRConfig } from "swr";
import { AnimatePresence } from "framer-motion";
import { usePathname } from "next/navigation";
import { lazy, Suspense, useEffect, useState } from "react";
import { useOnboarding } from "@/lib/useOnboarding";
import { SHOWCASE } from "@/lib/showcase/router";

const OnboardingWizard = lazy(() =>
  import("@/components/onboarding/OnboardingWizard").then((module) => ({
    default: module.OnboardingWizard,
  })),
);

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ||
  (typeof window !== "undefined"
    ? `${window.location.protocol}//${window.location.hostname}:8765`
    : "http://127.0.0.1:8765");

const PAGE_TITLES: Record<string, string> = {
  "/": "今日",
  "/jobs": "机会",
  "/resume": "材料",
  "/optimize": "简历定制",
  "/applications": "进展",
  "/interview": "面试",
  "/calendar": "日程",
  "/email": "信号收件箱",
  "/profile": "档案",
  "/settings": "设置",
};

function inferPageTitle(pathname: string) {
  if (/^\/jobs\/\d+/.test(pathname)) return "岗位详情";
  if (/^\/resume\/\d+/.test(pathname)) return "简历详情";
  return PAGE_TITLES[pathname] || "OfferU 页面";
}

function inferEntity(pathname: string) {
  const jobMatch = pathname.match(/^\/jobs\/(\d+)/);
  if (jobMatch) return { entity_type: "job", entity_id: jobMatch[1] };
  const resumeMatch = pathname.match(/^\/resume\/(\d+)/);
  if (resumeMatch) return { entity_type: "resume", entity_id: resumeMatch[1] };
  return { entity_type: "", entity_id: "" };
}

function AgentContextReporter() {
  const pathname = usePathname();

  useEffect(() => {
    if (SHOWCASE) return; // 展示模式无后端，跳过上下文同步
    const controller = new AbortController();
    const entity = inferEntity(pathname);
    fetch(`${API_BASE}/api/agent/context`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope: "default",
        route: pathname,
        title: inferPageTitle(pathname),
        entity_type: entity.entity_type,
        entity_id: entity.entity_id,
        context: {
          reported_at: new Date().toISOString(),
        },
        updated_by: "ui",
      }),
      signal: controller.signal,
    }).catch(() => {
      // Context sync should never block the user's UI flow.
    });
    return () => controller.abort();
  }, [pathname]);

  return null;
}

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

  useEffect(() => {
    if (SHOWCASE) return; // 展示模式无 Python 后端，直接放行
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const probe = async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1200);
      try {
        const response = await fetch(`${API_BASE}/api/health`, {
          cache: "no-store",
          signal: controller.signal,
        });
        const payload = response.ok ? await response.json() : null;
        if (!cancelled && payload?.runtime === "python") {
          setReady(true);
          return;
        }
      } catch {
        // Desktop startup is expected to race the Python process once.
      } finally {
        clearTimeout(timeout);
      }
      if (!cancelled) retryTimer = setTimeout(probe, 180);
    };

    probe();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, []);

  if (!ready) {
    return (
      <div className="grid h-screen w-full place-items-center bg-[var(--background)] px-6">
        <div className="bauhaus-panel flex items-center gap-4 bg-[var(--surface)] px-6 py-5">
          <span className="h-5 w-5 animate-pulse bg-[var(--primary-red)]" aria-hidden="true" />
          <div>
            <p className="bauhaus-label text-[var(--foreground-muted)]">OfferU</p>
            <p className="text-sm font-semibold">正在启动 Python 工作台…</p>
          </div>
        </div>
      </div>
    );
  }

  return children;
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
          <AgentContextReporter />
          <OnboardingGate>
            {children}
          </OnboardingGate>
        </BackendReadyGate>
      </NextUIProvider>
    </SWRConfig>
  );
}
