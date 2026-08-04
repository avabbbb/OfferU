"use client";

// =============================================
// 进度看板：公司 → 岗位 → 时间线 三层渐进披露
// 第一层：公司行（岗位数 / 最高阶段 / 待确认 badge）
// 第二层：岗位行（阶段胶囊 + next_action + 即将面试）
// 第三层：时间线（阶段事件 + 邮件 snippet + 内联 review）
// =============================================

import { useMemo, useState } from "react";
import { Button, Chip, Spinner, Tooltip } from "@nextui-org/react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Building2,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronRight,
  Mail,
  X,
} from "lucide-react";
import {
  ProgressBoardCompany,
  ProgressBoardRecord,
  reviewProgressCandidate,
  useProgressBoard,
  useProgressTimeline,
} from "@/lib/hooks";

const STAGE_LABELS: Record<string, string> = {
  prepared: "待投递",
  applied: "已投递",
  written_test: "笔试",
  assessment: "测评",
  interview_1: "一面",
  interview_2: "二面/终面",
  interview_hr: "HR面",
  offer: "Offer",
  rejected: "已结束",
  unknown: "未知",
};

const STAGE_COLORS: Record<string, string> = {
  prepared: "bg-[var(--surface-muted)] text-[var(--foreground-soft)]",
  applied: "bg-blue-100 text-blue-800",
  written_test: "bg-amber-100 text-amber-800",
  assessment: "bg-amber-100 text-amber-800",
  interview_1: "bg-violet-100 text-violet-800",
  interview_2: "bg-violet-100 text-violet-800",
  interview_hr: "bg-violet-100 text-violet-800",
  offer: "bg-emerald-100 text-emerald-800",
  rejected: "bg-neutral-200 text-neutral-600",
  unknown: "bg-neutral-100 text-neutral-500",
};

