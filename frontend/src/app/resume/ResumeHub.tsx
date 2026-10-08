"use client";

// =============================================
// 简历 — 唯一入口
// 原来的「简历」「简历定制」「工作室」三个侧边栏入口合并为一个子功能：
//   我的简历（list） · 岗位定制（tailor） · 版式（layout）
// 模式写在 URL 上（?mode=），刷新、后退、分享链接都能回到同一处；
// 切换模式从不打断别处正在跑的任务，也不需要确认。
// =============================================

import { lazy, Suspense } from "react";
import { Link as RouterLink, useLocation } from "react-router-dom";
import { QuietHint } from "@/components/hints";
import { RESUME_MODES, parseResumeMode, resumeModeHref } from "./resumeModes";

const ResumesListPage = lazy(() => import("./page"));
const OptimizePage = lazy(() => import("@/app/optimize/page"));
const StudioPage = lazy(() => import("@/app/studio/page"));

function ModeFallback() {
  return (
    <div className="grid min-h-[30vh] place-items-center">
      <p className="text-sm text-[var(--foreground-muted)]">正在打开…</p>
    </div>
  );
}

export default function ResumeHub() {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const mode = parseResumeMode(params.get("mode"));

  return (
    <div className="resume-hub space-y-5" data-testid="resume-hub" data-mode={mode}>
      <nav
        aria-label="简历模式"
        className="flex flex-wrap items-center gap-1 border-b border-[#e8e6dc] px-1"
      >
        {RESUME_MODES.map((item) => {
          const active = item.id === mode;
          return (
            <span key={item.id} className="inline-flex items-center gap-1.5">
              <RouterLink
                to={resumeModeHref(item.id, location.search)}
                aria-current={active ? "page" : undefined}
                className={`-mb-px border-b-2 px-3 py-2 text-[13px] transition-colors ${
                  active
                    ? "border-[#1B365D] font-semibold text-[#1B365D]"
                    : "border-transparent text-[var(--foreground-muted)] hover:text-[var(--foreground)]"
                }`}
              >
                {item.label}
              </RouterLink>
              <QuietHint label={`${item.label}是做什么的？`}>{item.hint}</QuietHint>
            </span>
          );
        })}
      </nav>

      <Suspense fallback={<ModeFallback />}>
        {mode === "tailor" ? <OptimizePage /> : mode === "layout" ? <StudioPage /> : <ResumesListPage />}
      </Suspense>
    </div>
  );
}
