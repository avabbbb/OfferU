"use client";

// =============================================
// 今日 — 今日行动队列 (ADR 0030 / 0033)
// 主体:待确认信号、临近日程、建议下一步。
// 统计指标与趋势按需展开,不占据默认首屏;品牌叙事只出现在真实空状态。
// =============================================

import { lazy, Suspense, useMemo, useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import {
  ArrowRight,
  BarChart3,
  Briefcase,
  Calendar,
  ChevronDown,
  Inbox,
  Mail,
  Sparkles,
} from "lucide-react";
import {
  OnboardingChecklist,
  OnboardingTriggerButton,
} from "@/components/onboarding/OnboardingChecklist";
import {
  useAutomationInbox,
  useCalendarEvents,
  useJobs,
  useJobStats,
  useJobTrend,
  useNotifications,
  useProgressBoard,
  useProgressCandidates,
} from "@/lib/hooks";
import { useWorkbench } from "@/lib/workbench";

const TrendChart = lazy(() =>
  import("@/components/charts/TrendChart").then((module) => ({
    default: module.TrendChart,
  })),
);

const container = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.04, delayChildren: 0.05 } },
};

const item = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { type: "spring", stiffness: 420, damping: 30 } },
};

function toDateInput(date: Date) {
  return date.toISOString().slice(0, 10);
}

function formatEventTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function automationCategoryLabel(category: string) {
  return {
    needs_approval: "需要确认",
    needs_review: "需要复核",
    fyi: "已完成",
    completed: "已完成",
    failed: "执行失败",
  }[category] ?? category;
}

const APPLICATION_STAGE_LABELS: Record<string, string> = {
  saved: "已保存",
  preparing: "准备中",
  ready: "待投递",
  prepared: "待投递",
  applied: "已投递",
  written_test: "笔试",
  assessment: "测评",
  interview_1: "一面",
  interview_2: "二面/终面",
  interview_hr: "HR 面",
  offer: "Offer",
  rejected: "已结束",
};

const INTERVIEW_STAGES = new Set(["interview_1", "interview_2", "interview_hr"]);

function applicationStageLabel(stage: string) {
  return APPLICATION_STAGE_LABELS[stage] ?? (stage || "未知");
}

function isInterviewStage(stage: string) {
  return INTERVIEW_STAGES.has(stage);
}

function pipelinePriorityLabel(record: {
  current_stage: string;
  pending_candidates: number;
  upcoming_interview: unknown;
}) {
  if (record.pending_candidates > 0) return "待审核";
  if (record.upcoming_interview) return "临近面试";
  if (isInterviewStage(record.current_stage)) return "面试准备";
  return "";
}

function SectionHeader({
  icon: Icon,
  title,
  count,
  href,
  hrefLabel,
}: {
  icon: typeof Inbox;
  title: string;
  count?: number;
  href?: string;
  hrefLabel?: string;
}) {
  return (
    <div className="flex items-center justify-between px-1 pb-2">
      <div className="flex items-center gap-2">
        <Icon size={14} strokeWidth={1.75} className="text-[var(--foreground-muted)]" />
        <h2 className="text-[13px] font-semibold text-[var(--foreground)]">{title}</h2>
        {typeof count === "number" && count > 0 && (
          <span className="rounded-full bg-[var(--surface-hover)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--foreground-soft)]">
            {count}
          </span>
        )}
      </div>
      {href && (
        <Link
          href={href}
          className="flex items-center gap-1 text-[12px] font-medium text-[var(--foreground-muted)] transition-colors duration-[var(--dur-quick)] hover:text-[var(--foreground)]"
        >
          {hrefLabel ?? "查看全部"}
          <ArrowRight size={12} />
        </Link>
      )}
    </div>
  );
}

