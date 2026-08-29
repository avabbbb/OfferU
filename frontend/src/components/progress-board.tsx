"use client";

// =============================================
// 进度看板：公司 → 岗位 → 时间线 三层渐进披露
// 顶层：未关联候选（显式建档 / 选择已有投递）
// 第一层：公司行（岗位数 / 最高阶段 / 待确认 badge）
// 第二层：岗位行（阶段胶囊 + next_action + 即将面试）
// 第三层：时间线（阶段事件 + 邮件 snippet + 内联 review）
// =============================================

import { useMemo, useState } from "react";
import { useSWRConfig } from "swr";
import Link from "next/link";
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
  ProgressUnlinkedCandidate,
  reviewProgressCandidate,
  useProgressBoard,
  useProgressTimeline,
} from "@/lib/hooks";

const STAGE_LABELS: Record<string, string> = {
  saved: "已保存",
  preparing: "准备中",
  ready: "待投递",
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
  saved: "bg-[var(--surface-muted)] text-[var(--foreground-soft)]",
  preparing: "bg-amber-100 text-amber-800",
  ready: "bg-blue-100 text-blue-800",
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

const REVIEWABLE_STAGES = [
  "applied",
  "written_test",
  "assessment",
  "interview_1",
  "interview_2",
  "interview_hr",
  "offer",
  "rejected",
] as const;

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

function UnlinkedCandidateCard({
  candidate,
  onReviewed,
}: {
  candidate: ProgressUnlinkedCandidate;
  onReviewed: () => Promise<void>;
}) {
  const [reviewing, setReviewing] = useState(false);
  const [selectedAttemptId, setSelectedAttemptId] = useState("");
  const suggestedStageIsValid = REVIEWABLE_STAGES.includes(
    candidate.suggested_stage as (typeof REVIEWABLE_STAGES)[number]
  );
  const [selectedStage, setSelectedStage] = useState(
    candidate.evidence.classification_conflict || !suggestedStageIsValid
      ? ""
      : candidate.suggested_stage
  );
  const [addCalendar, setAddCalendar] = useState(true);
  const isAmbiguous = candidate.match_state === "ambiguous";
  const canAccept =
    (candidate.can_create_record || Boolean(selectedAttemptId)) &&
    Boolean(selectedStage);
  const company = candidate.extracted.company || "未识别公司";
  const jobTitle = candidate.extracted.job_title || "未识别岗位";
  const evidence = candidate.evidence.evidence_span || candidate.evidence.snippet;

  const handleReview = async (action: "accept" | "reject") => {
    setReviewing(true);
    try {
      const result = await reviewProgressCandidate(candidate.candidate_id, {
        action,
        stage: action === "accept" ? selectedStage : undefined,
        application_attempt_id:
          action === "accept" && selectedAttemptId
            ? Number(selectedAttemptId)
            : undefined,
        create_record: action === "accept" && candidate.can_create_record,
        add_calendar: action === "accept" && addCalendar,
      });
      await onReviewed();
      const eventWarning = result.workspace_record?.event_warning;
      if (eventWarning) {
        window.alert(`进展已确认，但工作区事件日志写入失败：${eventWarning}`);
      }
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "审核失败");
    } finally {
      setReviewing(false);
    }
  };

  return (
    <div className="rounded-md border border-amber-300 bg-amber-50 p-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-amber-950">{company}</span>
            <span className="text-sm text-amber-900">{jobTitle}</span>
            <StagePill stage={candidate.suggested_stage} />
            <Chip size="sm" color="warning" variant="flat">
              {isAmbiguous ? "需选择已有投递" : "未匹配投递"}
            </Chip>
          </div>
          <p className="mt-1 truncate text-xs text-amber-900/75">
            {candidate.signal.subject || candidate.signal.sender || "未命名邮件信号"}
            {candidate.signal.received_at
              ? ` · ${formatDateTime(candidate.signal.received_at)}`
              : ""}
          </p>
          {evidence && (
            <p className="mt-2 flex items-start gap-1.5 text-xs leading-5 text-amber-950">
              <Mail size={13} className="mt-0.5 shrink-0" />
              <span>{evidence}</span>
            </p>
          )}
          {candidate.evidence.classification_conflict && (
            <p className="mt-2 text-xs font-semibold text-red-700">
              阶段判断存在冲突：规则为
              {STAGE_LABELS[candidate.evidence.rule_stage] || candidate.evidence.rule_stage || "未知"}
              ，模型为
              {STAGE_LABELS[candidate.evidence.llm_stage] || candidate.evidence.llm_stage || "未知"}
              ，请先核对邮件证据。
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            size="sm"
            className="bauhaus-button bauhaus-button-blue !min-h-8 !px-3"
            isDisabled={!canAccept}
            isLoading={reviewing}
            onPress={() => void handleReview("accept")}
          >
            {candidate.can_create_record ? "确认并建档" : "确认关联"}
          </Button>
          <Button
            size="sm"
            className="bauhaus-button bauhaus-button-outline !min-h-8 !px-3"
            isDisabled={reviewing}
            onPress={() => void handleReview("reject")}
          >
            忽略
          </Button>
        </div>
      </div>

      {isAmbiguous && candidate.match_candidates.length > 0 && (
        <label className="mt-3 block text-xs font-medium text-amber-950">
          关联到已有投递
          <select
            value={selectedAttemptId}
            onChange={(event) => setSelectedAttemptId(event.target.value)}
            className="mt-1 block w-full rounded-sm border border-amber-300 bg-white px-3 py-2 text-sm text-[var(--foreground)] outline-none focus:border-amber-500"
          >
            <option value="">请选择公司与岗位</option>
            {candidate.match_candidates.map((match) => (
              <option
                key={match.application_attempt_id}
                value={match.application_attempt_id}
              >
                {match.company || "未知公司"} · {match.job_title || "未命名岗位"}
              </option>
            ))}
          </select>
        </label>
      )}

      <label className="mt-3 block text-xs font-medium text-amber-950">
        确认阶段
        <select
          value={selectedStage}
          onChange={(event) => setSelectedStage(event.target.value)}
          className="mt-1 block w-full rounded-sm border border-amber-300 bg-white px-3 py-2 text-sm text-[var(--foreground)] outline-none focus:border-amber-500"
        >
          <option value="">请选择邮件实际对应的阶段</option>
          {REVIEWABLE_STAGES.map((stage) => (
            <option key={stage} value={stage}>
              {STAGE_LABELS[stage]}
            </option>
          ))}
        </select>
      </label>

      {candidate.extracted.interview_time && (
        <label className="mt-3 flex items-center gap-2 text-xs font-medium text-amber-950">
          <input
            type="checkbox"
            checked={addCalendar}
            onChange={(event) => setAddCalendar(event.target.checked)}
          />
          同时加入日历（{formatDateTime(candidate.extracted.interview_time)}）
        </label>
      )}

      {isAmbiguous && candidate.match_candidates.length === 0 && (
        <p className="mt-3 text-xs font-medium text-amber-900">
          存在多个或较弱的关联依据，但当前没有可直接选择的投递记录，请先手动核对。
        </p>
      )}

      {!isAmbiguous && !candidate.can_create_record && (
        <p className="mt-3 text-xs font-medium text-amber-900">
          当前信号缺少可确认的公司或阶段，请先手动创建投递记录后再关联。
        </p>
      )}
    </div>
  );
}

function UnlinkedCandidateQueue({
  candidates,
  onReviewed,
}: {
  candidates: ProgressUnlinkedCandidate[];
  onReviewed: () => Promise<void>;
}) {
  if (candidates.length === 0) return null;
  return (
    <section className="bauhaus-panel-sm space-y-3 bg-[var(--surface)] p-4">
      <div>
        <h3 className="text-sm font-bold text-[var(--foreground)]">待归属进展</h3>
        <p className="mt-1 text-xs text-[var(--foreground-muted)]">
          邮件已识别出阶段变化，但尚未写入职业事实；确认后才会关联或创建投递记录。
        </p>
      </div>
      {candidates.map((candidate) => (
        <UnlinkedCandidateCard
          key={candidate.candidate_id}
          candidate={candidate}
          onReviewed={onReviewed}
        />
      ))}
    </section>
  );
}

function RecordTimeline({
  attemptId,
  onReviewed,
}: {
  attemptId: number;
  onReviewed: () => Promise<void>;
}) {
  const { data, isLoading } = useProgressTimeline(attemptId);
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [selectedStages, setSelectedStages] = useState<Record<string, string>>({});
  const [calendarSelections, setCalendarSelections] = useState<Record<string, boolean>>({});

  const handleReview = async (
    candidateId: string,
    action: "accept" | "reject",
    stage = "",
    addCalendar = false
  ) => {
    setReviewing(candidateId);
    try {
      const result = await reviewProgressCandidate(candidateId, {
        action,
        stage: action === "accept" ? stage : undefined,
        add_calendar: action === "accept" && addCalendar,
      });
      await onReviewed();
      const eventWarning = result.workspace_record?.event_warning;
      if (eventWarning) {
        window.alert(`进展已确认，但工作区事件日志写入失败：${eventWarning}`);
      }
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
      {data.pending_candidates.map((candidate) => {
        const suggestedIsValid = REVIEWABLE_STAGES.includes(
          candidate.suggested_stage as (typeof REVIEWABLE_STAGES)[number]
        );
        const selectedStage =
          selectedStages[candidate.candidate_id] ??
          (candidate.classification_conflict || !suggestedIsValid
            ? ""
            : candidate.suggested_stage);
        const interviewTime = candidate.llm_extracted?.interview_time;
        const addCalendar = calendarSelections[candidate.candidate_id] ?? true;
        return (
          <div
            key={candidate.candidate_id}
            className="rounded-sm border border-dashed border-amber-300 bg-amber-50 px-3 py-2 text-xs"
          >
            <div className="flex items-center gap-3">
              <span className="shrink-0 font-semibold text-amber-800">待确认</span>
              <select
                value={selectedStage}
                onChange={(event) =>
                  setSelectedStages((previous) => ({
                    ...previous,
                    [candidate.candidate_id]: event.target.value,
                  }))
                }
                className="rounded-sm border border-amber-300 bg-white px-2 py-1 text-xs"
                aria-label="确认阶段"
              >
                <option value="">选择阶段</option>
                {REVIEWABLE_STAGES.map((stage) => (
                  <option key={stage} value={stage}>
                    {STAGE_LABELS[stage]}
                  </option>
                ))}
              </select>
              <span className="max-w-[320px] truncate text-[var(--foreground-soft)]">
                {candidate.signal.subject || candidate.signal.sender}
              </span>
              <div className="ml-auto flex shrink-0 items-center gap-1">
                <Button
                  size="sm"
                  isIconOnly
                  className="bauhaus-button bauhaus-button-outline !min-h-7 !w-7 !px-0"
                  isDisabled={!selectedStage}
                  isLoading={reviewing === candidate.candidate_id}
                  onPress={() =>
                    void handleReview(
                      candidate.candidate_id,
                      "accept",
                      selectedStage,
                      Boolean(interviewTime) && addCalendar
                    )
                  }
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
            {candidate.signal.snippet && (
              <p className="mt-2 pl-16 leading-5 text-amber-950">
                {candidate.signal.snippet}
              </p>
            )}
            {candidate.classification_conflict && (
              <p className="mt-1 pl-16 font-semibold text-red-700">
                规则与模型阶段判断冲突，请核对证据后选择。
              </p>
            )}
            {interviewTime && (
              <label className="mt-2 flex items-center gap-2 pl-16 text-amber-950">
                <input
                  type="checkbox"
                  checked={addCalendar}
                  onChange={(event) =>
                    setCalendarSelections((previous) => ({
                      ...previous,
                      [candidate.candidate_id]: event.target.checked,
                    }))
                  }
                />
                同时加入日历（{formatDateTime(interviewTime)}）
              </label>
            )}
          </div>
        );
      })}
    </div>
  );
}

function RecordRow({
  record,
  onReviewed,
}: {
  record: ProgressBoardRecord;
  onReviewed: () => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const attemptId = record.application_attempt_id;
  const isOpportunity = attemptId == null;
  const rowContent = (
    <>
      {isOpportunity || !expanded ? (
        <ChevronRight size={14} className="shrink-0 text-[var(--foreground-muted)]" />
      ) : (
        <ChevronDown size={14} className="shrink-0 text-[var(--foreground-muted)]" />
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
    </>
  );
  if (isOpportunity) {
    return (
      <Link
        href={`/jobs/${record.job_id}`}
        className="press-feedback flex w-full items-center gap-3 border-t border-[var(--border)] px-6 py-2.5 text-left"
      >
        {rowContent}
      </Link>
    );
  }
  return (
    <div className="border-t border-[var(--border)]">
      <button
        type="button"
        className="press-feedback flex w-full items-center gap-3 px-6 py-2.5 text-left"
        onClick={() => setExpanded((prev) => !prev)}
      >
        {rowContent}
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
              attemptId={attemptId}
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
  onReviewed: () => Promise<void>;
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
  const { data, isLoading } = useProgressBoard(status);
  const { mutate: mutateCache } = useSWRConfig();

  const refreshProgressProjections = async () => {
    await mutateCache(
      (key) =>
        typeof key === "string" &&
        (key.includes("/api/applications/progress-board") ||
          key.includes("/api/email/progress-candidates")),
    );
  };

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
      {!isLoading &&
        data &&
        data.companies.length === 0 &&
        data.unlinked_candidates.length === 0 && (
        <div className="surface-fabric relative isolate overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] p-10 text-center text-sm text-[var(--foreground-muted)]">
          <p className="font-medium text-[var(--foreground)]">
            暂无{status === "active" ? "进行中的" : status === "closed" ? "已结束的" : ""}投递记录
          </p>
          <p className="mt-2">从「岗位」页挑选岗位创建投递，或连接邮箱自动捕获进展。</p>
        </div>
      )}
      {data && (
        <UnlinkedCandidateQueue
          candidates={data.unlinked_candidates}
          onReviewed={refreshProgressProjections}
        />
      )}
      <div className="space-y-3">
        {data?.companies.map((group) => (
          <CompanyGroup
            key={group.company}
            group={group}
            onReviewed={refreshProgressProjections}
          />
        ))}
      </div>
    </div>
  );
}
