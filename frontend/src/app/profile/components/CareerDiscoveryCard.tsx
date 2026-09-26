import { useState } from "react";
import { AlertCircle, Check, LoaderCircle, RefreshCw, Sparkles } from "lucide-react";
import { CareerQuestionsPanel } from "@/components/career/CareerQuestionsPanel";

export type CareerTrack = "campus" | "experienced";
export type CareerConfidence = "high" | "medium" | "low";
export type CareerSubstage =
  | "internship"
  | "fresh_graduate"
  | "early_career"
  | "experienced_ic"
  | "manager"
  | "executive"
  | "career_switch";

export interface CareerStageAssessment {
  track: CareerTrack;
  substage: CareerSubstage;
  confidence: CareerConfidence;
  basis: string[];
}

export interface CareerProfileCoverage {
  strong_evidence: string[];
  weak_evidence: string[];
  missing_evidence: string[];
  unknowns: string[];
  underexpressed_strengths: string[];
}

export interface CareerSnapshot {
  identity: {
    career_stage: CareerStageAssessment | null;
    career_stage_source?: "user_confirmed" | null;
    experience_years: number | null;
    current_role: string | null;
    employment_state: string | null;
  };
  goals: {
    primary_roles: string[];
    secondary_roles?: string[];
    locations: string[];
    compensation: string | null;
    timing: string | null;
  };
  profile_coverage: CareerProfileCoverage;
}

export interface CareerBriefing {
  career_stage: CareerStageAssessment | null;
  strategy_pack: "campus_search.v1" | "experienced_search.v1";
  profile_coverage: CareerProfileCoverage;
  situation_summary: string;
  questions: Array<{
    question: string;
    why_needed: string;
    unlocks: string;
    optional: boolean;
  }>;
}


export interface CareerDiscoveryCardProps {
  snapshot: CareerSnapshot | null;
  briefing: CareerBriefing | null;
  status: "idle" | "queued" | "running" | "completed" | "failed";
  error?: string;
  /** 产生这次简报的真实 CareerTask；只有拿到它才能提交并审核问题答案。 */
  taskId?: string;
  onStart(): void;
  onRefresh(): void;
  onCorrect(stage: { track: CareerTrack; substage: CareerSubstage }): void;
  /** 回答被保存/采纳后触发（例如刷新快照或受影响提案）。 */
  onAnswered?(): void;
}

const STAGE_LABELS: Record<CareerSubstage, string> = {
  internship: "实习求职",
  fresh_graduate: "应届求职",
  early_career: "早期职业发展",
  experienced_ic: "资深专业岗位",
  manager: "管理岗位",
  executive: "高层管理岗位",
  career_switch: "转行求职",
};

const STAGE_OPTIONS: Array<{ track: CareerTrack; substage: CareerSubstage }> = [
  { track: "campus", substage: "internship" },
  { track: "campus", substage: "fresh_graduate" },
  { track: "experienced", substage: "early_career" },
  { track: "experienced", substage: "experienced_ic" },
  { track: "experienced", substage: "manager" },
  { track: "experienced", substage: "executive" },
  { track: "experienced", substage: "career_switch" },
];

const EVIDENCE_GROUPS = [
  { key: "strong_evidence", title: "已有扎实依据", empty: "暂时还没有明确的强项证据。", tone: "text-[var(--primary-green)]" },
  { key: "weak_evidence", title: "可以补强的依据", empty: "目前没有发现明显薄弱项。", tone: "text-[var(--primary-yellow)]" },
  { key: "missing_evidence", title: "还缺少的信息", empty: "暂时没有必须补充的信息。", tone: "text-[var(--foreground-soft)]" },
  { key: "unknowns", title: "还需要了解", empty: "目前没有待确认的信息。", tone: "text-[var(--foreground-soft)]" },
  { key: "underexpressed_strengths", title: "可以更好呈现的优势", empty: "暂时没有发现被低估的优势。", tone: "text-[var(--accent-clay)]" },
] as const;

