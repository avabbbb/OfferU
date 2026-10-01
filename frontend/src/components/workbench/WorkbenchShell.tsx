"use client";

// =============================================
// 工作台外壳 (ADR 0031)
// 左:五阶段导航;中:阶段页面;右:上下文栏(详情/OfferU)。
// 简历深度编辑与面试房间自动进入专注模式,只保留最小控制条。
// =============================================

import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ArrowLeft, Bot } from "lucide-react";
import { Sidebar } from "@/components/layout/Sidebar";
import { OnboardingGate } from "@/components/onboarding/OnboardingGate";
import { WorkbenchProvider, useWorkbench } from "@/lib/workbench";
import { AgentConnectionProvider } from "@/lib/agentConnection";
import { AgentConnectionDialog, AgentConnectionStatus } from "./AgentConnectionPanel";
import { PendingProposalReview } from "./PendingProposalReview";
import { resolveApiBase } from "@/lib/apiBase";

const API_BASE = resolveApiBase();

const ContextRail = lazy(() =>
  import("./ContextRail").then((module) => ({ default: module.ContextRail })),
);
const CommandPalette = lazy(() =>
  import("./CommandPalette").then((module) => ({ default: module.CommandPalette })),
);

interface FocusRule {
  pattern: RegExp;
  /** 返回入口(专注模式最小控制条) */
  backHref: string;
  backLabel: string;
  /** 完全裸渲染(打印页):连最小控制条也不要 */
  bare?: boolean;
}

const FOCUS_RULES: FocusRule[] = [
  { pattern: /^\/resume\/print\//, backHref: "/resume", backLabel: "返回材料", bare: true },
  { pattern: /^\/resume\/\d+/, backHref: "/resume", backLabel: "返回材料" },
  { pattern: /^\/interview\/ai(\/|$)/, backHref: "/interview", backLabel: "返回面试" },
  { pattern: /^\/interview\/pose(\/|$)/, backHref: "/interview", backLabel: "返回面试" },
];

function FocusTopBar({ rule }: { rule: FocusRule }) {
  const { railMode, railOpen, setRailMode, setRailOpen } = useWorkbench();
  const agentOpen = railMode === "agent" && railOpen;

  return (
    <>
      <div className="offeru-focus-topbar sticky top-0 z-40 flex items-center justify-between border-b border-[var(--border)] bg-[var(--background)]/95 px-4 py-2 backdrop-blur">
        <Link
          href={rule.backHref}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[13px] font-medium text-[var(--foreground-soft)] transition-colors duration-[var(--dur-quick)] hover:bg-[var(--surface-muted)] hover:text-[var(--foreground)]"
        >
          <ArrowLeft size={14} strokeWidth={1.75} />
          {rule.backLabel}
        </Link>
        <AgentConnectionStatus compact />
        <button
          type="button"
          onClick={() => { setRailMode("agent"); setRailOpen(!agentOpen); }}
          aria-pressed={agentOpen}
          className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-[13px] font-medium transition-colors duration-[var(--dur-quick)] ${
            agentOpen
              ? "bg-[var(--surface-muted)] text-[var(--foreground)]"
              : "text-[var(--foreground-soft)] hover:bg-[var(--surface-muted)] hover:text-[var(--foreground)]"
          }`}
        >
          <Bot size={14} strokeWidth={1.75} />
          OfferU
        </button>
      </div>

    </>
  );
}

function WorkbenchFrame({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { clearSelection, selection } = useWorkbench();

  const focusRule = useMemo(
    () => FOCUS_RULES.find((rule) => rule.pattern.test(pathname)) ?? null,
    [pathname]
  );

  // 切换页面时清掉上一页的选中对象,避免检查器显示陈旧内容
  useEffect(() => {
    clearSelection();
  }, [pathname, clearSelection]);

  // Context writes are owned by AgentConnectionProvider (agentConnection.tsx).
  // Selection changes flow through `useWorkbench().selection` into that single
  // serialized writer — this component never writes directly.

  if (focusRule?.bare) {
    return <>{children}</>;
  }

  if (focusRule) {
    return (
      <>
        <div className="offeru-focus-shell offeru-viewport-shell flex w-full flex-col overflow-hidden">
          <FocusTopBar rule={focusRule} />
          <main className="workbench-main relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-4 md:px-6">
            {children}
          </main>
        </div>
        <PendingProposalReview />
      </>
    );
  }

  return (
    <>
      <div className="offeru-workbench-shell offeru-viewport-shell relative flex w-full overflow-hidden">
        <Sidebar />
        <main className="workbench-main relative h-full min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-5 pb-40 md:px-6 md:py-6 md:pb-24">
          <div className="mx-auto max-w-[1600px]">{children}</div>
        </main>
        {pathname !== "/settings" && <div className="fixed bottom-[72px] left-4 z-40 max-w-[calc(100vw-2rem)] md:hidden">
          <AgentConnectionStatus compact />
        </div>}
        <Suspense fallback={null}>
          <CommandPalette />
        </Suspense>
      </div>
      <PendingProposalReview />
    </>
  );
}

export function WorkbenchShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const focus = FOCUS_RULES.some((rule) => rule.pattern.test(pathname));
  return (
    <WorkbenchProvider>
      <AgentConnectionProvider>
        <WorkbenchFrame>
          <OnboardingGate>{children}</OnboardingGate>
        </WorkbenchFrame>
        {!/^\/resume\/print\//.test(pathname) && <Suspense fallback={null}><ContextRail focus={focus} /></Suspense>}
        <AgentConnectionDialog />
      </AgentConnectionProvider>
    </WorkbenchProvider>
  );
}
