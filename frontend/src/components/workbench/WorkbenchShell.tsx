"use client";

// =============================================
// 工作台外壳 (ADR 0031)
// 左:五阶段导航;中:阶段页面;右:上下文栏(详情/OfferU)。
// 简历深度编辑与面试房间自动进入专注模式,只保留最小控制条。
// =============================================

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeft, Bot } from "lucide-react";
import { Sidebar } from "@/components/layout/Sidebar";
import { WorkbenchProvider, useWorkbench } from "@/lib/workbench";
import { ContextRail } from "./ContextRail";
import { CommandPalette } from "./CommandPalette";
import { AgentPanel } from "./AgentPanel";

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

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ||
  (typeof window !== "undefined"
    ? `${window.location.protocol}//${window.location.hostname}:8000`
    : "http://127.0.0.1:8000");

function FocusTopBar({ rule }: { rule: FocusRule }) {
  const [agentOpen, setAgentOpen] = useState(false);

  return (
    <>
      <div className="sticky top-0 z-40 flex items-center justify-between border-b border-[var(--border)] bg-[var(--background)]/95 px-4 py-2 backdrop-blur">
        <Link
          href={rule.backHref}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[13px] font-medium text-[var(--foreground-soft)] transition-colors duration-[var(--dur-quick)] hover:bg-[var(--surface-muted)] hover:text-[var(--foreground)]"
        >
          <ArrowLeft size={14} strokeWidth={1.75} />
          {rule.backLabel}
        </Link>
        <p className="text-[12px] text-[var(--foreground-muted)]">专注模式</p>
        <button
          type="button"
          onClick={() => setAgentOpen((value) => !value)}
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

      {/* 专注模式下按需召回主 Agent — 浮层形式,关闭后完全退出 */}
      <AnimatePresence>
        {agentOpen && (
          <motion.div
            initial={{ opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 24 }}
            transition={{ type: "spring", stiffness: 400, damping: 34 }}
            className="fixed bottom-4 right-4 top-14 z-50 w-[min(92vw,340px)] overflow-hidden rounded-lg border border-[var(--border-strong)] bg-[var(--background)] shadow-[0_12px_36px_var(--shadow-medium)]"
          >
            <AgentPanel />
          </motion.div>
        )}
      </AnimatePresence>
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

  // 把当前选中对象同步给本地主 Agent。只上报显式声明的 agentContext，
  // 不序列化检查器里的编辑回调或完整业务对象。
  useEffect(() => {
    if (!selection) return;
    const controller = new AbortController();
    const agentContext =
      selection.data?.agentContext && typeof selection.data.agentContext === "object"
        ? selection.data.agentContext as Record<string, unknown>
        : {};
    fetch(`${API_BASE}/api/agent/context`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope: "default",
        route: pathname,
        title: selection.title,
        entity_type: selection.kind,
        entity_id: String(selection.id),
        context: {
          selected_object: {
            kind: selection.kind,
            title: selection.title,
            subtitle: selection.subtitle || "",
            ...agentContext,
          },
          reported_at: new Date().toISOString(),
        },
        updated_by: "ui",
      }),
      signal: controller.signal,
    }).catch(() => {
      // 上下文同步失败不能阻塞本地编辑。
    });
    return () => controller.abort();
  }, [pathname, selection]);

  if (focusRule?.bare) {
    return <>{children}</>;
  }

  if (focusRule) {
    return (
      <div className="flex h-screen w-full flex-col overflow-hidden">
        <FocusTopBar rule={focusRule} />
        <main className="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-4 md:px-6">
          {children}
        </main>
      </div>
    );
  }

  return (
    <div className="relative flex h-screen w-full overflow-hidden">
      <Sidebar />
      <main className="relative h-screen min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-5 pb-28 md:px-6 md:py-6 md:pb-8">
        <div className="mx-auto max-w-[1600px]">{children}</div>
      </main>
      <ContextRail />
      <CommandPalette />
    </div>
  );
}

export function WorkbenchShell({ children }: { children: React.ReactNode }) {
  return (
    <WorkbenchProvider>
      <WorkbenchFrame>{children}</WorkbenchFrame>
    </WorkbenchProvider>
  );
}