function StagePill({ stage }: { stage: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${
        STAGE_COLORS[stage] ?? STAGE_COLORS.unknown
      }`}
    >
      {STAGE_LABELS[stage] ?? stage}
    </span>
  );
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return "-";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function RecordTimeline({
  attemptId,
  onReviewed,
}: {
  attemptId: number;
  onReviewed: () => void;
}) {
  const { data, isLoading, mutate } = useProgressTimeline(attemptId);
  const [reviewing, setReviewing] = useState<string | null>(null);

  const handleReview = async (
    candidateId: string,
    action: "accept" | "reject"
  ) => {
    setReviewing(candidateId);
    try {
      await reviewProgressCandidate(candidateId, { action });
      await mutate();
      onReviewed();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "审核失败");
    } finally {
      setReviewing(null);
    }
  };

  if (isLoading || !data) {
    return (
      <div className="flex items-center gap-2 px-10 py-3 text-xs text-[var(--foreground-muted)]">
        <Spinner size="sm" /> 加载时间线…
      </div>
    );
  }

  return (
    <div className="space-y-2 border-l-2 border-[var(--border)] px-6 py-3 ml-8">
      {data.timeline.length === 0 && data.pending_candidates.length === 0 && (
        <p className="text-xs text-[var(--foreground-muted)]">暂无阶段事件</p>
      )}
      {data.timeline.map((entry) => (
        <div key={entry.event_id} className="flex items-start gap-3 text-xs">
          <span className="mt-0.5 shrink-0 text-[var(--foreground-muted)]">
            {formatDateTime(entry.occurred_at)}
          </span>
          <StagePill stage={entry.stage} />
          {entry.snippet && (
            <Tooltip content={entry.snippet} placement="top" closeDelay={100}>
              <span className="inline-flex items-center gap-1 truncate text-[var(--foreground-muted)]">
                <Mail size={12} className="shrink-0" />
                <span className="max-w-[380px] truncate">{entry.snippet}</span>
              </span>
            </Tooltip>
          )}
        </div>
      ))}
      {data.pending_candidates.map((candidate) => (
        <div
          key={candidate.candidate_id}
          className="flex items-center gap-3 rounded-sm border border-dashed border-amber-300 bg-amber-50 px-3 py-2 text-xs"
        >
          <span className="shrink-0 font-semibold text-amber-800">待确认</span>
          <StagePill stage={candidate.suggested_stage} />
          <span className="max-w-[320px] truncate text-[var(--foreground-soft)]">
            {candidate.signal.subject || candidate.signal.sender}
          </span>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <Button
              size="sm"
              isIconOnly
              className="bauhaus-button bauhaus-button-outline !min-h-7 !w-7 !px-0"
              isLoading={reviewing === candidate.candidate_id}
              onPress={() => void handleReview(candidate.candidate_id, "accept")}
              aria-label="确认进展"
            >
              <Check size={12} />
            </Button>
            <Button
              size="sm"
              isIconOnly
              className="bauhaus-button bauhaus-button-outline !min-h-7 !w-7 !px-0"
              isLoading={reviewing === candidate.candidate_id}
              onPress={() => void handleReview(candidate.candidate_id, "reject")}
              aria-label="拒绝进展"
            >
              <X size={12} />
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}

function RecordRow({
  record,
  onReviewed,
}: {
  record: ProgressBoardRecord;
  onReviewed: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="border-t border-[var(--border)]">
      <button
        type="button"
        className="press-feedback flex w-full items-center gap-3 px-6 py-2.5 text-left"
        onClick={() => setExpanded((prev) => !prev)}
      >
        {expanded ? (
          <ChevronDown size={14} className="shrink-0 text-[var(--foreground-muted)]" />
        ) : (
          <ChevronRight size={14} className="shrink-0 text-[var(--foreground-muted)]" />
        )}
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {record.job_title || "(未命名岗位)"}
        </span>
        <StagePill stage={record.current_stage} />
        {record.pending_candidates > 0 && (
          <Chip size="sm" color="warning" variant="flat">
            {record.pending_candidates} 待确认
          </Chip>
        )}
        {record.upcoming_interview && (
          <Tooltip
            content={`${record.upcoming_interview.title} · ${formatDateTime(
              record.upcoming_interview.start_time
            )}${record.upcoming_interview.location ? ` · ${record.upcoming_interview.location}` : ""}`}
            placement="top"
            closeDelay={100}
          >
            <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-violet-700">
              <CalendarClock size={13} />
              {formatDateTime(record.upcoming_interview.start_time)}
            </span>
          </Tooltip>
        )}
        <span className="hidden max-w-[260px] shrink-0 truncate text-xs text-[var(--foreground-muted)] lg:inline">
          {record.next_action}
        </span>
      </button>
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ type: "spring", stiffness: 420, damping: 38, mass: 0.72 }}
            className="overflow-hidden"
          >
            <RecordTimeline
              attemptId={record.application_attempt_id}
              onReviewed={onReviewed}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function CompanyGroup({
  group,
  onReviewed,
}: {
  group: ProgressBoardCompany;
  onReviewed: () => void;
}) {
  const [expanded, setExpanded] = useState(group.pending_candidates > 0);
  return (
    <div className="bauhaus-panel-sm overflow-hidden bg-[var(--surface)]">
      <button
        type="button"
        className="press-feedback flex w-full items-center gap-3 px-4 py-3 text-left"
        onClick={() => setExpanded((prev) => !prev)}
      >
        {expanded ? (
          <ChevronDown size={16} className="shrink-0" />
        ) : (
          <ChevronRight size={16} className="shrink-0" />
        )}
        <Building2 size={16} className="shrink-0 text-[var(--foreground-muted)]" />
        <span className="min-w-0 flex-1 truncate text-base font-semibold">
          {group.company}
        </span>
        <span className="shrink-0 text-xs text-[var(--foreground-muted)]">
          {group.records.length} 个岗位
        </span>
        <StagePill stage={group.max_stage} />
        {group.pending_candidates > 0 && (
          <Chip size="sm" color="warning" variant="flat">
            {group.pending_candidates} 待确认
          </Chip>
        )}
      </button>
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ type: "spring", stiffness: 400, damping: 38, mass: 0.78 }}
            className="overflow-hidden"
          >
            {group.records.map((record) => (
              <RecordRow
                key={record.application_attempt_id}
                record={record}
                onReviewed={onReviewed}
              />
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default function ProgressBoard() {
  const [status, setStatus] = useState<"active" | "closed" | "all">("active");
  const { data, isLoading, mutate } = useProgressBoard(status);

  const summaryEntries = useMemo(() => {
    if (!data) return [] as [string, number][];
    return Object.entries(data.summary.by_stage).sort(
      (a, b) => b[1] - a[1]
    );
  }, [data]);

  return (
    <div className="progress-board space-y-4">
      <div className="stage-toolbar flex flex-wrap items-center gap-3 p-2">
        <div className="flex items-center gap-1">
          {(["active", "closed", "all"] as const).map((item) => (
            <Button
              key={item}
              size="sm"
              className={`bauhaus-button !min-h-9 !px-4 ${
                status === item
                  ? "bauhaus-button-blue"
                  : "bauhaus-button-outline"
              }`}
              onPress={() => setStatus(item)}
            >
              {item === "active" ? "进行中" : item === "closed" ? "已结束" : "全部"}
            </Button>
          ))}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2 text-xs text-[var(--foreground-muted)]">
          {summaryEntries.map(([stage, count]) => (
            <span key={stage} className="inline-flex items-center gap-1">
              <StagePill stage={stage} />
              <span className="font-semibold">{count}</span>
            </span>
          ))}
          {data && data.summary.pending_review > 0 && (
            <Chip size="sm" color="warning" variant="flat">
              共 {data.summary.pending_review} 条待确认
            </Chip>
          )}
        </div>
      </div>

      {isLoading && (
        <div className="flex items-center justify-center py-16">
          <Spinner label="加载进度看板…" />
        </div>
      )}
      {!isLoading && data && data.companies.length === 0 && (
        <div className="surface-fabric relative isolate overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] p-10 text-center text-sm text-[var(--foreground-muted)]">
          <p className="font-medium text-[var(--foreground)]">
            暂无{status === "active" ? "进行中的" : status === "closed" ? "已结束的" : ""}投递记录
          </p>
          <p className="mt-2">从「岗位」页挑选岗位创建投递，或连接邮箱自动捕获进展。</p>
        </div>
      )}
      <div className="space-y-3">
        {data?.companies.map((group) => (
          <CompanyGroup
            key={group.company}
            group={group}
            onReviewed={() => void mutate()}
          />
        ))}
      </div>
    </div>
  );
}
