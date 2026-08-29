"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { motion } from "framer-motion";
import {
  Button,
  Card,
  CardBody,
  Chip,
  Link,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Select,
  SelectItem,
  Spinner,
} from "@nextui-org/react";
import {
  ArrowLeft,
  Building2,
  Calendar,
  CheckCircle2,
  ExternalLink,
  MapPin,
  RefreshCw,
  Send,
  XCircle,
} from "lucide-react";
import { patchJob, useJob, usePools, useProgressBoard, useProgressTimeline } from "@/lib/hooks";
import { RoleIntelligencePanel } from "@/components/jobs/RoleIntelligencePanel";
import {
  jobResearchApi,
  preApplicationApi,
  resumeOptimizationApi,
  type JobResearchRunDetail,
  type PreApplicationDecisionChoice,
  type PreApplicationState,
  type ResumeOptimizationProposalDetail,
} from "@/lib/api";
import {
  bauhausModalContentClassName,
  bauhausSelectClassNames,
} from "@/lib/bauhaus";

const PRE_APPLICATION_STAGE_LABELS: Record<string, string> = {
  research_pending: "等待调研",
  research_failed: "调研失败",
  needs_decision: "等待生成决策",
  needs_decision_review: "等待人工审核",
  completed_no_go: "已确认不投",
  completed_insufficient_evidence: "证据不足",
  ready_for_resume_proposal: "可以准备简历提案",
  resume_proposal_ready: "已有简历提案",
};

const PRE_APPLICATION_DECISION_LABELS: Record<PreApplicationDecisionChoice, string> = {
  go: "投",
  conditional_go: "有条件投",
  no_go: "不投",
  insufficient_evidence: "证据不足",
};

const PRE_APPLICATION_DECISION_OPTIONS: Array<{
  value: PreApplicationDecisionChoice;
  label: string;
}> = [
  { value: "go", label: "投" },
  { value: "conditional_go", label: "有条件投" },
  { value: "no_go", label: "不投" },
  { value: "insufficient_evidence", label: "证据不足" },
];

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

function formatProgressTimestamp(value: string | null) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function resumeProposalRowText(row: Record<string, any> | null | undefined) {
  if (!row) return "无";
  const labels: Record<string, string> = {
    section_type: "类型",
    title: "标题",
    company: "公司",
    position: "职位",
    school: "学校",
    degree: "学位",
    major: "专业",
    name: "项目",
    role: "角色",
    description: "内容",
  };
  return Object.entries(row)
    .filter(([key]) => key !== "source_section_ids" && key !== "content_json")
    .map(([key, value]) => {
      if (value === null || value === undefined || value === "") return "";
      const text = Array.isArray(value) ? value.join("、") : String(value);
      return `${labels[key] || key}: ${text}`;
    })
    .filter(Boolean)
    .join(" · ");
}

