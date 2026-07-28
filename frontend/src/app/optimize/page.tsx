"use client";

// =============================================
// 简历定制 — 材料阶段内的流程步骤 (ADR 0033)
// 收敛为紧凑工作区:去营销 Hero,规则一句话说明,直接进入定制流程。
// =============================================

import { useMemo } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { motion } from "framer-motion";
import { ArrowLeft } from "lucide-react";
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
          <Link
            href="/resume"
            className="flex items-center gap-1 text-[12px] font-medium text-[var(--foreground-muted)] transition-colors duration-[var(--dur-quick)] hover:text-[var(--foreground)]"
          >
            <ArrowLeft size={12} />
            材料
          </Link>
          <h1 className="mt-1 text-[22px] font-semibold tracking-tight text-[var(--foreground)]">
            简历定制
          </h1>
          <p className="mt-1 text-[12.5px] text-[var(--foreground-muted)]">
            调研 → 提案 → 审核 · 仅使用档案中已确认事实,接受后才创建正式简历。
          </p>
        </div>
        <div className="flex gap-2">
          <Link href="/jobs" className="bauhaus-button bauhaus-button-sm bauhaus-button-outline">
            去机会选岗
          </Link>
          <Link href="/profile" className="bauhaus-button bauhaus-button-sm bauhaus-button-outline">
            编辑档案
          </Link>
        </div>
      </header>

      <OptimizeWorkspace seedJobIds={workspaceSeedJobIds} />
    </motion.div>
  );
}
