"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { roleBenchmarkApi, type RoleBenchmarkDetail } from "@/lib/api";

export type JobWorkspaceOverviewStatus = "未开始" | "进行中" | "需要你审核" | "已完成";

type JobWorkspaceOverviewProps = {
  jobId: number;
  snapshotValue: string;
  snapshotDescription: string;
  roleTaskStatus?: string;
  materialStatus?: string;
  materialChangeCount?: number;
  materialFactGateStatus?: string;
  interviewTaskCount: number;
  interviewActive: boolean;
  interviewNeedsReview: boolean;
  timelineStage?: string;
  timelineCompleted?: boolean;
  timelineEventCount: number;
  timelineNextAction?: string;
};

type Panel = {
  name: "快照" | "岗位情报" | "证据对照" | "材料" | "面试" | "时间线";
  targetId: string;
  value: ReactNode;
  description: string;
  status: JobWorkspaceOverviewStatus;
};

function scrollToSection(targetId: string) {
  document.getElementById(targetId)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function taskStatus(status?: string): JobWorkspaceOverviewStatus {
  if (status === "queued" || status === "running" || status === "pending") return "进行中";
  if (status === "waiting_for_approval" || status === "failed" || status === "blocked") return "需要你审核";
  if (status === "completed" || status === "agent_turn_completed") return "已完成";
  return "未开始";
}

function statusClass(status: JobWorkspaceOverviewStatus) {
  if (status === "已完成") return "border-[var(--primary-green)]/30 bg-[var(--status-sage)] text-[var(--primary-green)]";
  if (status === "进行中" || status === "需要你审核") return "border-[var(--primary-yellow)]/50 bg-amber-50 text-amber-900";
  return "border-[var(--border)] bg-[var(--surface-muted)] text-[var(--foreground-muted)]";
}

function materialProjection(
  status?: string,
  factGateStatus?: string,
): { status: JobWorkspaceOverviewStatus; description: string } {
  if (!status) return { status: "未开始", description: "还没有岗位版简历候选。" };
  if (status === "accepted") return { status: "已完成", description: "岗位版简历已接受并保存。" };
  if (status === "rejected") return { status: "已完成", description: "候选已拒绝，原始简历保持不变。" };
  if (factGateStatus === "blocked" || status === "blocked") {
    return { status: "需要你审核", description: "有修改在档案里找不到证据，这些不会写进简历。" };
  }
  if (status === "ready" || status === "in_review") {
    return { status: "需要你审核", description: "AI 修改已准备好，等待你逐条接受或拒绝。" };
  }
  return { status: "进行中", description: "岗位材料仍在准备中。" };
}

export function JobWorkspaceOverview({
  jobId,
  snapshotValue,
  snapshotDescription,
  roleTaskStatus,
  materialStatus,
  materialChangeCount = 0,
  materialFactGateStatus,
  interviewTaskCount,
  interviewActive,
  interviewNeedsReview,
  timelineStage,
  timelineCompleted = false,
  timelineEventCount,
  timelineNextAction,
}: JobWorkspaceOverviewProps) {
  const [benchmark, setBenchmark] = useState<RoleBenchmarkDetail | null>(null);
  const [benchmarkLoading, setBenchmarkLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setBenchmarkLoading(true);
    void roleBenchmarkApi.forJob(jobId)
      .then((result) => {
        if (cancelled) return;
        setBenchmark(result.found === false || !result.run_id ? null : result);
      })
      .catch(() => {
        if (!cancelled) setBenchmark(null);
      })
      .finally(() => {
        if (!cancelled) setBenchmarkLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [jobId, roleTaskStatus]);

  const panels = useMemo<Panel[]>(() => {
    const signals = benchmark?.signals || [];
    const supportedCount = signals.filter((signal) => signal.evidence_gap?.status === "supported").length;
    const gapCount = signals.filter((signal) => ["partial", "missing"].includes(signal.evidence_gap?.status || "")).length;

    const roleStatus: JobWorkspaceOverviewStatus = benchmark?.status === "completed"
      ? "已完成"
      : benchmark?.status === "pending" || benchmark?.status === "running"
        ? "进行中"
        : benchmark?.status === "failed" || benchmark?.status === "blocked"
          ? "需要你审核"
          : taskStatus(roleTaskStatus);

    const roleValue = benchmark?.status === "completed"
      ? `${benchmark.valid_sample_count ?? 0} 个参考岗位`
      : benchmarkLoading && !benchmark
        ? "正在读取状态"
        : roleStatus === "进行中"
          ? "正在分析"
          : roleStatus === "需要你审核"
            ? "任务需要处理"
            : "尚未生成";

    const roleDescription = benchmark?.status === "completed"
      ? benchmark.sample_sufficient === false
        ? "相似岗位样本不够，先不下「大家都要 / 这家特别看重」的结论。"
        : `来自 ${benchmark.company_count ?? 0} 家公司：哪些是共性要求，哪些是这家特别看重的。`
      : "收集相似岗位后，会分出共性要求和这家特别看重的能力。";

    const evidenceStatus: JobWorkspaceOverviewStatus = benchmark?.status === "completed"
      ? gapCount > 0
        ? "进行中"
        : signals.length > 0
          ? "已完成"
          : "未开始"
      : roleStatus === "已完成"
        ? "未开始"
        : roleStatus;

    const material = materialProjection(materialStatus, materialFactGateStatus);

    const interviewStatus: JobWorkspaceOverviewStatus = interviewNeedsReview
      ? "需要你审核"
      : interviewActive
        ? "进行中"
        : interviewTaskCount > 0
          ? "已完成"
          : "未开始";

    const interviewDescription = interviewNeedsReview
      ? "复盘里总结出的经验等你确认，确认后才会写进档案。"
      : interviewActive
        ? "正在准备或复盘。"
        : interviewTaskCount > 0
          ? "已有面试准备或复盘记录。"
          : "收到面试邀请后，会针对缺口出题练习。";

    const timelineStatus: JobWorkspaceOverviewStatus = timelineCompleted
      ? "已完成"
      : timelineEventCount > 0 || timelineStage
        ? "进行中"
        : "未开始";

    return [
      {
        name: "快照",
        targetId: "job-snapshot",
        value: snapshotValue,
        description: snapshotDescription,
        status: "已完成",
      },
      {
        name: "岗位情报",
        targetId: "role-intelligence-panel",
        value: roleValue,
        description: roleDescription,
        status: roleStatus,
      },
      {
        name: "证据对照",
        targetId: "evidence-map",
        value: benchmark?.status === "completed" ? (
          <>
            <span className="text-[var(--primary-green)]">能证明 {supportedCount} 项</span>
            <span className="text-[var(--foreground-muted)]"> · </span>
            <span className="text-amber-800">待准备 {gapCount} 项</span>
          </>
        ) : "等待岗位情报",
        description: benchmark?.status === "completed"
          ? gapCount > 0
            ? "绿色是档案里有证据的要求，琥珀色是下一步要准备的。"
            : "这个岗位看重的能力，你的档案里都有证据。"
          : "岗位情报出来后，会和你的档案逐条对照。",
        status: evidenceStatus,
      },
      {
        name: "材料",
        targetId: "materials",
        value: materialChangeCount > 0 ? `${materialChangeCount} 条候选修改` : "尚无候选版本",
        description: material.description,
        status: material.status,
      },
      {
        name: "面试",
        targetId: "interview",
        value: interviewTaskCount > 0 ? `${interviewTaskCount} 场面试` : "还没有面试",
        description: interviewDescription,
        status: interviewStatus,
      },
      {
        name: "时间线",
        targetId: "timeline",
        value: timelineStage || "还没投递",
        description: timelineNextAction
          ? `下一步：${timelineNextAction}`
          : timelineEventCount > 0
            ? `${timelineEventCount} 条已确认的进展。`
            : "只记录确认过的进展，不靠猜。",
        status: timelineStatus,
      },
    ];
  }, [
    benchmark,
    benchmarkLoading,
    interviewActive,
    interviewNeedsReview,
    interviewTaskCount,
    materialChangeCount,
    materialFactGateStatus,
    materialStatus,
    roleTaskStatus,
    snapshotDescription,
    snapshotValue,
    timelineCompleted,
    timelineEventCount,
    timelineNextAction,
    timelineStage,
  ]);

  return (
    <section aria-labelledby="job-workspace-overview-heading" data-testid="job-workspace-overview">
      <div className="mb-3 flex items-end justify-between gap-3">
        <div>
          <h2 id="job-workspace-overview-heading" className="mt-1 text-xl font-black tracking-[-0.04em] text-[var(--foreground)]">
            这个岗位的工作区
          </h2>
        </div>
        <p className="hidden max-w-md text-right text-xs font-medium leading-relaxed text-[var(--foreground-muted)] md:block">
          一个 Job → 岗位要求 × 可验证证据 → 下一步准备什么
        </p>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {panels.map((panel) => (
          <button
            key={panel.name}
            type="button"
            aria-label={`打开 ${panel.name}`}
            onClick={() => scrollToSection(panel.targetId)}
            className="bauhaus-panel-sm group min-h-[154px] bg-white p-4 text-left transition-transform hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary-yellow)]"
          >
            <div className="flex items-start justify-between gap-3">
              <span className="bauhaus-label text-[var(--foreground-muted)]">{panel.name}</span>
              <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold ${statusClass(panel.status)}`}>
                {panel.status}
              </span>
            </div>
            <div className="mt-5 text-xl font-black tracking-[-0.04em] text-[var(--foreground)]">
              {panel.value}
            </div>
            <p className="mt-2 text-xs font-medium leading-relaxed text-[var(--foreground-muted)]">
              {panel.description}
            </p>
            <span className="mt-4 inline-flex text-[11px] font-bold text-[var(--foreground-soft)] transition-colors group-hover:text-[var(--foreground)]">
              查看详情 ↓
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