export default function TodayPage() {
  const { select } = useWorkbench();
  const [statsExpanded, setStatsExpanded] = useState(false);

  const range = useMemo(() => {
    const start = new Date();
    const end = new Date();
    end.setDate(end.getDate() + 7);
    return { start: toDateInput(start), end: toDateInput(end) };
  }, []);

  const { data: events } = useCalendarEvents(range.start, range.end);
  const { data: notifications } = useNotifications();
  const { data: automationInbox } = useAutomationInbox();
  const { data: jobsData } = useJobs({ page: 1, period: "week" });
  const { data: stats } = useJobStats("week");
  const { data: trendData } = useJobTrend("week");
  const {
    data: pipeline,
    error: pipelineError,
    isLoading: pipelineLoading,
  } = useProgressBoard("active");
  const {
    data: progressCandidates,
    error: progressCandidatesError,
    isLoading: progressCandidatesLoading,
  } = useProgressCandidates("pending", 6);

  const pendingSignals = useMemo(
    () => (notifications ?? []).filter((n) => Boolean(n.action_required)).slice(0, 6),
    [notifications]
  );
  const pendingAutomation = useMemo(
    () => (automationInbox?.items ?? []).filter((entry) => entry.status === "pending").slice(0, 5),
    [automationInbox],
  );
  const pipelineRecords = useMemo(
    () =>
      (pipeline?.companies ?? [])
        .flatMap((company) => company.records)
        .sort((left, right) => {
          const leftPriority = left.pending_candidates > 0
            ? 0
            : left.upcoming_interview
              ? 1
              : isInterviewStage(left.current_stage)
                ? 2
                : 3;
          const rightPriority = right.pending_candidates > 0
            ? 0
            : right.upcoming_interview
              ? 1
              : isInterviewStage(right.current_stage)
                ? 2
                : 3;
          if (leftPriority !== rightPriority) return leftPriority - rightPriority;
          return String(right.last_event_at ?? "").localeCompare(String(left.last_event_at ?? ""));
        })
        .slice(0, 6),
    [pipeline],
  );
  const upcomingEvents = useMemo(() => (events ?? []).slice(0, 6), [events]);
  const recentJobs = useMemo(() => (jobsData?.items ?? []).slice(0, 5), [jobsData]);
  const pendingProgress = progressCandidates?.items ?? [];
  const pendingProgressCount = pipeline?.summary.pending_review ?? progressCandidates?.total ?? 0;

  const today = new Date();
  const dateLabel = today.toLocaleDateString("zh-CN", {
    month: "long",
    day: "numeric",
    weekday: "long",
  });

  const isEmptyWorkspace =
    pendingSignals.length === 0
    && pendingAutomation.length === 0
    && pipelineLoading === false
    && pipelineRecords.length === 0
    && pendingProgress.length === 0
    && upcomingEvents.length === 0
    && recentJobs.length === 0;

  return (
    <motion.div variants={container} initial="hidden" animate="show" className="stage-page stage-page--today mx-auto max-w-[860px] space-y-6">
      {/* 页头:紧凑,不做 Hero */}
      <motion.header variants={item} className="flex items-end justify-between px-1">
        <div>
          <p className="text-[12px] font-medium text-[var(--foreground-muted)]">{dateLabel}</p>
          <h1 className="mt-1 text-[22px] font-semibold tracking-tight text-[var(--foreground)]">今日</h1>
        </div>
        <OnboardingTriggerButton />
      </motion.header>

      <motion.div variants={item}>
        <OnboardingChecklist hasJobs={Boolean(jobsData?.items?.length)} />
      </motion.div>

      {/* 后台自动化收件箱：只呈现候选/提案，不在首页静默提交外部操作 */}
      <motion.section variants={item}>
        <SectionHeader
          icon={Inbox}
          title="OfferU 自动工作"
          count={pendingAutomation.length}
        />
        <div className="bauhaus-panel-sm divide-y divide-[var(--border)] overflow-hidden">
          {pendingAutomation.length === 0 && (
            <p className="px-4 py-4 text-[13px] text-[var(--foreground-muted)]">
              暂无需要你处理的后台任务。
            </p>
          )}
          {pendingAutomation.map((entry) => {
            const benchmark = entry.payload?.benchmark as Record<string, any> | undefined;
            const packet = entry.payload?.application_packet as Record<string, any> | undefined;
            const sample = benchmark?.valid_sample_count;
            return (
              <button
                key={entry.item_id}
                type="button"
                onClick={() =>
                  select({
                    kind: "task",
                    id: entry.item_id,
                    title: entry.title,
                    subtitle: [automationCategoryLabel(entry.category), entry.target_type && entry.target_id
                      ? `${entry.target_type} #${entry.target_id}`
                      : ""].filter(Boolean).join(" · "),
                    data: {
                      fields: [
                        { label: "状态", value: automationCategoryLabel(entry.category) },
                        { label: "说明", value: entry.body },
                        { label: "有效样本", value: sample == null ? "-" : String(sample) },
                        { label: "Benchmark", value: String(benchmark?.data_mode || "-") },
                        { label: "Application Packet", value: String(packet?.status || "-") },
                        { label: "Task", value: entry.task_id || "-" },
                      ],
                      fullscreenHref:
                        entry.target_type === "job" && entry.target_id
                          ? `/jobs/${entry.target_id}`
                          : undefined,
                    },
                  })
                }
                className="press-feedback flex w-full items-center gap-3 px-4 py-2.5 text-left"
              >
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                    entry.category === "failed"
                      ? "bg-[var(--primary-red)]"
                      : entry.category === "needs_approval"
                        ? "bg-[var(--primary-yellow)]"
                        : "bg-[var(--primary-blue)]"
                  }`}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium text-[var(--foreground)]">
                    {entry.title}
                  </span>
                  <span className="mt-0.5 block truncate text-[12px] text-[var(--foreground-muted)]">
                    {[automationCategoryLabel(entry.category), sample == null ? "" : `${sample} 个有效样本`]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </span>
                <ArrowRight size={13} className="shrink-0 text-[var(--foreground-faint)]" />
              </button>
            );
          })}
        </div>
      </motion.section>

      {(pendingProgressCount > 0 || pendingProgress.length > 0) && (
        <motion.section variants={item}>
          <SectionHeader
            icon={Inbox}
            title="待确认进展"
            count={pendingProgressCount}
            href="/applications?view=board"
            hrefLabel="去审核"
          />
          <div className="bauhaus-panel-sm divide-y divide-[var(--border)] overflow-hidden">
            {progressCandidatesError && (
              <p className="px-4 py-4 text-[13px] text-[var(--primary-red)]">
                待确认进展暂时无法读取：请进入进展页重试。
              </p>
            )}
            {!progressCandidatesError && progressCandidatesLoading && (
              <p className="px-4 py-4 text-[13px] text-[var(--foreground-muted)]">
                正在读取待确认进展…
              </p>
            )}
            {!progressCandidatesError && !progressCandidatesLoading && pendingProgress.length === 0 && (
              <p className="px-4 py-4 text-[13px] text-[var(--foreground-muted)]">
                待确认进展已更新，请进入进展页查看最新列表。
              </p>
            )}
            {pendingProgress.map((candidate) => {
              const application = candidate.application;
              const stage = applicationStageLabel(candidate.suggested_stage);
              const subject = candidate.signal.subject || candidate.signal.sender || "未命名进展";
              return (
                <button
                  key={candidate.candidate_id}
                  type="button"
                  onClick={() =>
                    select({
                      kind: "task",
                      id: candidate.candidate_id,
                      title: subject,
                      subtitle: [
                        application ? `${application.company} · ${application.job_title}` : "尚未关联投递",
                        `建议阶段：${stage}`,
                      ].join(" · "),
                      data: {
                        fields: [
                          { label: "状态", value: "待确认", emphasis: true },
                          { label: "建议阶段", value: stage },
                          {
                            label: "关联投递",
                            value: application
                              ? `${application.company} · ${application.job_title}`
                              : "尚未关联",
                          },
                          { label: "来源", value: `${candidate.signal.channel} · ${candidate.signal.sender}` },
                          {
                            label: "收到时间",
                            value: candidate.signal.received_at
                              ? formatEventTime(candidate.signal.received_at)
                              : "-",
                          },
                          { label: "候选 ID", value: candidate.candidate_id },
                        ],
                        fullscreenHref: "/applications?view=board",
                      },
                    })
                  }
                  className="press-feedback flex w-full items-center gap-3 px-4 py-2.5 text-left"
                >
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--primary-yellow)]" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium text-[var(--foreground)]">
                      {subject}
                    </span>
                    <span className="mt-0.5 block truncate text-[12px] text-[var(--foreground-muted)]">
                      {[application ? `${application.company} · ${application.job_title}` : "尚未关联投递", `建议${stage}`]
                        .join(" · ")}
                    </span>
                  </span>
                  <span className="shrink-0 text-[11px] font-medium text-[var(--primary-yellow)]">待确认</span>
                  <ArrowRight size={13} className="shrink-0 text-[var(--foreground-faint)]" />
                </button>
              );
            })}
          </div>
          {pendingProgressCount > pendingProgress.length && (
            <p className="mt-2 px-1 text-[12px] text-[var(--foreground-muted)]">
              仅显示最近 {pendingProgress.length} 条，进入进展页审核全部 {pendingProgressCount} 条候选。
            </p>
          )}
        </motion.section>
      )}

      {/* Pipeline: 与投递看板共享同一份状态投影，不在 Today 维护副本 */}
      <motion.section variants={item}>
        <SectionHeader
          icon={Briefcase}
          title="Pipeline"
          count={pipeline?.total_records}
          href="/applications?view=board"
          hrefLabel="进展"
        />
        <div className="bauhaus-panel-sm divide-y divide-[var(--border)] overflow-hidden">
          {pipelineError && (
            <p className="px-4 py-4 text-[13px] text-[var(--primary-red)]">
              Pipeline 暂时无法读取：{pipelineError instanceof Error ? pipelineError.message : "请稍后重试"}
            </p>
          )}
          {!pipelineError && pipelineLoading && (
            <p className="px-4 py-4 text-[13px] text-[var(--foreground-muted)]">正在读取投递进度…</p>
          )}
          {!pipelineError && !pipelineLoading && pipelineRecords.length === 0 && (
            <p className="px-4 py-4 text-[13px] text-[var(--foreground-muted)]">暂无进行中的投递。</p>
          )}
          {pipelineRecords.map((record) => {
            const stage = applicationStageLabel(record.current_stage);
            const interview = record.upcoming_interview;
            const priorityLabel = pipelinePriorityLabel(record);
            return (
              <button
                key={record.application_attempt_id ?? `job-${record.job_id}`}
                type="button"
                onClick={() =>
                  select({
                    kind: "application",
                    id: record.application_attempt_id ?? record.job_id,
                    title: `${record.company} · ${record.job_title}`,
                    subtitle: [stage, record.next_action].filter(Boolean).join(" · "),
                    data: {
                      fields: [
                        { label: "公司", value: record.company, emphasis: true },
                        { label: "岗位", value: record.job_title },
                        { label: "状态", value: stage, emphasis: true },
                        { label: "下一动作", value: record.next_action || "-" },
                        {
                          label: "最近更新",
                          value: record.last_event_at ? formatEventTime(record.last_event_at) : "-",
                        },
                        {
                          label: "面试",
                          value: interview
                            ? `${interview.title} · ${formatEventTime(interview.start_time)}`
                            : "-",
                        },
                        { label: "待确认", value: String(record.pending_candidates) },
                      ],
                      fullscreenHref: `/jobs/${record.job_id}`,
                    },
                  })
                }
                className="press-feedback flex w-full items-center gap-3 px-4 py-2.5 text-left"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium text-[var(--foreground)]">
                    {record.company} · {record.job_title}
                  </span>
                  <span className="mt-0.5 block truncate text-[12px] text-[var(--foreground-muted)]">
                    {[stage, record.next_action, interview ? `面试 ${formatEventTime(interview.start_time)}` : ""]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </span>
                {priorityLabel && (
                  <span className="shrink-0 rounded-full bg-[var(--primary-blue)]/10 px-2 py-0.5 text-[11px] font-medium text-[var(--primary-blue)]">
                    {priorityLabel}
                  </span>
                )}
                {record.pending_candidates > 0 && (
                  <span className="shrink-0 rounded-full bg-[var(--primary-yellow)]/15 px-2 py-0.5 text-[11px] font-medium text-[var(--primary-yellow)]">
                    {record.pending_candidates} 待确认
                  </span>
                )}
                <ArrowRight size={13} className="shrink-0 text-[var(--foreground-faint)]" />
              </button>
            );
          })}
        </div>
        {(pipeline?.summary?.pending_review ?? 0) > 0 && (
          <p className="mt-2 px-1 text-[12px] text-[var(--foreground-muted)]">
            还有 {pipeline?.summary?.pending_review ?? 0} 条进展候选待确认，确认后才会改变正式状态。
          </p>
        )}
      </motion.section>

      {/* 待确认信号 */}
      <motion.section variants={item}>
        <SectionHeader
          icon={Mail}
          title="待确认信号"
          count={pendingSignals.length}
          href="/email"
          hrefLabel="信号收件箱"
        />
        <div className="bauhaus-panel-sm divide-y divide-[var(--border)] overflow-hidden">
          {pendingSignals.length === 0 && (
            <p className="px-4 py-4 text-[13px] text-[var(--foreground-muted)]">
              暂无待确认的外部进展信号。
            </p>
          )}
          {pendingSignals.map((signal) => (
            <button
              key={signal.id}
              type="button"
              onClick={() =>
                select({
                  kind: "task",
                  id: `signal-${signal.id}`,
                  title: signal.action_required || signal.email_subject,
                  subtitle: [signal.company, signal.position].filter(Boolean).join(" · "),
                  data: {
                    fields: [
                      { label: "类型", value: signal.category_display || signal.category },
                      { label: "来件", value: signal.email_from },
                      { label: "主题", value: signal.email_subject },
                      { label: "面试时间", value: signal.interview_time || "-" },
                      { label: "地点", value: signal.location || "-" },
                      { label: "解析于", value: signal.parsed_at },
                    ],
                    fullscreenHref: "/email",
                  },
                })
              }
              className="press-feedback flex w-full items-center gap-3 px-4 py-2.5 text-left"
            >
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--primary-red)]" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-[var(--foreground)]">
                  {signal.action_required || signal.email_subject}
                </span>
                <span className="mt-0.5 block truncate text-[12px] text-[var(--foreground-muted)]">
                  {[signal.company, signal.position, signal.category_display].filter(Boolean).join(" · ")}
                </span>
              </span>
              <ArrowRight size={13} className="shrink-0 text-[var(--foreground-faint)]" />
            </button>
          ))}
        </div>
      </motion.section>

      {/* 临近日程 */}
      <motion.section variants={item}>
        <SectionHeader
          icon={Calendar}
          title="未来 7 天日程"
          count={upcomingEvents.length}
          href="/calendar"
          hrefLabel="日程"
        />
        <div className="bauhaus-panel-sm divide-y divide-[var(--border)] overflow-hidden">
          {upcomingEvents.length === 0 && (
            <p className="px-4 py-4 text-[13px] text-[var(--foreground-muted)]">近 7 天没有安排。</p>
          )}
          {upcomingEvents.map((event) => (
            <button
              key={event.id}
              type="button"
              onClick={() =>
                select({
                  kind: "event",
                  id: event.id,
                  title: event.title,
                  subtitle: formatEventTime(event.start_time),
                  data: {
                    fields: [
                      { label: "类型", value: event.event_type },
                      { label: "开始", value: formatEventTime(event.start_time), emphasis: true },
                      { label: "结束", value: event.end_time ? formatEventTime(event.end_time) : "-" },
                      { label: "地点", value: event.location || "-" },
                      { label: "备注", value: event.description || "-" },
                    ],
                  },
                })
              }
              className="press-feedback flex w-full items-center gap-3 px-4 py-2.5 text-left"
            >
              <span className="w-[7.5rem] shrink-0 text-[12px] font-medium tabular-nums text-[var(--foreground-soft)]">
                {formatEventTime(event.start_time)}
              </span>
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--foreground)]">
                {event.title}
              </span>
              {event.location && (
                <span className="max-w-[10rem] shrink-0 truncate text-[12px] text-[var(--foreground-muted)]">
                  {event.location}
                </span>
              )}
            </button>
          ))}
        </div>
      </motion.section>

      {/* 建议下一步:本周新岗位 */}
      <motion.section variants={item}>
        <SectionHeader
          icon={Briefcase}
          title="本周新机会"
          count={recentJobs.length}
          href="/jobs"
          hrefLabel="机会"
        />
        <div className="bauhaus-panel-sm divide-y divide-[var(--border)] overflow-hidden">
          {recentJobs.length === 0 && (
            <div className="px-4 py-6 text-center">
              <p className="text-[13px] font-medium text-[var(--foreground)]">还没有岗位数据</p>
              <p className="mt-1 text-[12px] leading-5 text-[var(--foreground-muted)]">
                先保存一个目标岗位，OfferU 会从岗位描述开始准备后续材料。
              </p>
              <div className="mt-3 flex justify-center gap-2">
                <Link href="/jobs" className="bauhaus-button bauhaus-button-sm bauhaus-button-red">
                  保存第一个岗位
                </Link>
              </div>
            </div>
          )}
          {recentJobs.map((job) => (
            <button
              key={job.id}
              type="button"
              onClick={() =>
                select({
                  kind: "job",
                  id: job.id,
                  title: job.title,
                  subtitle: job.company,
                  data: {
                    fields: [
                      { label: "公司", value: job.company, emphasis: true },
                      { label: "地点", value: job.location || "-" },
                      { label: "薪资", value: job.salary_text || "-" },
                      { label: "来源", value: job.source || "-" },
                      {
                        label: "关键词",
                        value: (job.keywords ?? []).slice(0, 6).join(" / ") || "-",
                      },
                    ],
                  },
                })
              }
              className="press-feedback flex w-full items-center gap-3 px-4 py-2.5 text-left"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-[var(--foreground)]">
                  {job.title}
                </span>
                <span className="mt-0.5 block truncate text-[12px] text-[var(--foreground-muted)]">
                  {[job.company, job.location, job.salary_text].filter(Boolean).join(" · ")}
                </span>
              </span>
              <ArrowRight size={13} className="shrink-0 text-[var(--foreground-faint)]" />
            </button>
          ))}
        </div>
        {recentJobs.length > 0 && (
          <div className="mt-2 flex gap-2 px-1">
            <Link href="/optimize" className="bauhaus-button bauhaus-button-sm bauhaus-button-outline">
              <Sparkles size={12} />
              为选中岗位定制简历
            </Link>
          </div>
        )}
      </motion.section>

      {/* 统计与趋势:按需展开 (ADR 0030) */}
      <motion.section variants={item} className="pb-6">
        <button
          type="button"
          onClick={() => setStatsExpanded((value) => !value)}
          aria-expanded={statsExpanded}
          className="flex w-full items-center gap-2 px-1 pb-2 text-left"
        >
          <BarChart3 size={14} strokeWidth={1.75} className="text-[var(--foreground-muted)]" />
          <span className="text-[13px] font-semibold text-[var(--foreground)]">统计与趋势</span>
          <motion.span
            animate={{ rotate: statsExpanded ? 180 : 0 }}
            transition={{ type: "spring", stiffness: 420, damping: 30 }}
            className="text-[var(--foreground-muted)]"
          >
            <ChevronDown size={14} />
          </motion.span>
        </button>
        <motion.div
          initial={false}
          animate={{ height: statsExpanded ? "auto" : 0, opacity: statsExpanded ? 1 : 0 }}
          transition={{ type: "spring", stiffness: 320, damping: 34 }}
          className="overflow-hidden"
        >
          <div className="bauhaus-panel-sm space-y-4 p-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                { label: "岗位总量", value: stats?.total_jobs ?? 0 },
                { label: "本周新增", value: jobsData?.items?.length ?? 0 },
                {
                  label: "活跃来源",
                  value: Object.keys(stats?.source_distribution ?? {}).length,
                },
                {
                  label: "活跃公司",
                  value: new Set((jobsData?.items ?? []).map((job) => job.company).filter(Boolean)).size,
                },
              ].map((stat) => (
                <div key={stat.label} className="rounded-md bg-[var(--surface-muted)] px-3 py-2.5">
                  <p className="text-[11px] font-medium text-[var(--foreground-muted)]">{stat.label}</p>
                  <p className="mt-1 text-xl font-semibold tabular-nums text-[var(--foreground)]">
                    {stat.value}
                  </p>
                </div>
              ))}
            </div>
            <Suspense fallback={null}>
              <TrendChart data={trendData} />
            </Suspense>
          </div>
        </motion.div>
      </motion.section>

      {isEmptyWorkspace && (
        <motion.p variants={item} className="px-1 pb-8 text-center text-[12px] text-[var(--foreground-faint)]">
          OfferU 会把待确认动作、临近截止和新机会汇总到这里,帮你决定现在做什么。
        </motion.p>
      )}
    </motion.div>
  );
}
