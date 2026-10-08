"use client";

// =============================================
// 岗位定制 — 「简历」子功能的 tailor 模式（原 /optimize，ADR 0033）
// 收敛为紧凑工作区:去营销 Hero,规则一句话说明,直接进入定制流程。
// =============================================

import { useMemo } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { motion } from "framer-motion";
import { OptimizeWorkspace } from "./components/OptimizeWorkspace";

export default function OptimizePage() {
  const searchParams = useSearchParams();
  const workspaceSeedJobIds = useMemo(() => {
    const raw = searchParams.get("job_ids");
    if (!raw) return [];
    return Array.from(
      new Set(
        raw
          .split(",")
          .map((part) => Number(part.trim()))
          .filter((id) => Number.isFinite(id) && id > 0)
      )
    );
  }, [searchParams]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 420, damping: 32 }}
      className="space-y-4"
    >
      <header className="flex flex-wrap items-end justify-between gap-3 px-1">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight text-[var(--foreground)]">岗位定制</h1>
          <p className="mt-1 text-[13px] text-[var(--foreground-muted)]">选一个岗位，AI 用你档案里已确认的事实提出修改，你逐条决定。</p>
        </div>
        <Link href="/profile" className="text-[13px] font-medium text-[var(--foreground-muted)] underline-offset-4 hover:text-[var(--foreground)] hover:underline">
          编辑档案
        </Link>
      </header>

      <OptimizeWorkspace seedJobIds={workspaceSeedJobIds} />
    </motion.div>
  );
}