function stageValue(stage: Pick<CareerStageAssessment, "track" | "substage">): string {
  return stage.track + ":" + stage.substage;
}

function stageLabel(stage: Pick<CareerStageAssessment, "track" | "substage">): string {
  return (stage.track === "campus" ? "校园求职" : "职场求职") + " · " + STAGE_LABELS[stage.substage];
}

function confidenceLabel(confidence: CareerConfidence): string {
  return { high: "高", medium: "中", low: "低" }[confidence];
}

function DetailList({ items, empty }: { items: string[]; empty: string }) {
  if (items.length === 0) return <p className="text-[12px] text-[var(--foreground-faint)]">{empty}</p>;
  return (
    <ul className="space-y-1.5 text-[12.5px] leading-5 text-[var(--foreground-soft)]">
      {items.map((item, index) => <li key={item + "-" + index} className="flex gap-2"><span aria-hidden="true">•</span><span>{item}</span></li>)}
    </ul>
  );
}

function statusMessage(status: CareerDiscoveryCardProps["status"], hasSnapshot: boolean): string {
  if (status === "queued") return "已开始准备分析，很快会继续。";
  if (status === "running") return "正在结合你的经历和求职方向进行分析…";
  if (status === "failed") return "这次分析没有完成，你可以重试。";
  if (status === "completed") return "分析已完成，你可以查看判断并随时纠正。";
  return hasSnapshot ? "可以重新分析你目前的职业方向。" : "从已有信息出发，了解你的经历和求职方向。";
}