export default function JobDetailPage() {
  const params = useParams();
  const router = useRouter();
  const jobId = params.id ? Number(params.id) : null;
  const { data: job, isLoading, error } = useJob(jobId);
  const { data: pickedPools } = usePools("picked");
  const {
    data: progressBoard,
    error: progressError,
    isLoading: progressLoading,
  } = useProgressBoard("all");
  const [selectedAttemptId, setSelectedAttemptId] = useState<number | null>(null);
  const { data: progressTimeline, error: progressTimelineError, isLoading: progressTimelineLoading } =
    useProgressTimeline(selectedAttemptId);
  const [joinModalOpen, setJoinModalOpen] = useState(false);
  const [trashConfirmOpen, setTrashConfirmOpen] = useState(false);
  const [targetPool, setTargetPool] = useState<string>("ungrouped");
  const [actionLoading, setActionLoading] = useState<"join" | "trash" | null>(null);
  const [research, setResearch] = useState<JobResearchRunDetail | null>(null);
  const [researchLoading, setResearchLoading] = useState(false);
  const [researchError, setResearchError] = useState("");
  const [reviewNote, setReviewNote] = useState("");
  const [reviewAction, setReviewAction] = useState<"accept" | "reject" | null>(null);
  const [preApplication, setPreApplication] = useState<PreApplicationState | null>(null);
  const [preApplicationLoading, setPreApplicationLoading] = useState(false);
  const [preApplicationError, setPreApplicationError] = useState("");
  const [preApplicationAction, setPreApplicationAction] = useState<"prepare" | "review" | null>(null);
  const [decisionChoice, setDecisionChoice] = useState<PreApplicationDecisionChoice | "">("");
  const [decisionNote, setDecisionNote] = useState("");
  const [resumeProposal, setResumeProposal] = useState<ResumeOptimizationProposalDetail | null>(null);
  const [resumeProposalLoading, setResumeProposalLoading] = useState(false);
  const [resumeProposalError, setResumeProposalError] = useState("");
  const [resumeProposalAction, setResumeProposalAction] = useState<"accept" | "reject" | null>(null);
  const [resumeProposalNote, setResumeProposalNote] = useState("");

  const poolOptions = useMemo(
    () => [{ key: "ungrouped", label: "未分组" }, ...((pickedPools || []).map((pool) => ({ key: String(pool.id), label: pool.name })))],
    [pickedPools]
  );

  const progressRecords = useMemo(
    () =>
      (progressBoard?.companies ?? [])
        .flatMap((company) => company.records)
        .filter((record) => record.job_id === jobId)
        .sort((left, right) =>
          String(right.last_event_at ?? right.attempt_created_at).localeCompare(
            String(left.last_event_at ?? left.attempt_created_at)
          )
        ),
    [jobId, progressBoard]
  );

  const selectedProgressRecord = useMemo(
    () => progressRecords.find((record) => record.application_attempt_id === selectedAttemptId) ?? progressRecords[0] ?? null,
    [progressRecords, selectedAttemptId]
  );

  const currentApplicationStage =
    progressTimeline?.current_stage || selectedProgressRecord?.current_stage || "";
  const currentNextAction =
    progressTimeline?.next_action || selectedProgressRecord?.next_action || "";
  const hasConfirmedStageEvent = Boolean(progressTimeline?.timeline?.length);
  const selectedRecordIsOpportunity = selectedProgressRecord?.application_attempt_id == null;
  const interviewPreparationPriority = INTERVIEW_STAGES.has(currentApplicationStage);

  useEffect(() => {
    if (!progressRecords.some((record) => record.application_attempt_id === selectedAttemptId)) {
      setSelectedAttemptId(progressRecords[0]?.application_attempt_id ?? null);
    }
  }, [progressRecords, selectedAttemptId]);

  const loadResearch = useCallback(async () => {
    if (!jobId || !Number.isInteger(jobId) || jobId <= 0) return;
    setResearchLoading(true);
    setResearchError("");
    try {
      const runs = await jobResearchApi.runs({ job_id: jobId, limit: 1 });
      const latest = runs.items[0];
      if (!latest) {
        setResearch(null);
        setReviewNote("");
        return;
      }
      const detail = await jobResearchApi.run(latest.run_id);
      setResearch(detail);
      setReviewNote(detail.review_note || "");
    } catch (err) {
      setResearchError(err instanceof Error ? err.message : "调研证据加载失败");
    } finally {
      setResearchLoading(false);
    }
  }, [jobId]);

  const loadResumeProposal = useCallback(async () => {
    if (!jobId || !Number.isInteger(jobId) || jobId <= 0) return;
    setResumeProposalLoading(true);
    setResumeProposalError("");
    try {
      const proposals = await resumeOptimizationApi.list(jobId, { limit: 1 });
      const latest = proposals.items[0];
      if (!latest) {
        setResumeProposal(null);
        return;
      }
      setResumeProposal(await resumeOptimizationApi.detail(latest.proposal_id));
    } catch (err) {
      setResumeProposalError(err instanceof Error ? err.message : "材料候选加载失败");
    } finally {
      setResumeProposalLoading(false);
    }
  }, [jobId]);

  const loadPreApplication = useCallback(async () => {
    if (!jobId || !Number.isInteger(jobId) || jobId <= 0) return;
    setPreApplicationLoading(true);
    setPreApplicationError("");
    try {
      const state = await preApplicationApi.state(jobId);
      setPreApplication(state);
      const decision = state.decision;
      setDecisionChoice(decision?.final_decision || decision?.agent_recommendation || "");
      setDecisionNote(decision?.review_note || "");
    } catch (err) {
      setPreApplicationError(err instanceof Error ? err.message : "投前决策状态加载失败");
    } finally {
      setPreApplicationLoading(false);
    }
  }, [jobId]);

  useEffect(() => {
    void loadResearch();
  }, [loadResearch]);

  useEffect(() => {
    void loadResumeProposal();
  }, [loadResumeProposal]);

  useEffect(() => {
    void loadPreApplication();
  }, [loadPreApplication]);

  const handleResearchReview = async (action: "accept" | "reject") => {
    if (!research || reviewAction) return;
    const note = reviewNote.trim();
    if (action === "reject" && !note) {
      setResearchError("拒绝候选证据时必须填写原因。");
      return;
    }
    setReviewAction(action);
    setResearchError("");
    try {
      const detail = await jobResearchApi.review(research.run_id, { action, note });
      setResearch(detail);
      setReviewNote(detail.review_note || "");
      void loadPreApplication();
    } catch (err) {
      setResearchError(err instanceof Error ? err.message : "审核操作失败");
    } finally {
      setReviewAction(null);
    }
  };

  const handlePreparePreApplication = async () => {
    if (!jobId || !preApplication?.research_run?.run_id || preApplicationAction) return;
    setPreApplicationAction("prepare");
    setPreApplicationError("");
    try {
      const decision = await preApplicationApi.prepare(jobId, preApplication.research_run.run_id);
      setDecisionChoice(decision.agent_recommendation);
      setDecisionNote("");
      await loadPreApplication();
    } catch (err) {
      setPreApplicationError(err instanceof Error ? err.message : "投前决策生成失败");
    } finally {
      setPreApplicationAction(null);
    }
  };

  const handlePreApplicationReview = async () => {
    const decision = preApplication?.decision;
    if (!decision || !decisionChoice || preApplicationAction) return;
    const note = decisionNote.trim();
    if (decisionChoice !== decision.agent_recommendation && !note) {
      setPreApplicationError("覆盖 Agent 建议时必须填写理由。");
      return;
    }
    setPreApplicationAction("review");
    setPreApplicationError("");
    try {
      await preApplicationApi.review(decision.id, {
        final_decision: decisionChoice,
        note,
      });
      await loadPreApplication();
    } catch (err) {
      setPreApplicationError(err instanceof Error ? err.message : "投前决策审核失败");
    } finally {
      setPreApplicationAction(null);
    }
  };

  const handleResumeProposalReview = async (action: "accept" | "reject") => {
    if (!resumeProposal || resumeProposalAction) return;
    const note = resumeProposalNote.trim();
    if (action === "reject" && !note) {
      setResumeProposalError("拒绝材料候选时必须填写原因。");
      return;
    }
    setResumeProposalAction(action);
    setResumeProposalError("");
    try {
      const reviewed = await resumeOptimizationApi.review(resumeProposal.proposal_id, { action, note });
      setResumeProposal(reviewed);
      setResumeProposalNote(reviewed.review_note || "");
    } catch (err) {
      setResumeProposalError(err instanceof Error ? err.message : "材料候选审核失败");
    } finally {
      setResumeProposalAction(null);
    }
  };

  const handleJoinPicked = async () => {
    if (!job) return;
    try {
      setActionLoading("join");
      if (targetPool === "ungrouped") {
        await patchJob(job.id, { triage_status: "picked", clear_pool: true });
      } else {
        await patchJob(job.id, { triage_status: "picked", pool_id: Number(targetPool) });
      }
      setJoinModalOpen(false);
      router.push("/jobs?tab=picked");
    } catch (err: any) {
      alert(err?.message || "加入已筛选失败");
    } finally {
      setActionLoading(null);
    }
  };

  const handleMoveToTrash = async () => {
    if (!job) return;
    try {
      setActionLoading("trash");
      await patchJob(job.id, { triage_status: "ignored" });
      setTrashConfirmOpen(false);
      router.push("/jobs?tab=ignored");
    } catch (err: any) {
      alert(err?.message || "移入回收站失败");
    } finally {
      setActionLoading(null);
    }
  };

  const preApplicationDecision = preApplication?.decision;
  const decisionSections: Array<[string, string[]]> = preApplicationDecision
    ? [
        ["优势", preApplicationDecision.decision.strengths],
        ["缺口", preApplicationDecision.decision.gaps],
        ["有条件投条件", preApplicationDecision.decision.conditions],
        ["缺少证据", preApplicationDecision.decision.missing_evidence],
      ]
    : [];

  if (isLoading) {
    return (
      <div className="flex min-h-[420px] items-center justify-center">
        <div className="bauhaus-panel-sm flex items-center gap-3 bg-white px-5 py-4">
          <Spinner size="sm" color="warning" />
          <span className="text-sm font-semibold tracking-[0.04em] text-[var(--foreground-soft)]">正在载入岗位详情...</span>
        </div>
      </div>
    );
  }

  if (error || !job) {
    return (
      <div className="flex min-h-[420px] items-center justify-center">
        <div className="bauhaus-panel bg-white p-8 text-center">
          <p className="text-lg font-black uppercase tracking-[-0.05em] text-[var(--foreground)]">岗位不存在或加载失败</p>
          <Button onPress={() => router.push("/jobs")} className="bauhaus-button bauhaus-button-outline mt-5 !px-4 !py-3 !text-[11px]">
            返回列表
          </Button>
        </div>
      </div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 380, damping: 28 }}
      className="mx-auto max-w-5xl space-y-8"
    >
      <section className="bauhaus-panel overflow-hidden bg-white">
        <div className="grid gap-6 p-6 md:p-8 xl:grid-cols-[1.05fr_0.95fr]">
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <Button
                isIconOnly
                variant="light"
                onPress={() => router.push("/jobs")}
                className="min-h-11 min-w-11 border border-[var(--border)] bg-[var(--surface)] text-[var(--foreground)] "
              >
                <ArrowLeft size={18} />
              </Button>
              <span className="bauhaus-chip bg-[var(--surface-muted)] text-[var(--foreground)]">岗位档案</span>
            </div>

            <div>
              <p className="bauhaus-label text-[var(--foreground-muted)]">详情表</p>
              <h1 className="mt-3 text-4xl font-black leading-[0.92] tracking-[-0.06em] text-[var(--foreground)] sm:text-5xl">
                {job.title}
              </h1>
              <div className="mt-4 flex flex-wrap items-center gap-3 text-sm font-medium text-[var(--foreground-muted)]">
                <span className="flex items-center gap-1"><Building2 size={14} /> {job.company}</span>
                <span className="flex items-center gap-1"><MapPin size={14} /> {job.location || "未知地点"}</span>
                {job.posted_at && <span className="flex items-center gap-1"><Calendar size={14} /> {job.posted_at}</span>}
              </div>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-1">
            <div className="bauhaus-panel-sm bg-[var(--surface-muted)] p-4 text-[var(--foreground)]">
              <p className="bauhaus-label text-[var(--foreground-muted)]">来源</p>
              <p className="mt-3 text-2xl font-black uppercase tracking-[-0.05em]">{job.source}</p>
            </div>
            <div className="bauhaus-panel-sm bg-[var(--surface-muted)] p-4 text-[var(--foreground)]">
              <p className="bauhaus-label text-[var(--foreground-muted)]">关键词</p>
              <p className="mt-3 text-2xl font-black uppercase tracking-[-0.05em]">{job.keywords?.length ?? 0}</p>
            </div>
            <div className="bauhaus-panel-sm bg-[var(--surface-muted)] p-4 text-[var(--foreground)] sm:col-span-2 xl:col-span-1">
              <p className="bauhaus-label text-[var(--foreground-muted)]">操作</p>
              <div className="mt-4 flex flex-wrap gap-2">
                <Button onPress={() => setJoinModalOpen(true)} isLoading={actionLoading === "join"} className="bauhaus-button bauhaus-button-yellow !px-4 !py-3 !text-[11px]">
                  加入已筛选
                </Button>
                <Button onPress={() => setTrashConfirmOpen(true)} isLoading={actionLoading === "trash"} isDisabled={actionLoading === "join"} className="bauhaus-button bauhaus-button-outline !px-4 !py-3 !text-[11px]">
                  移入回收站
                </Button>
              </div>
            </div>
          </div>
        </div>
      </section>

      {job.summary && (
        <Card className="bauhaus-panel rounded-none bg-white shadow-none">
          <CardBody className="p-5">
            <p className="bauhaus-label text-[var(--foreground-muted)]">AI 摘要</p>
            <h2 className="mt-2 text-2xl font-black uppercase tracking-[-0.05em] text-[var(--foreground)]">岗位摘要</h2>
            <p className="mt-4 text-sm font-medium leading-relaxed text-[var(--foreground-soft)]">{job.summary}</p>
          </CardBody>
        </Card>
      )}

      <Card className="bauhaus-panel rounded-none bg-white shadow-none" data-testid="job-application-context">
        <CardBody className="space-y-5 p-5">
          <div>
            <p className="bauhaus-label text-[var(--foreground-muted)]">Application context</p>
            <h2 className="mt-2 text-2xl font-black uppercase tracking-[-0.05em] text-[var(--foreground)]">
              投递进展
            </h2>
            <p className="mt-2 max-w-2xl text-sm font-medium leading-relaxed text-[var(--foreground-soft)]">
              这里读取已确认的投递阶段事件。外部邮件形成的候选不会直接改变正式状态，必须在进展页审核后才会进入时间线。
            </p>
          </div>

          {progressError && (
            <div className="bauhaus-panel-sm border-[var(--primary-red)] bg-red-50 px-4 py-3 text-sm font-semibold text-red-800">
              投递进展加载失败：{progressError instanceof Error ? progressError.message : "请稍后重试"}
            </div>
          )}

          {progressLoading && !progressBoard ? (
            <div className="bauhaus-panel-sm flex items-center gap-3 bg-[var(--surface-muted)] px-4 py-4">
              <Spinner size="sm" color="warning" />
              <span className="text-sm font-semibold text-[var(--foreground-soft)]">正在读取该岗位的投递进展...</span>
            </div>
          ) : progressRecords.length === 0 ? (
            <div className="bauhaus-panel-sm bg-[var(--surface-muted)] px-4 py-4">
              <p className="text-sm font-black text-[var(--foreground)]">
                {progressError ? "暂时无法读取投递尝试" : "尚未创建投递尝试"}
              </p>
              <p className="mt-1 text-sm font-medium leading-relaxed text-[var(--foreground-muted)]">
                {progressError
                  ? "请稍后刷新；当前不会根据不完整的读取结果推断投递状态。"
                  : "外部提交后，只有经过确认的回执候选才会创建投递尝试并出现在这里。"}
              </p>
            </div>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="bauhaus-panel-sm bg-[var(--surface-muted)] p-4">
                  <p className="bauhaus-label text-[var(--foreground-muted)]">
                    {selectedRecordIsOpportunity ? "目标岗位" : "投递尝试"}
                  </p>
                  <p className="mt-2 text-2xl font-black text-[var(--foreground)]">{progressRecords.length}</p>
                </div>
                <div className="bauhaus-panel-sm bg-[var(--surface-muted)] p-4">
                  <p className="bauhaus-label text-[var(--foreground-muted)]">当前阶段</p>
                  <p className="mt-2 text-sm font-black text-[var(--foreground)]">
                    {progressTimeline?.current_stage
                      ? applicationStageLabel(progressTimeline.current_stage)
                      : selectedProgressRecord
                        ? applicationStageLabel(selectedProgressRecord.current_stage)
                        : "-"}
                  </p>
                </div>
                <div className="bauhaus-panel-sm bg-[var(--surface-muted)] p-4">
                  <p className="bauhaus-label text-[var(--foreground-muted)]">下一动作</p>
                  <p className="mt-2 text-sm font-black leading-relaxed text-[var(--foreground)]">
                    {progressTimeline?.next_action || selectedProgressRecord?.next_action || "-"}
                  </p>
                </div>
              </div>

              <div>
                <p className="bauhaus-label text-[var(--foreground-muted)]">
                  {selectedRecordIsOpportunity ? "目标岗位" : "投递尝试"}
                </p>
                <div className="mt-3 grid gap-2">
                  {progressRecords.map((record) => {
                    const selected = record.application_attempt_id === selectedAttemptId;
                    return (
                      <button
                        key={record.application_attempt_id ?? `job-${record.job_id}`}
                        type="button"
                        aria-pressed={selected}
                        onClick={() => setSelectedAttemptId(record.application_attempt_id)}
                        className={`bauhaus-panel-sm flex items-center justify-between gap-3 px-4 py-3 text-left transition-colors ${
                          selected
                            ? "border-[var(--primary-blue)] bg-[var(--surface-muted)]"
                            : "bg-white hover:bg-[var(--surface-muted)]"
                        }`}
                      >
                        <span>
                          <span className="block text-sm font-black text-[var(--foreground)]">
                            {record.application_attempt_id == null
                              ? `目标岗位 · ${applicationStageLabel(record.current_stage)}`
                              : `#${record.application_attempt_id} · ${applicationStageLabel(record.current_stage)}`}
                          </span>
                          <span className="mt-1 block text-xs font-semibold text-[var(--foreground-muted)]">
                            最近更新 {formatProgressTimestamp(record.last_event_at || record.attempt_created_at)}
                          </span>
                        </span>
                        <span className="max-w-[46%] text-right text-xs font-bold leading-relaxed text-[var(--foreground-soft)]">
                          {record.next_action || "-"}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div>
                <p className="bauhaus-label text-[var(--foreground-muted)]">
                  {selectedRecordIsOpportunity ? "岗位准备时间线" : "已确认阶段时间线"}
                </p>
                {selectedRecordIsOpportunity ? (
                  <div className="bauhaus-panel-sm mt-3 bg-[var(--surface-muted)] px-4 py-4 text-sm font-medium leading-relaxed text-[var(--foreground-muted)]">
                    这是目标岗位的准备状态。完成实际投递并确认回执后，阶段事件会继续出现在这里。
                  </div>
                ) : progressTimelineLoading ? (
                  <div className="bauhaus-panel-sm mt-3 flex items-center gap-3 bg-[var(--surface-muted)] px-4 py-4">
                    <Spinner size="sm" color="warning" />
                    <span className="text-sm font-semibold text-[var(--foreground-soft)]">正在读取时间线...</span>
                  </div>
                ) : progressTimelineError ? (
                  <div className="bauhaus-panel-sm mt-3 border-[var(--primary-red)] bg-red-50 px-4 py-3 text-sm font-semibold text-red-800">
                    时间线加载失败：{progressTimelineError instanceof Error ? progressTimelineError.message : "请稍后重试"}
                  </div>
                ) : progressTimeline?.timeline?.length ? (
                  <div className="mt-3 space-y-2">
                    {progressTimeline.timeline.map((event) => (
                      <article key={event.event_id} className="bauhaus-panel-sm bg-[var(--surface-muted)] p-4">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="text-sm font-black text-[var(--foreground)]">
                            {applicationStageLabel(event.previous_stage)} → {applicationStageLabel(event.stage)}
                          </p>
                          <p className="text-xs font-bold text-[var(--foreground-muted)]">
                            {formatProgressTimestamp(event.occurred_at)}
                          </p>
                        </div>
                        <p className="mt-2 text-xs font-bold uppercase tracking-[0.08em] text-[var(--primary-blue)]">
                          {event.source_channel}
                        </p>
                        {event.snippet && (
                          <p className="mt-2 text-sm font-medium leading-relaxed text-[var(--foreground-soft)]">
                            {event.snippet}
                          </p>
                        )}
                      </article>
                    ))}
                  </div>
                ) : (
                  <div className="bauhaus-panel-sm mt-3 bg-[var(--surface-muted)] px-4 py-4 text-sm font-medium text-[var(--foreground-muted)]">
                    这次投递暂时没有已确认的阶段事件。
                  </div>
                )}
              </div>

              {progressTimeline?.pending_candidates?.length ? (
                <div className="bauhaus-panel-sm border-amber-500 bg-amber-50 px-4 py-4 text-sm font-semibold leading-relaxed text-amber-950">
                  还有 {progressTimeline.pending_candidates.length} 条外部进展候选待审核；它们尚未改变正式投递状态。
                </div>
              ) : null}
            </>
          )}
        </CardBody>
      </Card>

      <Card className="bauhaus-panel rounded-none bg-white shadow-none" data-testid="job-next-preparation">
        <CardBody className="space-y-4 p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="bauhaus-label text-[var(--foreground-muted)]">Next preparation</p>
              <h2 className="mt-2 text-2xl font-black tracking-[-0.05em] text-[var(--foreground)]">
                {interviewPreparationPriority ? "面试准备优先" : "下一步准备"}
              </h2>
              <p className="mt-2 max-w-2xl text-sm font-medium leading-relaxed text-[var(--foreground-soft)]">
                {currentApplicationStage
                  ? `${selectedRecordIsOpportunity ? "当前目标岗位状态为" : `当前阶段${hasConfirmedStageEvent ? "已由确认事件确定为" : "在投递记录中显示为"}`}「${applicationStageLabel(currentApplicationStage)}」。${currentNextAction || "先核对下一动作。"}`
                  : "尚未有已确认的投递阶段；先完成投递或审核最新进展，再生成岗位上下文。"}
              </p>
            </div>
            {interviewPreparationPriority && (
              <Chip color="primary" variant="flat" className="font-black">
                {applicationStageLabel(currentApplicationStage)}
              </Chip>
            )}
          </div>
          {interviewPreparationPriority && (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border)] pt-4">
              <p className="max-w-xl text-xs font-semibold leading-relaxed text-[var(--foreground-muted)]">
                下面的岗位情报会提供 Role Delta 与 Career Evidence Gap；专项训练的 Focus Plan 仍由这些已验证数据确定。
              </p>
              <Button
                data-testid="job-open-interview-focus"
                onPress={() => document.getElementById("role-intelligence-panel")?.scrollIntoView({ behavior: "smooth", block: "start" })}
                className="bauhaus-button bauhaus-button-blue !px-4 !py-3 !text-[11px]"
              >
                查看岗位情报与专项训练
              </Button>
            </div>
          )}
        </CardBody>
      </Card>

      <RoleIntelligencePanel jobId={job.id} />

      <Card className="bauhaus-panel rounded-none bg-white shadow-none" data-testid="resume-proposal">
        <CardBody className="space-y-5 p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="bauhaus-label text-[var(--foreground-muted)]">Material candidate</p>
              <h2 className="mt-2 text-2xl font-black uppercase tracking-[-0.05em] text-[var(--foreground)]">
                材料候选
              </h2>
              <p className="mt-2 max-w-2xl text-sm font-medium leading-relaxed text-[var(--foreground-soft)]">
                岗位准备完成后，OfferU 会从已验证职业事实生成可审核的简历候选。接受前不会覆盖正式简历。
              </p>
            </div>
            <Button
              isIconOnly
              aria-label="刷新材料候选"
              variant="light"
              isLoading={resumeProposalLoading}
              onPress={() => void loadResumeProposal()}
              className="min-h-11 min-w-11 border border-[var(--border)] bg-[var(--surface)] text-[var(--foreground)]"
            >
              <RefreshCw size={17} />
            </Button>
          </div>

          {resumeProposalError && (
            <div role="alert" className="bauhaus-panel-sm border-[var(--primary-red)] bg-red-50 px-4 py-3 text-sm font-semibold text-red-800">
              {resumeProposalError}
            </div>
          )}

          {resumeProposalLoading && !resumeProposal ? (
            <div className="bauhaus-panel-sm flex items-center gap-3 bg-[var(--surface-muted)] px-4 py-4">
              <Spinner size="sm" color="warning" />
              <span className="text-sm font-semibold text-[var(--foreground-soft)]">正在读取材料候选...</span>
            </div>
          ) : !resumeProposal ? (
            <div className="bauhaus-panel-sm bg-[var(--surface-muted)] px-4 py-4">
              <p className="text-sm font-black text-[var(--foreground)]">材料候选尚未生成</p>
              <p className="mt-1 text-sm font-medium leading-relaxed text-[var(--foreground-muted)]">
                岗位情报和已验证职业事实准备好后，这里会出现一份带依据的候选简历。
              </p>
            </div>
          ) : (
            (() => {
              const proposalIsFixture =
                resumeProposal.strategy?.research?.data_mode === "fixture" ||
                Boolean(resumeProposal.trace?.pipeline?.fixture_replay);
              const missingCapabilities = Array.isArray(resumeProposal.strategy?.missing_capabilities)
                ? resumeProposal.strategy.missing_capabilities.filter(Boolean).slice(0, 8)
                : [];
              const diffItems = Array.isArray(resumeProposal.diff) ? resumeProposal.diff : [];
              return (
                <>
                  <div className="grid gap-3 sm:grid-cols-3">
                    <div className="bauhaus-panel-sm bg-[var(--surface-muted)] p-4">
                      <p className="bauhaus-label text-[var(--foreground-muted)]">状态</p>
                      <p className="mt-2 text-sm font-black text-[var(--foreground)]">
                        {resumeProposal.status === "ready"
                          ? "等待审核"
                          : resumeProposal.status === "accepted"
                            ? "已接受"
                            : resumeProposal.status === "rejected"
                              ? "已拒绝"
                              : resumeProposal.status}
                      </p>
                    </div>
                    <div className="bauhaus-panel-sm bg-[var(--surface-muted)] p-4">
                      <p className="bauhaus-label text-[var(--foreground-muted)]">事实门</p>
                      <p className="mt-2 text-sm font-black text-[var(--foreground)]">
                        {resumeProposal.fact_gate_status === "passed" ? "已通过" : resumeProposal.fact_gate_status}
                      </p>
                    </div>
                    <div className="bauhaus-panel-sm bg-[var(--surface-muted)] p-4">
                      <p className="bauhaus-label text-[var(--foreground-muted)]">候选变化</p>
                      <p className="mt-2 text-sm font-black text-[var(--foreground)]">
                        {resumeProposal.change_count > 0
                          ? `${resumeProposal.change_count} 项可审核变化`
                          : "保留已验证事实"}
                      </p>
                    </div>
                  </div>

                  {proposalIsFixture && (
                    <div className="bauhaus-panel-sm border-amber-500 bg-amber-50 px-4 py-3 text-sm font-semibold leading-relaxed text-amber-950">
                      本地 Fixture / Replay 已生成候选，仅用于内测链路验证，不代表真实市场研究或未经证实的能力。
                    </div>
                  )}

                  {resumeProposal.status === "accepted" && (
                    <div className="bauhaus-panel-sm flex items-start gap-3 border-emerald-600 bg-emerald-50 px-4 py-4 text-sm font-semibold text-emerald-900">
                      <CheckCircle2 className="mt-0.5 shrink-0" size={18} />
                      资料已生成，正式简历和版本快照已保存（Resume #{resumeProposal.accepted_resume_id}）。
                    </div>
                  )}

                  {resumeProposal.status === "rejected" && (
                    <div className="bauhaus-panel-sm flex items-start gap-3 border-[var(--primary-red)] bg-red-50 px-4 py-4 text-sm font-semibold text-red-900">
                      <XCircle className="mt-0.5 shrink-0" size={18} />
                      材料候选已拒绝，不会改动正式简历。{resumeProposal.review_note ? `原因：${resumeProposal.review_note}` : ""}
                    </div>
                  )}

                  {resumeProposal.status === "ready" && (
                    <>
                      {diffItems.length > 0 ? (
                        <div>
                          <p className="bauhaus-label text-[var(--foreground-muted)]">变更预览</p>
                          <div className="mt-3 space-y-3">
                            {diffItems.map((change, index) => (
                              <article key={String(change.change_id || index)} className="bauhaus-panel-sm bg-[var(--surface-muted)] p-4">
                                <div className="flex flex-wrap items-center gap-2">
                                  <Chip size="sm" variant="flat" className="border border-[var(--border)] bg-white font-bold text-[var(--foreground)]">
                                    {change.change_type === "added" ? "新增" : change.change_type === "removed" ? "移除" : "修改"}
                                  </Chip>
                                  <span className="text-sm font-black text-[var(--foreground)]">{change.title || "简历条目"}</span>
                                </div>
                                <p className="mt-3 text-sm font-medium leading-relaxed text-[var(--foreground-soft)]">
                                  原内容：{resumeProposalRowText(change.before)}
                                </p>
                                <p className="mt-2 text-sm font-medium leading-relaxed text-[var(--foreground)]">
                                  候选内容：{resumeProposalRowText(change.after)}
                                </p>
                              </article>
                            ))}
                          </div>
                        </div>
                      ) : (
                        <div className="bauhaus-panel-sm bg-[var(--surface-muted)] p-4">
                          <p className="text-sm font-black text-[var(--foreground)]">当前没有安全的事实改写</p>
                          <p className="mt-2 text-sm font-medium leading-relaxed text-[var(--foreground-soft)]">
                            OfferU 保留了你的已验证事实，没有为了匹配岗位而编造新经历。{missingCapabilities.length > 0 ? ` 当前仍缺少：${missingCapabilities.join("、")}` : ""}
                          </p>
                        </div>
                      )}

                      <div className="space-y-3">
                        <label htmlFor="resume-proposal-review-note" className="bauhaus-label text-[var(--foreground-muted)]">
                          审核备注（拒绝时必填）
                        </label>
                        <textarea
                          id="resume-proposal-review-note"
                          data-testid="resume-proposal-review-note"
                          value={resumeProposalNote}
                          onChange={(event) => setResumeProposalNote(event.target.value)}
                          maxLength={2000}
                          rows={3}
                          placeholder="记录你接受或拒绝这份候选的依据。"
                          className="w-full border border-[var(--border-strong)] bg-white px-4 py-3 text-sm font-medium text-[var(--foreground)] outline-none focus:border-[var(--primary-blue)]"
                        />
                        <div className="grid gap-3 sm:grid-cols-2">
                          <Button
                            data-testid="resume-proposal-accept"
                            onPress={() => void handleResumeProposalReview("accept")}
                            isLoading={resumeProposalAction === "accept"}
                            isDisabled={resumeProposalAction === "reject" || resumeProposal.fact_gate_status !== "passed"}
                            startContent={<CheckCircle2 size={17} />}
                            className="bauhaus-button bauhaus-button-blue !justify-center !px-4 !py-3 !text-[11px]"
                          >
                            接受并生成简历
                          </Button>
                          <Button
                            data-testid="resume-proposal-reject"
                            onPress={() => void handleResumeProposalReview("reject")}
                            isLoading={resumeProposalAction === "reject"}
                            isDisabled={resumeProposalAction === "accept"}
                            startContent={<XCircle size={17} />}
                            className="bauhaus-button bauhaus-button-outline !justify-center !px-4 !py-3 !text-[11px]"
                          >
                            拒绝候选
                          </Button>
                        </div>
                      </div>
                    </>
                  )}
                </>
              );
            })()
          )}
        </CardBody>
      </Card>

      <Card className="bauhaus-panel rounded-none bg-white shadow-none" data-testid="job-research-handback">
        <CardBody className="space-y-5 p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="bauhaus-label text-[var(--foreground-muted)]">Evidence handback</p>
              <h2 className="mt-2 text-2xl font-black uppercase tracking-[-0.05em] text-[var(--foreground)]">
                调研证据审核
              </h2>
              <p className="mt-2 max-w-2xl text-sm font-medium leading-relaxed text-[var(--foreground-soft)]">
                外部 Coding Agent 的调研结果先作为候选证据返回。只有你接受后，投前决策、简历优化和 AI 面试才能使用。
              </p>
            </div>
            <Button
              isIconOnly
              aria-label="刷新调研证据"
              variant="light"
              isLoading={researchLoading}
              onPress={() => void loadResearch()}
              className="min-h-11 min-w-11 border border-[var(--border)] bg-[var(--surface)] text-[var(--foreground)]"
            >
              <RefreshCw size={17} />
            </Button>
          </div>

          {researchError && (
            <div className="bauhaus-panel-sm border-[var(--primary-red)] bg-red-50 px-4 py-3 text-sm font-semibold text-red-800">
              {researchError}
            </div>
          )}

          {researchLoading && !research ? (
            <div className="bauhaus-panel-sm flex items-center gap-3 bg-[var(--surface-muted)] px-4 py-4">
              <Spinner size="sm" color="warning" />
              <span className="text-sm font-semibold text-[var(--foreground-soft)]">正在读取最新调研运行...</span>
            </div>
          ) : !research ? (
            <div className="bauhaus-panel-sm bg-[var(--surface-muted)] px-4 py-4">
              <p className="text-sm font-black text-[var(--foreground)]">还没有调研证据</p>
              <p className="mt-1 text-sm font-medium leading-relaxed text-[var(--foreground-muted)]">
                在 OfferU Agent 中使用“公司与岗位调研”技能。运行完成后，候选证据会出现在这里等待你的审核。
              </p>
            </div>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="bauhaus-panel-sm bg-[var(--surface-muted)] p-4">
                  <p className="bauhaus-label text-[var(--foreground-muted)]">运行</p>
                  <p className="mt-2 truncate text-sm font-black text-[var(--foreground)]" title={research.run_id}>
                    {research.run_id}
                  </p>
                </div>
                <div className="bauhaus-panel-sm bg-[var(--surface-muted)] p-4">
                  <p className="bauhaus-label text-[var(--foreground-muted)]">证据 / 结论</p>
                  <p className="mt-2 text-2xl font-black text-[var(--foreground)]">
                    {research.source_count} / {research.finding_count}
                  </p>
                </div>
                <div className="bauhaus-panel-sm bg-[var(--surface-muted)] p-4">
                  <p className="bauhaus-label text-[var(--foreground-muted)]">审核状态</p>
                  <p className="mt-2 text-sm font-black uppercase text-[var(--foreground)]">
                    {research.review_status === "candidate"
                      ? "等待审核"
                      : research.review_status === "accepted"
                        ? "已接受"
                        : research.review_status === "rejected"
                          ? "已拒绝"
                          : research.status}
                  </p>
                </div>
              </div>

              {research.status !== "completed" ? (
                <div className="bauhaus-panel-sm bg-[var(--surface-muted)] px-4 py-4 text-sm font-semibold text-[var(--foreground-soft)]">
                  {research.status === "failed"
                    ? `调研失败：${research.error || "没有可用错误信息"}`
                    : `调研正在处理中，当前状态：${research.status}`}
                </div>
              ) : (
                <>
                  {research.review_status === "candidate" && (
                    <div className="bauhaus-panel-sm border-amber-500 bg-amber-50 px-4 py-4 text-sm font-semibold leading-relaxed text-amber-950">
                      这些内容还不是 OfferU 的可消费事实。请检查来源、结论和信息缺口，再明确接受或拒绝。
                    </div>
                  )}
                  {research.review_status === "accepted" && (
                    <div className="bauhaus-panel-sm flex items-start gap-3 border-emerald-600 bg-emerald-50 px-4 py-4 text-sm font-semibold text-emerald-900">
                      <CheckCircle2 className="mt-0.5 shrink-0" size={18} />
                      {research.data_mode === "fixture"
                        ? "本地 Fixture 已预审核，仅用于内测链路验证，不代表真实市场证据。"
                        : "已发布到公司与岗位档案，下游 Agent 可以引用这些证据。"}
                    </div>
                  )}
                  {research.review_status === "rejected" && (
                    <div className="bauhaus-panel-sm flex items-start gap-3 border-[var(--primary-red)] bg-red-50 px-4 py-4 text-sm font-semibold text-red-900">
                      <XCircle className="mt-0.5 shrink-0" size={18} />
                      已拒绝并从可消费档案中隔离；运行和证据仍保留用于审计。
                    </div>
                  )}

                  <div>
                    <p className="bauhaus-label text-[var(--foreground-muted)]">结论与引用</p>
                    <div className="mt-3 space-y-3">
                      {research.findings.map((finding) => (
                        <article key={finding.id} className="bauhaus-panel-sm bg-white p-4">
                          <div className="flex flex-wrap items-center gap-2">
                            <Chip size="sm" variant="flat" className="border border-[var(--border)] bg-[var(--surface-muted)] font-bold text-[var(--foreground)]">
                              {finding.finding_type}
                            </Chip>
                            <Chip size="sm" variant="flat" className="border border-[var(--border)] bg-white font-bold text-[var(--foreground-soft)]">
                              {finding.evidence_level}
                            </Chip>
                          </div>
                          <p className="mt-3 text-sm font-semibold leading-relaxed text-[var(--foreground)]">
                            {finding.statement}
                          </p>
                          <p className="mt-2 text-xs font-bold uppercase tracking-[0.08em] text-[var(--foreground-muted)]">
                            引用 {finding.source_refs.join(" · ")}
                          </p>
                        </article>
                      ))}
                    </div>
                  </div>

                  <div>
                    <p className="bauhaus-label text-[var(--foreground-muted)]">来源快照</p>
                    <div className="mt-3 grid gap-3 md:grid-cols-2">
                      {research.evidence.map((source) => (
                        <article key={source.id} className="bauhaus-panel-sm bg-[var(--surface-muted)] p-4">
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <p className="text-xs font-black uppercase tracking-[0.08em] text-[var(--primary-blue)]">
                                {source.source_ref} · {source.source_class}
                              </p>
                              <p className="mt-2 text-sm font-black text-[var(--foreground)]">{source.title}</p>
                              <p className="mt-1 text-xs font-semibold text-[var(--foreground-muted)]">{source.publisher}</p>
                            </div>
                            <Link
                              href={source.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              aria-label={`打开来源 ${source.source_ref}`}
                              className="shrink-0 text-[var(--primary-blue)]"
                            >
                              <ExternalLink size={16} />
                            </Link>
                          </div>
                          <p className="mt-3 text-sm font-medium leading-relaxed text-[var(--foreground-soft)]">
                            {source.excerpt}
                          </p>
                        </article>
                      ))}
                    </div>
                  </div>

                  {Array.isArray(research.result.gaps) && research.result.gaps.length > 0 && (
                    <div className="bauhaus-panel-sm bg-[var(--surface-muted)] p-4">
                      <p className="bauhaus-label text-[var(--foreground-muted)]">仍未知</p>
                      <ul className="mt-3 space-y-2 text-sm font-medium text-[var(--foreground-soft)]">
                        {research.result.gaps.map((gap, index) => (
                          <li key={`${index}-${gap}`} className="flex gap-2">
                            <span aria-hidden>—</span>
                            <span>{gap}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {research.review_status === "candidate" ? (
                    <div className="space-y-3">
                      <label htmlFor="research-review-note" className="bauhaus-label text-[var(--foreground-muted)]">
                        审核备注（拒绝时必填）
                      </label>
                      <textarea
                        id="research-review-note"
                        value={reviewNote}
                        onChange={(event) => setReviewNote(event.target.value)}
                        maxLength={2000}
                        rows={3}
                        placeholder="记录来源疑点、需要补查的内容，或接受依据。"
                        className="w-full border border-[var(--border-strong)] bg-white px-4 py-3 text-sm font-medium text-[var(--foreground)] outline-none focus:border-[var(--primary-blue)]"
                      />
                      <div className="grid gap-3 sm:grid-cols-2">
                        <Button
                          onPress={() => void handleResearchReview("accept")}
                          isLoading={reviewAction === "accept"}
                          isDisabled={reviewAction === "reject"}
                          startContent={<CheckCircle2 size={17} />}
                          className="bauhaus-button bauhaus-button-blue !justify-center !px-4 !py-3 !text-[11px]"
                        >
                          接受并发布证据
                        </Button>
                        <Button
                          onPress={() => void handleResearchReview("reject")}
                          isLoading={reviewAction === "reject"}
                          isDisabled={reviewAction === "accept"}
                          startContent={<XCircle size={17} />}
                          className="bauhaus-button bauhaus-button-red !justify-center !px-4 !py-3 !text-[11px]"
                        >
                          拒绝并隔离
                        </Button>
                      </div>
                    </div>
                  ) : research.review_note ? (
                    <div className="bauhaus-panel-sm bg-[var(--surface-muted)] p-4">
                      <p className="bauhaus-label text-[var(--foreground-muted)]">审核备注</p>
                      <p className="mt-2 text-sm font-medium leading-relaxed text-[var(--foreground-soft)]">
                        {research.review_note}
                      </p>
                    </div>
                  ) : null}
                </>
              )}
            </>
          )}
        </CardBody>
      </Card>

      <Card className="bauhaus-panel rounded-none bg-white shadow-none" data-testid="pre-application-decision">
        <CardBody className="space-y-5 p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="bauhaus-label text-[var(--foreground-muted)]">Decision gate</p>
              <h2 className="mt-2 text-2xl font-black uppercase tracking-[-0.05em] text-[var(--foreground)]">
                投前决策
              </h2>
              <p className="mt-2 max-w-2xl text-sm font-medium leading-relaxed text-[var(--foreground-soft)]">
                只有审核通过的投前决策，才能进入该岗位的简历提案；不投和证据不足会在这里结束。
              </p>
            </div>
            <Button
              isIconOnly
              aria-label="刷新投前决策"
              variant="light"
              isLoading={preApplicationLoading}
              onPress={() => void loadPreApplication()}
              className="min-h-11 min-w-11 border border-[var(--border)] bg-[var(--surface)] text-[var(--foreground)]"
            >
              <RefreshCw size={17} />
            </Button>
          </div>

          {preApplicationError && (
            <div className="bauhaus-panel-sm border-[var(--primary-red)] bg-red-50 px-4 py-3 text-sm font-semibold text-red-800">
              {preApplicationError}
            </div>
          )}

          {preApplicationLoading && !preApplication ? (
            <div className="bauhaus-panel-sm flex items-center gap-3 bg-[var(--surface-muted)] px-4 py-4">
              <Spinner size="sm" color="warning" />
              <span className="text-sm font-semibold text-[var(--foreground-soft)]">正在读取投前决策状态...</span>
            </div>
          ) : !preApplication ? (
            <div className="bauhaus-panel-sm bg-[var(--surface-muted)] px-4 py-4">
              <p className="text-sm font-black text-[var(--foreground)]">投前决策暂不可用</p>
              <p className="mt-1 text-sm font-medium leading-relaxed text-[var(--foreground-muted)]">
                请先完成岗位调研并接受候选证据。
              </p>
            </div>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="bauhaus-panel-sm bg-[var(--surface-muted)] p-4">
                  <p className="bauhaus-label text-[var(--foreground-muted)]">当前阶段</p>
                  <p className="mt-2 text-sm font-black text-[var(--foreground)]">
                    {PRE_APPLICATION_STAGE_LABELS[preApplication.stage] || preApplication.stage}
                  </p>
                </div>
                <div className="bauhaus-panel-sm bg-[var(--surface-muted)] p-4">
                  <p className="bauhaus-label text-[var(--foreground-muted)]">职业证据</p>
                  <p className="mt-2 text-2xl font-black text-[var(--foreground)]">
                    {preApplication.profile_evidence_count}
                  </p>
                </div>
                <div className="bauhaus-panel-sm bg-[var(--surface-muted)] p-4">
                  <p className="bauhaus-label text-[var(--foreground-muted)]">最新调研</p>
                  <p className="mt-2 text-sm font-black text-[var(--foreground)]">
                    {preApplication.research_run?.status || "未开始"}
                  </p>
                </div>
              </div>

              {preApplication.stage === "needs_decision" && (
                <div className="bauhaus-panel-sm border-amber-500 bg-amber-50 p-4">
                  <p className="text-sm font-semibold leading-relaxed text-amber-950">
                    岗位、职业证据和已接受调研已经准备好，可以生成一份带来源的投前决策建议。
                  </p>
                  <Button
                    onPress={() => void handlePreparePreApplication()}
                    isLoading={preApplicationAction === "prepare"}
                    className="bauhaus-button bauhaus-button-blue mt-4 !px-4 !py-3 !text-[11px]"
                  >
                    生成投前决策建议
                  </Button>
                </div>
              )}

              {preApplication.decision && (
                <>
                  <div className="bauhaus-panel-sm bg-[var(--surface-muted)] p-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p className="bauhaus-label text-[var(--foreground-muted)]">Agent 建议</p>
                        <p className="mt-2 text-2xl font-black text-[var(--foreground)]">
                          {PRE_APPLICATION_DECISION_LABELS[preApplication.decision.agent_recommendation]}
                        </p>
                      </div>
                      {preApplication.decision.final_decision && (
                        <Chip className="border border-[var(--border)] bg-white font-bold text-[var(--foreground)]">
                          最终：{PRE_APPLICATION_DECISION_LABELS[preApplication.decision.final_decision]}
                        </Chip>
                      )}
                    </div>
                    <p className="mt-4 text-sm font-semibold leading-relaxed text-[var(--foreground-soft)]">
                      {preApplication.decision.decision.rationale}
                    </p>
                  </div>

                  <div className="grid gap-4 md:grid-cols-2">
                    {decisionSections.map(([label, items]) => (
                      <div key={label} className="bauhaus-panel-sm bg-[var(--surface-muted)] p-4">
                        <p className="bauhaus-label text-[var(--foreground-muted)]">{label}</p>
                        {items.length > 0 ? (
                          <ul className="mt-3 space-y-2 text-sm font-medium leading-relaxed text-[var(--foreground-soft)]">
                            {items.map((item) => <li key={item}>— {item}</li>)}
                          </ul>
                        ) : (
                          <p className="mt-3 text-sm font-medium text-[var(--foreground-muted)]">暂无</p>
                        )}
                      </div>
                    ))}
                  </div>

                  <div>
                    <p className="bauhaus-label text-[var(--foreground-muted)]">逐条来源</p>
                    <div className="mt-3 space-y-3">
                      {preApplication.decision.decision.evidence.map((item, index) => (
                        <article key={`${item.claim}-${index}`} className="bauhaus-panel-sm bg-white p-4">
                          <div className="flex flex-wrap items-center gap-2">
                            <Chip size="sm" variant="flat" className="border border-[var(--border)] bg-[var(--surface-muted)] font-bold text-[var(--foreground)]">
                              {item.kind}
                            </Chip>
                            <span className="text-xs font-black uppercase tracking-[0.08em] text-[var(--primary-blue)]">
                              {item.source_refs.join(" · ")}
                            </span>
                          </div>
                          <p className="mt-3 text-sm font-semibold leading-relaxed text-[var(--foreground)]">
                            {item.claim}
                          </p>
                        </article>
                      ))}
                    </div>
                  </div>

                  {preApplication.stage === "needs_decision_review" && (
                    <div className="space-y-3">
                      <Select
                        label="你的最终选择"
                        selectedKeys={decisionChoice ? [decisionChoice] : []}
                        onSelectionChange={(keys) => {
                          const value = Array.from(keys)[0] as PreApplicationDecisionChoice | undefined;
                          setDecisionChoice(value || "");
                        }}
                        classNames={bauhausSelectClassNames}
                      >
                        {PRE_APPLICATION_DECISION_OPTIONS.map((option) => (
                          <SelectItem key={option.value}>{option.label}</SelectItem>
                        ))}
                      </Select>
                      <label htmlFor="pre-application-decision-note" className="bauhaus-label text-[var(--foreground-muted)]">
                        覆盖建议时的理由（覆盖 Agent 建议必填）
                      </label>
                      <textarea
                        id="pre-application-decision-note"
                        value={decisionNote}
                        onChange={(event) => setDecisionNote(event.target.value)}
                        maxLength={2000}
                        rows={3}
                        placeholder="记录你接受或覆盖建议的依据。"
                        className="w-full border border-[var(--border-strong)] bg-white px-4 py-3 text-sm font-medium text-[var(--foreground)] outline-none focus:border-[var(--primary-blue)]"
                      />
                      <Button
                        onPress={() => void handlePreApplicationReview()}
                        isLoading={preApplicationAction === "review"}
                        isDisabled={!decisionChoice}
                        className="bauhaus-button bauhaus-button-blue !px-4 !py-3 !text-[11px]"
                      >
                        保存最终投前决策
                      </Button>
                    </div>
                  )}

                  {preApplication.stage === "ready_for_resume_proposal" && (
                    <div className="bauhaus-panel-sm border-emerald-600 bg-emerald-50 p-4">
                      <p className="text-sm font-semibold leading-relaxed text-emerald-900">
                        你已经确认投或有条件投，现在可以进入简历提案工作区。
                      </p>
                      <Button
                        as={Link}
                        href={`/optimize?job_ids=${job.id}`}
                        className="bauhaus-button bauhaus-button-blue mt-4 !px-4 !py-3 !text-[11px]"
                      >
                        进入简历提案
                      </Button>
                    </div>
                  )}

                  {(preApplication.stage === "completed_no_go" ||
                    preApplication.stage === "completed_insufficient_evidence") && (
                    <div className="bauhaus-panel-sm border-[var(--border-strong)] bg-[var(--surface-muted)] p-4 text-sm font-semibold leading-relaxed text-[var(--foreground-soft)]">
                      当前投前决策已结束，不会创建该岗位的简历提案或投递尝试。
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </CardBody>
      </Card>

      <Card className="bauhaus-panel rounded-none bg-white shadow-none">
        <CardBody className="space-y-4 p-5">
          <div>
            <p className="bauhaus-label text-[var(--foreground-muted)]">原始描述</p>
            <h2 className="mt-2 text-2xl font-black uppercase tracking-[-0.05em] text-[var(--foreground)]">职位描述</h2>
          </div>
          {job.raw_description ? (
            <div className="bauhaus-panel-sm max-h-[460px] overflow-auto bg-[var(--surface-muted)] p-4">
              <pre className="whitespace-pre-wrap text-sm font-medium leading-relaxed text-[var(--foreground-soft)]">
                {job.raw_description}
              </pre>
            </div>
          ) : (
            <div className="bauhaus-panel-sm bg-[var(--surface-muted)] px-4 py-4 text-sm font-medium text-[var(--foreground-muted)]">
              暂无 JD 原文内容。
            </div>
          )}
        </CardBody>
      </Card>

      {job.keywords?.length > 0 && (
        <section className="flex flex-wrap gap-2">
          {job.keywords.map((keyword, index) => (
            <Chip
              key={keyword}
              size="sm"
              variant="flat"
              className={`border border-[var(--border)] font-semibold ${
                index % 3 === 0
                  ? "bg-[var(--primary-red)] text-white"
                  : index % 3 === 1
                    ? "bg-[var(--surface-muted)] text-[var(--foreground)]"
                    : "bg-white text-[var(--foreground)]"
              }`}
            >
              {keyword}
            </Chip>
          ))}
        </section>
      )}

      <section className="grid gap-3 md:grid-cols-2">
        <Button onPress={() => setJoinModalOpen(true)} isLoading={actionLoading === "join"} className="bauhaus-button bauhaus-button-yellow !justify-center !px-4 !py-3 !text-[11px]">
          加入已筛选
        </Button>
        <Button onPress={() => setTrashConfirmOpen(true)} isLoading={actionLoading === "trash"} isDisabled={actionLoading === "join"} className="bauhaus-button bauhaus-button-red !justify-center !px-4 !py-3 !text-[11px]">
          移入回收站
        </Button>
        {job.url ? (
          <Button
            as={Link}
            href={job.url}
            target="_blank"
            rel="noopener noreferrer"
            endContent={<ExternalLink size={16} />}
            className="bauhaus-button bauhaus-button-outline !justify-center !px-4 !py-3 !text-[11px]"
          >
            查看原文
          </Button>
        ) : (
          <Button isDisabled className="bauhaus-button bauhaus-button-outline !justify-center !px-4 !py-3 !text-[11px] opacity-60">
            查看原文
          </Button>
        )}
        {preApplication?.stage === "ready_for_resume_proposal" || preApplication?.stage === "resume_proposal_ready" ? (
          <Button
            as={Link}
            href={`/optimize?job_ids=${job.id}`}
            endContent={<Send size={16} />}
            className="bauhaus-button bauhaus-button-blue !justify-center !px-4 !py-3 !text-[11px]"
          >
            进入简历提案
          </Button>
        ) : (
          <Button
            isDisabled
            className="bauhaus-button bauhaus-button-blue !justify-center !px-4 !py-3 !text-[11px] opacity-50"
          >
            完成投前决策后可进入简历提案
          </Button>
        )}
      </section>

      <Modal isOpen={joinModalOpen} onClose={() => setJoinModalOpen(false)} size="md">
        <ModalContent className={bauhausModalContentClassName}>
          <ModalHeader className="border-b border-[var(--border)] bg-[var(--surface-muted)] px-6 py-5 text-xl font-black tracking-[-0.06em]">
            加入已筛选
          </ModalHeader>
          <ModalBody className="space-y-3 px-6 py-6">
            <p className="text-sm font-medium leading-relaxed text-[var(--foreground-soft)]">选择目标池，确认后将该岗位流转到已筛选。</p>
            <Select
              aria-label="目标已筛选池"
              selectedKeys={[targetPool]}
              onSelectionChange={(keys) => setTargetPool(Array.from(keys)[0] as string)}
              items={poolOptions}
              classNames={bauhausSelectClassNames}
            >
              {(item) => <SelectItem key={item.key}>{item.label}</SelectItem>}
            </Select>
          </ModalBody>
          <ModalFooter className="border-t border-[var(--border-strong)] px-6 py-5">
            <Button variant="light" onPress={() => setJoinModalOpen(false)} className="bauhaus-button bauhaus-button-outline !px-4 !py-3 !text-[11px]">
              取消
            </Button>
            <Button onPress={handleJoinPicked} isLoading={actionLoading === "join"} className="bauhaus-button bauhaus-button-blue !px-4 !py-3 !text-[11px]">
              确认加入
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      <Modal isOpen={trashConfirmOpen} onClose={() => setTrashConfirmOpen(false)} size="md">
        <ModalContent className={bauhausModalContentClassName}>
          <ModalHeader className="border-b border-[var(--border)] bg-[var(--surface-muted)] px-6 py-5 text-xl font-black tracking-[-0.06em] text-[var(--foreground)]">
            移入回收站
          </ModalHeader>
          <ModalBody className="px-6 py-6">
            <p className="text-sm font-medium leading-relaxed text-[var(--foreground-soft)]">
              确认将该岗位移入回收站吗？移入后可在回收站页面恢复或永久删除。
            </p>
          </ModalBody>
          <ModalFooter className="border-t border-[var(--border-strong)] px-6 py-5">
            <Button variant="light" onPress={() => setTrashConfirmOpen(false)} className="bauhaus-button bauhaus-button-outline !px-4 !py-3 !text-[11px]">
              取消
            </Button>
            <Button isLoading={actionLoading === "trash"} onPress={handleMoveToTrash} className="bauhaus-button bauhaus-button-red !px-4 !py-3 !text-[11px]">
              确认移入
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </motion.div>
  );
}