export function CareerDiscoveryCard({
  snapshot,
  briefing,
  status,
  error,
  onStart,
  onRefresh,
  onCorrect,
  taskId,
  onAnswered,
}: CareerDiscoveryCardProps) {
  const [showCorrection, setShowCorrection] = useState(false);
  const [selectedStage, setSelectedStage] = useState("");
  const stage = snapshot?.identity.career_stage_source === "user_confirmed"
    ? snapshot.identity.career_stage
    : briefing?.career_stage ?? snapshot?.identity.career_stage ?? null;
  const busy = status === "queued" || status === "running";
  const coverage = briefing?.profile_coverage ?? snapshot?.profile_coverage;

  const openCorrection = () => {
    setSelectedStage(stage ? stageValue(stage) : "");
    setShowCorrection((visible) => !visible);
  };

  const confirmCorrection = () => {
    const selected = STAGE_OPTIONS.find((option) => stageValue(option) === selectedStage);
    if (!selected) return;
    onCorrect(selected);
    setShowCorrection(false);
  };

  return (
    <section aria-labelledby="career-discovery-title" className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)]">
      <header className="border-b border-[var(--border)] bg-[var(--surface-muted)]/60 px-4 py-4 sm:px-5">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[var(--surface)] text-[var(--accent-clay)]">
            {busy ? <LoaderCircle size={17} className="animate-spin" aria-hidden="true" /> : <Sparkles size={17} aria-hidden="true" />}
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="career-discovery-title" className="text-[15px] font-semibold text-[var(--foreground)]">认识你的求职方向</h2>
            <p role="status" aria-live="polite" className="mt-1 text-[12.5px] leading-5 text-[var(--foreground-muted)]">
              {statusMessage(status, Boolean(snapshot))}
            </p>
          </div>
        </div>

        {error && status === "failed" && (
          <p role="alert" className="mt-3 flex gap-2 rounded-md border border-[var(--primary-red)]/20 bg-[var(--status-blush)] px-3 py-2 text-[12.5px] text-[var(--primary-red)]">
            <AlertCircle size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span>{error}</span>
          </p>
        )}

        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onStart}
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-md bg-[var(--foreground)] px-3 py-2 text-[12.5px] font-medium text-white transition-colors hover:bg-[var(--foreground-soft)] disabled:cursor-wait disabled:opacity-60"
          >
            {status === "failed" ? "重试分析" : snapshot ? "重新分析" : "开始了解"}
          </button>
          {snapshot && (
            <button
              type="button"
              onClick={onRefresh}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border-strong)]/20 px-3 py-2 text-[12.5px] font-medium text-[var(--foreground-soft)] hover:bg-[var(--surface)] disabled:cursor-wait disabled:opacity-60"
            >
              <RefreshCw size={13} aria-hidden="true" />
              刷新信息
            </button>
          )}
        </div>
      </header>

      {(snapshot || briefing) && (
        <div className="space-y-5 px-4 py-4 sm:px-5">
          {briefing?.situation_summary && (
            <p className="rounded-md border border-[var(--border)] px-3 py-2.5 text-[13px] leading-5 text-[var(--foreground-soft)]">
              {briefing.situation_summary}
            </p>
          )}

          <section aria-labelledby="career-stage-heading">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 id="career-stage-heading" className="text-[13px] font-semibold text-[var(--foreground)]">目前的职业阶段</h3>
                {stage ? (
                  <p className="mt-1 text-[13px] text-[var(--foreground-soft)]">
                    {stageLabel(stage)} <span className="ml-1 text-[11.5px] text-[var(--foreground-muted)]">· 判断把握 {confidenceLabel(stage.confidence)}</span>
                  </p>
                ) : (
                  <p className="mt-1 text-[12.5px] text-[var(--foreground-muted)]">现有信息还不足以判断，后续可以继续了解。</p>
                )}
              </div>
              <button type="button" onClick={openCorrection} className="rounded px-2 py-1 text-[12px] font-medium text-[var(--accent-clay)] hover:bg-[var(--surface-muted)]">
                {showCorrection ? "收起" : "纠正判断"}
              </button>
            </div>

            {stage?.basis.length ? (
              <div className="mt-3 rounded-md bg-[var(--surface-muted)]/60 px-3 py-2.5">
                <p className="mb-1.5 text-[11.5px] font-medium text-[var(--foreground-muted)]">判断依据</p>
                <DetailList items={stage.basis} empty="暂无依据" />
              </div>
            ) : null}

            {showCorrection && (
              <div className="mt-3 flex flex-col gap-2 rounded-md border border-[var(--border)] p-3 sm:flex-row sm:items-end">
                <label className="flex-1 text-[12px] font-medium text-[var(--foreground-soft)]">
                  选择更符合你的阶段
                  <select
                    aria-label="选择你的求职阶段"
                    value={selectedStage}
                    onChange={(event) => setSelectedStage(event.target.value)}
                    className="mt-1.5 block w-full rounded-md border border-[var(--border-strong)]/20 bg-[var(--surface)] px-2.5 py-2 text-[13px] text-[var(--foreground)]"
                  >
                    <option value="">请选择</option>
                    {STAGE_OPTIONS.map((option) => (
                      <option key={stageValue(option)} value={stageValue(option)}>{stageLabel(option)}</option>
                    ))}
                  </select>
                </label>
                <button type="button" onClick={confirmCorrection} disabled={!selectedStage} className="inline-flex items-center justify-center gap-1.5 rounded-md border border-[var(--border-strong)]/20 px-3 py-2 text-[12px] font-medium text-[var(--foreground-soft)] hover:bg-[var(--surface-muted)] disabled:cursor-not-allowed disabled:opacity-50">
                  <Check size={13} aria-hidden="true" />
                  提交更正
                </button>
              </div>
            )}
          </section>

          {snapshot && (
            <section aria-labelledby="career-goals-heading">
              <h3 id="career-goals-heading" className="mb-2 text-[13px] font-semibold text-[var(--foreground)]">你目前的经历与方向</h3>
              <dl className="grid gap-x-5 gap-y-2 rounded-md bg-[var(--surface-muted)]/50 px-3 py-3 text-[12.5px] sm:grid-cols-2">
                <div><dt className="text-[11.5px] text-[var(--foreground-muted)]">当前岗位</dt><dd className="mt-0.5 text-[var(--foreground-soft)]">{snapshot.identity.current_role || "还不清楚"}</dd></div>
                <div><dt className="text-[11.5px] text-[var(--foreground-muted)]">工作年限</dt><dd className="mt-0.5 text-[var(--foreground-soft)]">{snapshot.identity.experience_years == null ? "还不清楚" : snapshot.identity.experience_years + " 年"}</dd></div>
                <div><dt className="text-[11.5px] text-[var(--foreground-muted)]">目前状态</dt><dd className="mt-0.5 text-[var(--foreground-soft)]">{snapshot.identity.employment_state || "还不清楚"}</dd></div>
                <div><dt className="text-[11.5px] text-[var(--foreground-muted)]">目标岗位</dt><dd className="mt-0.5 text-[var(--foreground-soft)]">{snapshot.goals.primary_roles.join("、") || "还不清楚"}</dd></div>
                <div><dt className="text-[11.5px] text-[var(--foreground-muted)]">意向地点</dt><dd className="mt-0.5 text-[var(--foreground-soft)]">{snapshot.goals.locations.join("、") || "还不清楚"}</dd></div>
                <div><dt className="text-[11.5px] text-[var(--foreground-muted)]">薪酬与时间安排</dt><dd className="mt-0.5 text-[var(--foreground-soft)]">{[snapshot.goals.compensation, snapshot.goals.timing].filter(Boolean).join(" · ") || "还不清楚"}</dd></div>
              </dl>
            </section>
          )}

          {coverage && (
            <section aria-labelledby="career-evidence-heading">
              <h3 id="career-evidence-heading" className="mb-3 text-[13px] font-semibold text-[var(--foreground)]">求职材料能支持到哪里</h3>
              <div className="grid gap-3 sm:grid-cols-2">
                {EVIDENCE_GROUPS.map((group) => (
                  <div key={group.key} className="rounded-md border border-[var(--border)] px-3 py-2.5">
                    <h4 className={`mb-1.5 text-[12px] font-semibold ${group.tone}`}>{group.title}</h4>
                    <DetailList items={coverage[group.key]} empty={group.empty} />
                  </div>
                ))}
              </div>
            </section>
          )}

          {briefing && briefing.questions.length > 0 && (
            <section aria-labelledby="career-questions-heading">
              <h3 id="career-questions-heading" className="mb-2 text-[13px] font-semibold text-[var(--foreground)]">接下来值得确认的问题</h3>
              {taskId ? (
                <CareerQuestionsPanel
                  taskId={taskId}
                  heading="回答问题以补充职业证据"
                  onAccepted={onAnswered}
                  fallback={fallbackQuestionList(briefing)}
                />
              ) : (
                fallbackQuestionList(briefing)
              )}
            </section>
          )}
        </div>
      )}
    </section>
  );
}

function fallbackQuestionList(briefing: CareerBriefing) {
  return (
    <div className="space-y-2">
      {briefing.questions.map((item, index) => (
        <article key={item.question + "-" + index} className="rounded-md border border-[var(--border)] px-3 py-2.5">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <h4 className="text-[12.5px] font-medium leading-5 text-[var(--foreground)]">{item.question}</h4>
            {item.optional && <span className="shrink-0 rounded-full bg-[var(--surface-muted)] px-2 py-0.5 text-[10.5px] text-[var(--foreground-muted)]">可选</span>}
          </div>
          <p className="mt-1 text-[11.5px] leading-5 text-[var(--foreground-muted)]">想了解：{item.why_needed}</p>
          <p className="mt-0.5 text-[11.5px] leading-5 text-[var(--foreground-muted)]">这会帮助我们：{item.unlocks}</p>
        </article>
      ))}
    </div>
  );
}

export default CareerDiscoveryCard;
