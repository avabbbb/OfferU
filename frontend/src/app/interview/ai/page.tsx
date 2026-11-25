"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowLeft,
  ArrowRight,
  BrainCircuit,
  CheckCircle2,
  Info,
  Lightbulb,
  LogOut,
  Plus,
  ShieldCheck,
  Sparkles,
  Target,
} from "lucide-react";
import {
  createAIInterview,
  getAIInterviewRuntime,
  prepareRoleInterviewFocus,
  submitAIInterviewAnswer,
  type AIInterviewEvaluation,
  type AIInterviewReport,
  type AIInterviewRuntime,
  type AIInterviewSession,
  type InterviewFocusPlan,
} from "@/lib/hooks";
import { Pill, SegmentedProgress, StatusIsland } from "@/components/ui";
import { dataModeLabel } from "@/lib/api";
import { listReviews } from "@/lib/interviewReviews";
import { safeClientErrorMessage } from "@/lib/safe-error";
import InterviewStage from "./components/InterviewStage";
import { Disclosure, OptionCards, Reveal, SPRING, Segmented, StepSwitch } from "../kit";

type InterviewType = "behavioral" | "technical" | "case" | "mixed";
type Difficulty = "easy" | "medium" | "hard";

const TYPE_OPTIONS: { value: InterviewType; label: string; detail: string }[] = [
  { value: "mixed", label: "综合面试", detail: "行为、项目与岗位能力混合" },
  { value: "behavioral", label: "行为面试", detail: "重点练习 STAR 表达" },
  { value: "technical", label: "技术面试", detail: "围绕专业知识与项目深挖" },
  { value: "case", label: "案例面试", detail: "练习拆解与解决问题" },
];

const DIFFICULTY_OPTIONS: { value: Difficulty; label: string }[] = [
  { value: "easy", label: "热身" },
  { value: "medium", label: "标准" },
  { value: "hard", label: "压力面" },
];

const QUESTION_TYPE_LABEL: Record<string, string> = {
  behavioral: "行为题",
  technical: "技术题",
  case: "案例题",
  mixed: "综合题",
};

const QUESTION_MODE_LABEL: Record<string, string> = {
  proof: "Proof · 证明做过",
  depth: "Depth · 机制细节",
  trade_off: "Trade-off · 设计权衡",
  scenario: "Scenario · 场景迁移",
  contradiction: "Contradiction · 表述澄清",
  follow_up: "Adaptive follow-up · 继续追问",
};

const DIMENSION_LABEL: Record<string, string> = {
  relevance: "相关性",
  evidence_specificity: "证据具体度",
  reasoning_structure: "推理结构",
  reflection_tradeoffs: "复盘与权衡",
};

export default function AIInterviewPage() {
  const searchParams = useSearchParams();
  const roleJobId = Number(searchParams.get("job_id") || 0);
  const roleBenchmarkRunId = searchParams.get("benchmark_run_id") || "";
  const roleIntelligenceRoute = Number.isInteger(roleJobId) && roleJobId > 0 && !!roleBenchmarkRunId;
  // 从复盘过来：练真实被问到的那几道题，不让模型另出题。
  const reviewId = Number(searchParams.get("review") || 0);
  const reviewPicks = searchParams.get("q") || "";
  const weakPicks = searchParams.get("from") || "";
  const weakTopic = searchParams.get("topic") || "";
  const [fixedQuestions, setFixedQuestions] = useState<string[]>([]);
  const [company, setCompany] = useState("");
  const [position, setPosition] = useState("");
  const [interviewType, setInterviewType] = useState<InterviewType>("mixed");
  const [difficulty, setDifficulty] = useState<Difficulty>("medium");
  const [questionCount, setQuestionCount] = useState(5);
  const [session, setSession] = useState<AIInterviewSession | null>(null);
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
  const [answer, setAnswer] = useState("");
  const [evaluation, setEvaluation] = useState<AIInterviewEvaluation | null>(null);
  const [report, setReport] = useState<AIInterviewReport | null>(null);
  const [step, setStep] = useState(0);
  const [direction, setDirection] = useState<1 | -1>(1);
  const [showCompany, setShowCompany] = useState(false);
  const [creating, setCreating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [runtime, setRuntime] = useState<AIInterviewRuntime | null>(null);
  const [dataConsent, setDataConsent] = useState(false);
  const [behaviorSummary, setBehaviorSummary] = useState<Record<string, unknown>>({});
  const [focusPlan, setFocusPlan] = useState<InterviewFocusPlan | null>(null);
  const [focusLoading, setFocusLoading] = useState(false);
  const [followUpNotice, setFollowUpNotice] = useState("");

  useEffect(() => {
    let active = true;
    getAIInterviewRuntime()
      .then((value) => {
        if (active) setRuntime(value);
      })
      .catch((cause) => {
        if (active) setError(safeClientErrorMessage(cause, "读取模型配置失败"));
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!roleIntelligenceRoute) {
      setFocusPlan(null);
      setFocusLoading(false);
      return;
    }
    let active = true;
    setFocusLoading(true);
    setError("");
    prepareRoleInterviewFocus(roleJobId, roleBenchmarkRunId)
      .then((plan) => {
        if (!active) return;
        setFocusPlan(plan);
        setCompany(plan.target_job.company || "");
        setPosition(plan.target_job.title || "");
        setInterviewType("mixed");
        setQuestionCount(plan.question_count);
      })
      .catch((cause) => {
        if (active) setError(safeClientErrorMessage(cause, "读取专项面试计划失败"));
      })
      .finally(() => {
        if (active) setFocusLoading(false);
      });
    return () => {
      active = false;
    };
  }, [roleBenchmarkRunId, roleIntelligenceRoute, roleJobId]);

  // 带入复盘里的题：?review=ID&q=0,2 是一场里挑题；?from=3:0,5:2 是跨场的薄弱点专练。
  useEffect(() => {
    if (!reviewId && !weakPicks) return;
    let active = true;
    listReviews()
      .then((reviews) => {
        if (!active) return;
        const byId = new Map(reviews.map((review) => [review.id, review]));
        const refs = weakPicks
          ? weakPicks.split(",").map((ref) => ref.split(":").map(Number))
          : (reviewPicks ? reviewPicks.split(",").map(Number) : byId.get(reviewId)?.questions.map((_, i) => i) ?? []).map((i) => [reviewId, i]);
        const picked = refs.map(([id, i]) => byId.get(id)?.questions[i]?.question.trim()).filter((q): q is string => Boolean(q)).slice(0, 10);
        setFixedQuestions(picked);
        if (picked.length) setQuestionCount(picked.length);
        const review = byId.get(reviewId);
        setCompany(review?.company ?? "");
        setPosition(review ? review.role || review.round_label || "复盘练习" : `${weakTopic || "薄弱点"}专练`);
      })
      .catch((cause) => {
        if (active) setError(safeClientErrorMessage(cause, "读取复盘失败"));
      });
    return () => {
      active = false;
    };
  }, [reviewId, reviewPicks, weakPicks, weakTopic]);

  const currentQuestion = session?.questions[currentQuestionIndex];
  const selectedType = TYPE_OPTIONS.find((option) => option.value === interviewType);

  const reset = () => {
    setSession(null);
    setCurrentQuestionIndex(0);
    setAnswer("");
    setEvaluation(null);
    setReport(null);
    setError("");
    setDataConsent(false);
    setBehaviorSummary({});
    setFollowUpNotice("");
    if (!roleIntelligenceRoute) setFocusPlan(null);
  };

  const handleCreate = async () => {
    if (!position.trim()) {
      setError("请先填写目标岗位");
      return;
    }
    if (!runtime) {
      setError("尚未读取当前模型配置");
      return;
    }
    if (roleIntelligenceRoute && !focusPlan) {
      setError("专项面试计划尚未准备好");
      return;
    }
    if (!dataConsent) {
      setError("请先确认本场问题与回答的数据发送范围");
      return;
    }

    setCreating(true);
    setError("");
    try {
      const consentedCategories = ["interview_configuration", "interview_transcript"];
      if (roleIntelligenceRoute && roleJobId) {
        consentedCategories.push("job_description", "job_research");
        if (focusPlan?.profile_id) consentedCategories.push("verified_profile_facts");
      }
      const created = await createAIInterview({
        title: `${company.trim() || "通用"} · ${position.trim()}模拟面试`,
        target_company: company.trim(),
        target_position: position.trim(),
        interview_type: interviewType,
        difficulty,
        question_count: fixedQuestions.length || questionCount,
        questions: fixedQuestions.length ? fixedQuestions : undefined,
        target_job_id: roleIntelligenceRoute ? roleJobId : undefined,
        profile_id: roleIntelligenceRoute ? (focusPlan?.profile_id ?? undefined) : undefined,
        role_benchmark_run_id: roleIntelligenceRoute ? roleBenchmarkRunId : undefined,
        model_provider: runtime.runtime.provider,
        data_consent: true,
        consented_data_categories: consentedCategories,
      });
      if (!created.questions.length) throw new Error("AI 没有生成可用问题，请重新创建");
      setSession(created);
      setCurrentQuestionIndex(0);
      setEvaluation(null);
      setReport(null);
      setFollowUpNotice("");
    } catch (cause) {
      setError(safeClientErrorMessage(cause, "创建模拟面试失败"));
    } finally {
      setCreating(false);
    }
  };

  const handleSubmit = async () => {
    if (!session || !answer.trim() || submitting) return;
    setSubmitting(true);
    setError("");
    try {
      const result = await submitAIInterviewAnswer(
        session.id,
        currentQuestionIndex,
        answer.trim(),
        session.model_runtime.provider
      );
      setEvaluation(roleIntelligenceRoute ? null : result.evaluation);
      setAnswer("");
        if (roleIntelligenceRoute) {
        setFollowUpNotice(
          result.adaptive_follow_up?.required
            ? `已记录。本轮回答触发 ${QUESTION_MODE_LABEL.follow_up}。`
            : "已记录。Interviewer Mode 继续下一题。"
        );
      }

      if (result.completed && result.report) {
        setReport(result.report);
      } else {
        const nextIndex = result.progress?.current ?? currentQuestionIndex + 1;
        if (result.next_question) {
          setSession((current) => {
            if (!current) return current;
            const questions = [...current.questions];
            const expectedTotal = result.progress?.total ?? questions.length;
            if (expectedTotal > questions.length) {
              questions.splice(nextIndex, 0, result.next_question!);
            } else {
              questions[nextIndex] = result.next_question!;
            }
            return {
              ...current,
              questions,
              current_question_index: nextIndex,
              total_questions: expectedTotal,
            };
          });
        }
        // `next_question` may have been inserted by the server, so the old
        // client-side length is not a safe upper bound here.
        setCurrentQuestionIndex(nextIndex);
      }
    } catch (cause) {
      setError(safeClientErrorMessage(cause, "提交回答失败"));
    } finally {
      setSubmitting(false);
    }
  };

  const goTo = (next: number) => {
    setDirection(next >= step ? 1 : -1);
    setStep(next);
    setError("");
  };

  if (report && session) {
    return <InterviewReport report={report} session={session} behaviorSummary={behaviorSummary} onRestart={reset} />;
  }

  if (session && currentQuestion) {
    const total = session.questions.length;
    const isLast = currentQuestionIndex === total - 1;
    return (
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={SPRING} className="iv-page-wide">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="iv-eyebrow truncate">{[session.target_company || "通用场景", session.target_position].join(" · ")}</p>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <h1 className="iv-h2">第 {currentQuestionIndex + 1} 题<span className="font-medium text-[var(--ou-text-tertiary)]"> / {total}</span></h1>
              {roleIntelligenceRoute && <Pill tone="gray">面试官模式</Pill>}
            </div>
          </div>
          <button type="button" onClick={reset} className="iv-quiet"><LogOut size={15} aria-hidden="true" /> 退出本场</button>
        </header>
        <div className="mt-3">
          <SegmentedProgress label="面试进度" total={total} done={currentQuestionIndex} />
        </div>

        <div className="iv-room mt-6">
          <InterviewStage interviewId={session.id} questionIndex={currentQuestionIndex} onBehaviorSummary={setBehaviorSummary} />

          <div className="iv-room-side space-y-4">
            <section className="iv-card" aria-labelledby="iv-current-question">
              <div className="flex flex-wrap items-center gap-2">
                <Pill tone="gray">{QUESTION_TYPE_LABEL[currentQuestion.type] || "面试题"}</Pill>
                {roleIntelligenceRoute && currentQuestion.mode && <Pill tone="gray">{QUESTION_MODE_LABEL[currentQuestion.mode] || currentQuestion.mode}</Pill>}
                {currentQuestion.focus && <span className="iv-meta">考察 · {currentQuestion.focus}</span>}
              </div>
              <AnimatePresence mode="wait" initial={false}>
                <motion.h2
                  key={currentQuestionIndex}
                  id="iv-current-question"
                  className="iv-question mt-4"
                  initial={{ opacity: 0, x: 24 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -24 }}
                  transition={SPRING}
                >
                  {currentQuestion.question}
                </motion.h2>
              </AnimatePresence>

              {currentQuestion.tips && !roleIntelligenceRoute && (
                <div className="mt-4">
                  <Disclosure key={currentQuestionIndex} title="卡住了？看回答提示" icon={<Lightbulb size={15} aria-hidden="true" />}>
                    {currentQuestion.tips}
                  </Disclosure>
                </div>
              )}

              <textarea
                aria-label="输入本题回答"
                placeholder="像真实面试一样作答：先说结论，再用具体经历和结果支撑。"
                rows={6}
                value={answer}
                onChange={(event) => setAnswer(event.target.value)}
                className="iv-textarea mt-5"
                onKeyDown={(event) => {
                  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") handleSubmit();
                }}
              />
              {error && <p role="alert" className="iv-alert mt-4">{error}</p>}
            </section>

            {roleIntelligenceRoute ? <InterviewerStatus notice={followUpNotice} /> : evaluation && <EvaluationPanel key={currentQuestionIndex} evaluation={evaluation} />}
          </div>
        </div>

        <div className="iv-dock" data-full="">
          <p className="iv-dock-info">
            <b>{currentQuestionIndex + 1} / {total}</b>
            <span className="iv-kbd"> · {roleIntelligenceRoute ? "模糊或缺证据会被追问" : "Ctrl / ⌘ + Enter 提交"}</span>
          </p>
          <button type="button" onClick={handleSubmit} disabled={!answer.trim() || submitting} className="iv-primary">
            {submitting ? <><span className="ou-island-dot" aria-hidden="true" /> AI 正在评估</> : <>{isLast ? "提交并生成报告" : "提交，下一题"} <ArrowRight size={16} aria-hidden="true" /></>}
          </button>
        </div>
      </motion.div>
    );
  }

  const roleLabel = [position.trim(), company.trim()].filter(Boolean).join(" · ");
  const count = fixedQuestions.length || questionCount;
  const difficultyLabel = DIFFICULTY_OPTIONS.find((option) => option.value === difficulty)?.label;
  const canStart = !creating && !focusLoading && !!position.trim() && !!runtime && dataConsent && (!roleIntelligenceRoute || !!focusPlan);
  const summary: { step: number; label: string; empty?: boolean }[] = [
    { step: 0, label: roleLabel || "目标岗位", empty: !roleLabel },
    { step: 1, label: selectedType?.label ?? "" },
    { step: 2, label: `${difficultyLabel} · ${count} 题` },
  ];

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={SPRING} className="iv-page">
      <header>
        <h1 className="iv-title">{roleIntelligenceRoute ? "专项面试训练" : "模拟面试"}</h1>
        <p className="iv-lede">
          {roleIntelligenceRoute ? "按这个岗位和你证据最弱的地方出题，结束后再复盘。" : "三步设好，AI 出题、逐题反馈，镜头只在本机分析。"}
        </p>
      </header>

      <div className="mt-6 iv-progress">
        <span className="iv-meta shrink-0 tabular-nums">{step + 1} / 3</span>
        <SegmentedProgress label="设置进度" total={3} done={step} />
      </div>
      <nav className="iv-chips mt-4" aria-label="已选">
        {summary.map((item) => (
          <button key={item.step} type="button" className="iv-chip" data-empty={item.empty ? "" : undefined} aria-current={item.step === step ? "step" : undefined} onClick={() => goTo(item.step)}>
            <span>{item.label}</span>
          </button>
        ))}
      </nav>

      <div className="mt-6">
        <StepSwitch step={step} direction={direction}>
          <section className="iv-card">
            {step === 0 && (
              <div className="space-y-5">
                <h2 className="iv-h2">{roleIntelligenceRoute ? "确认目标岗位" : "你要面哪个岗位？"}</h2>
                <input
                  aria-label="目标岗位"
                  className="iv-input-lg"
                  placeholder="例如：前端开发工程师"
                  value={position}
                  onChange={(event) => setPosition(event.target.value)}
                  readOnly={roleIntelligenceRoute}
                  required
                  autoFocus={!roleIntelligenceRoute}
                  onKeyDown={(event) => { if (event.key === "Enter" && position.trim()) goTo(1); }}
                />
                {showCompany || company || roleIntelligenceRoute ? (
                  <input aria-label="目标公司（可选）" className="iv-input-lg" placeholder="目标公司（可选），例如：字节跳动" value={company} onChange={(event) => setCompany(event.target.value)} readOnly={roleIntelligenceRoute} autoFocus={showCompany && !company} />
                ) : (
                  <button type="button" className="iv-quiet -ml-3" onClick={() => setShowCompany(true)}><Plus size={15} aria-hidden="true" /> 添加目标公司</button>
                )}
                {roleIntelligenceRoute && (focusPlan ? <FocusPlanPreview plan={focusPlan} /> : focusLoading && <div className="ou-skeleton h-24" aria-label="正在准备专项训练计划" />)}
                {fixedQuestions.length > 0 && (
                  <Disclosure tone="paper" title={`练复盘里的 ${fixedQuestions.length} 道题`} testId="review-practice-questions">
                    <ol className="list-decimal space-y-1 pl-5">{fixedQuestions.map((q, i) => <li key={i}>{q}</li>)}</ol>
                  </Disclosure>
                )}
              </div>
            )}

            {step === 1 && (
              <div className="space-y-5">
                <h2 className="iv-h2">选择面试类型</h2>
                <OptionCards label="面试类型" value={interviewType} options={TYPE_OPTIONS} onChange={setInterviewType} />
              </div>
            )}

            {step === 2 && (
              <div className="space-y-5">
                <h2 className="iv-h2">{roleIntelligenceRoute ? "确认专项训练" : "准备好了"}</h2>
                <dl className="iv-facts">
                  <div className="iv-fact"><dt>方向</dt><dd>{selectedType?.label}</dd></div>
                  <div className="iv-fact"><dt>题数</dt><dd>{count} 题 · {difficultyLabel}</dd></div>
                  <div className="iv-fact"><dt>预计</dt><dd>{count * 3}–{count * 5} 分钟</dd></div>
                </dl>
                <Disclosure title="调整难度与题数" summary={`${difficultyLabel} · ${count} 题`}>
                  <div className="space-y-4 pt-1">
                    <div>
                      <p className="iv-label mb-2">难度</p>
                      <Segmented label="难度" value={difficulty} options={DIFFICULTY_OPTIONS} onChange={setDifficulty} />
                    </div>
                    {!fixedQuestions.length && (
                      <div>
                        <p className="iv-label mb-2">题目数量</p>
                        <Segmented label="题目数量" value={questionCount} options={[3, 5, 8].filter((n) => !roleIntelligenceRoute || n >= 5).map((n) => ({ value: n, label: `${n} 题` }))} onChange={setQuestionCount} />
                      </div>
                    )}
                  </div>
                </Disclosure>

                <label className="iv-consent cursor-pointer">
                  <input type="checkbox" className="mt-0.5 h-5 w-5 shrink-0 cursor-pointer accent-[var(--ou-action-primary)]" checked={dataConsent} onChange={(event) => setDataConsent(event.target.checked)} disabled={!runtime || (roleIntelligenceRoute && focusLoading)} />
                  <span className="min-w-0">
                    <span className="block text-[length:var(--ou-type-sm)] font-medium text-[var(--ou-text-primary)]">回答发给模型评估，镜头只同步派生事件</span>
                    <span className="iv-meta mt-0.5 block">
                      {runtime ? `${runtime.runtime.provider} / ${runtime.runtime.model}${runtime.runtime.is_local ? "（本地）" : "（云端）"}` : "正在读取模型配置…"}
                    </span>
                  </span>
                </label>

                <Disclosure title="隐私与评分说明" icon={<Info size={15} aria-hidden="true" />}>
                  <ul className="space-y-2">
                    <li className="flex gap-2"><ShieldCheck size={14} className="mt-0.5 shrink-0" aria-hidden="true" />视频帧不会发送到后端，摄像头只在本机识别姿态、表情和手势。</li>
                    {roleIntelligenceRoute ? (
                      <>
                        <li className="flex gap-2"><Target size={14} className="mt-0.5 shrink-0" aria-hidden="true" />问题来自岗位 Delta，并按 Career Evidence Gap 排序。</li>
                        <li className="flex gap-2"><BrainCircuit size={14} className="mt-0.5 shrink-0" aria-hidden="true" />训练中只追问事实、指标、机制和权衡，不给答案或提前评分；新观察不会自动写入正式 Profile。</li>
                      </>
                    ) : (
                      <>
                        <li className="flex gap-2"><BrainCircuit size={14} className="mt-0.5 shrink-0" aria-hidden="true" />回答文本发给你配置的 AI 服务，用于出题与逐题评估（结构、相关性、具体度）。</li>
                        <li className="flex gap-2"><Sparkles size={14} className="mt-0.5 shrink-0" aria-hidden="true" />镜头事件单独统计，不与内容分合并。</li>
                      </>
                    )}
                  </ul>
                </Disclosure>
              </div>
            )}

            {error && <p role="alert" className="iv-alert mt-5">{error}</p>}

            <div className="mt-8 flex flex-wrap-reverse items-center justify-between gap-3">
              {step > 0 ? <button type="button" className="iv-quiet -ml-3" onClick={() => goTo(step - 1)}><ArrowLeft size={15} aria-hidden="true" /> 上一步</button> : <span />}
              {step < 2 ? (
                <button type="button" className="iv-primary" disabled={!position.trim() || (roleIntelligenceRoute && !focusPlan)} onClick={() => goTo(step + 1)}>
                  下一步 <ArrowRight size={16} aria-hidden="true" />
                </button>
              ) : (
                <button type="button" className="iv-primary" disabled={!canStart} onClick={handleCreate}>
                  {creating ? <><span className="ou-island-dot" aria-hidden="true" /> 正在准备本场问题</> : <>{roleIntelligenceRoute ? "生成专项问题并开始" : "生成面试并进入房间"} <ArrowRight size={16} aria-hidden="true" /></>}
                </button>
              )}
            </div>
          </section>
        </StepSwitch>
      </div>
    </motion.div>
  );
}

function FocusPlanPreview({ plan }: { plan: InterviewFocusPlan }) {
  return (
    <div className="space-y-3" data-testid="interview-focus-plan">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="iv-label">专项训练重点</p>
        <span className="iv-meta">{dataModeLabel(plan.source.data_mode)} · {plan.source.valid_sample_count} 个样本 · {plan.source.company_count} 家公司</span>
      </div>
      <ul className="space-y-3">
        {plan.focuses.map((focus) => (
          <li key={focus.capability}>
            <div className="mb-1.5 flex items-center justify-between gap-3 text-[length:var(--ou-type-body)]">
              <span className="min-w-0 truncate font-semibold text-[var(--ou-text-primary)]">{focus.capability}</span>
              <span className="shrink-0 tabular-nums text-[var(--ou-text-secondary)]">{focus.priority_percent}%</span>
            </div>
            <div className="iv-bar"><i style={{ width: `${focus.priority_percent}%` }} /></div>
          </li>
        ))}
      </ul>
      <Disclosure title="这些重点怎么来的">
        <p>优先级 = 岗位特殊度 × Career Evidence Gap × signal confidence，由 Runtime 确定；模型只负责把蓝图转成问题文字。</p>
        <ul className="mt-2 space-y-1">
          {plan.focuses.map((focus) => (
            <li key={focus.capability}>{focus.capability}：特殊度 {focus.role_distinctiveness} · 证据强度 {focus.evidence_strength} · 缺口 {focus.evidence_gap}</li>
          ))}
        </ul>
      </Disclosure>
    </div>
  );
}

function InterviewerStatus({ notice }: { notice: string }) {
  return (
    <div className="space-y-3" data-testid="interviewer-mode-status">
      {notice && <Reveal key={notice}><StatusIsland state="done">{notice}</StatusIsland></Reveal>}
      <Disclosure title="面试官模式：只继续追问" icon={<CheckCircle2 size={15} aria-hidden="true" />}>
        本场不会即时夸奖、给答案或提前评分。模糊、缺事实 / 机制 / 指标的回答会触发下一条追问；与 Career Evidence 的表述差异会被中性澄清。
      </Disclosure>
    </div>
  );
}

function EvaluationPanel({ evaluation }: { evaluation: AIInterviewEvaluation }) {
  const next = evaluation.improvements[0] || evaluation.suggestion;
  return (
    <Reveal>
      <section className="iv-card" aria-label="上一题内容反馈">
        <div className="flex items-center gap-4">
          <span className="iv-score-sm">{evaluation.content_score}</span>
          <div className="min-w-0">
            <p className="iv-h3">上一题反馈</p>
            {next && <p className="iv-muted mt-0.5">{next}</p>}
          </div>
        </div>
        <div className="mt-4">
          <Disclosure title="查看详情" summary={`${Object.keys(evaluation.dimensions).length} 个维度`}>
            <div className="iv-dims pt-1">
              {Object.entries(evaluation.dimensions).map(([key, value]) => (
                <div key={key}>
                  <div className="mb-1.5 flex justify-between gap-2 text-[length:var(--ou-type-sm)]"><span>{DIMENSION_LABEL[key] || key}</span><span className="font-semibold tabular-nums text-[var(--ou-text-primary)]">{value.not_applicable ? "不适用" : value.score}</span></div>
                  <div className="iv-bar"><i style={{ width: value.not_applicable ? "0%" : `${value.score}%` }} /></div>
                  {value.evidence[0] && <p className="iv-quote mt-1.5 line-clamp-2">“{value.evidence[0]}”</p>}
                </div>
              ))}
            </div>
            {!!evaluation.strengths.length && <FeedbackList title="做得好" items={evaluation.strengths} tone="good" />}
            {evaluation.improvements.length > 1 && <FeedbackList title="下一题注意" items={evaluation.improvements} tone="improve" />}
            {evaluation.suggestion && <p className="mt-4 text-[var(--ou-text-primary)]">{evaluation.suggestion}</p>}
            <p className="iv-quote mt-3">{evaluation.skill_id}@{evaluation.skill_version} · {evaluation.score_band}</p>
          </Disclosure>
        </div>
      </section>
    </Reveal>
  );
}

function FeedbackList({ title, items, tone }: { title: string; items: string[]; tone: "good" | "improve" }) {
  return (
    <div className="mt-4">
      <p className="iv-label">{title}</p>
      <ul className="iv-list mt-2">
        {items.map((item) => <li key={item}>{tone === "good" ? <CheckCircle2 size={14} className="text-[var(--ou-tone-green-dot)]" aria-hidden="true" /> : <Target size={14} className="text-[var(--ou-tone-yellow-dot)]" aria-hidden="true" />}{item}</li>)}
      </ul>
    </div>
  );
}

function InterviewReport({ report, session, behaviorSummary, onRestart }: { report: AIInterviewReport; session: AIInterviewSession; behaviorSummary: Record<string, unknown>; onRestart: () => void }) {
  const dimensions = useMemo(() => Object.entries(report.dimension_scores), [report.dimension_scores]);
  const delivery = Object.keys(behaviorSummary).length ? behaviorSummary : report.delivery_feedback;
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={SPRING} className="iv-page-wide space-y-6">
      <section className="iv-card">
        <div className="grid gap-6 md:grid-cols-[auto_minmax(0,1fr)] md:items-center md:gap-10">
          <div>
            <p className="iv-eyebrow">内容分</p>
            <p className="iv-score mt-1">{report.content_score}</p>
            <p className="iv-meta mt-2">{session.target_position} · {session.questions.length} 题</p>
          </div>
          <div className="min-w-0">
            <Pill tone="green">面试完成</Pill>
            <h1 className="iv-title mt-3">本场模拟面试报告</h1>
            <p className="iv-lede">{report.summary}</p>
            <button type="button" onClick={onRestart} className="iv-primary mt-6">再练一场 <ArrowRight size={16} aria-hidden="true" /></button>
          </div>
        </div>
      </section>

      {report.role_intelligence_debrief && <Reveal delay={0.05}><RoleInterviewDebrief debrief={report.role_intelligence_debrief} /></Reveal>}

      <Reveal delay={0.08}>
        <section className="iv-card">
          <div className="iv-cols">
            <ReportList title="表现亮点" items={report.highlights} icon={<Sparkles size={16} aria-hidden="true" />} />
            <ReportList title="优先改进" items={report.areas_for_improvement} icon={<Target size={16} aria-hidden="true" />} />
            <ReportList title="下一步练习" items={report.recommendations} icon={<BrainCircuit size={16} aria-hidden="true" />} />
          </div>
        </section>
      </Reveal>

      <Reveal delay={0.12} className="space-y-3">
        {!!dimensions.length && (
          <Disclosure title="能力维度" summary={dimensions.map(([key, value]) => `${DIMENSION_LABEL[key] || key} ${value}`).slice(0, 2).join(" · ")}>
            <div className="iv-dims pt-1">
              {dimensions.map(([key, value]) => (
                <div key={key}>
                  <div className="mb-1.5 flex justify-between text-[length:var(--ou-type-sm)]"><span>{DIMENSION_LABEL[key] || key}</span><span className="font-semibold tabular-nums text-[var(--ou-text-primary)]">{value}</span></div>
                  <div className="iv-bar" role="progressbar" aria-label={DIMENSION_LABEL[key] || key} aria-valuenow={value} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${value}%` }} /></div>
                </div>
              ))}
            </div>
          </Disclosure>
        )}
        <DeliveryFeedback summary={delivery} questions={session.questions.map((q) => q.question)} />
        <p className="iv-quote px-1">{report.boundary}</p>
      </Reveal>
    </motion.div>
  );
}

function RoleInterviewDebrief({ debrief }: { debrief: NonNullable<AIInterviewReport["role_intelligence_debrief"]> }) {
  return (
    <section className="iv-card" data-testid="role-interview-debrief">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Pill tone="gray">教练复盘</Pill>
          <h2 className="iv-h2 mt-3">为什么问这些题</h2>
          <p className="iv-muted mt-1 max-w-2xl">实际回答与岗位 Delta、Career Evidence Gap 放在一起看；这是本场学习观察，不会自动改写正式 Profile。</p>
        </div>
        <p className="iv-meta text-right">{dataModeLabel(debrief.source.data_mode)} · 样本 {String(debrief.source.valid_sample_count ?? "—")}</p>
      </div>
      <div className="mt-5 space-y-2">
        {debrief.focuses.map((focus) => (
          <Disclosure key={focus.capability} tone="paper" title={focus.capability} summary={`训练权重 ${focus.priority_percent}%`}>
            <p>{focus.why_this_focus}</p>
            <p className="iv-quote mt-2">岗位特殊度 {focus.role_distinctiveness} · 证据缺口 {focus.evidence_gap} · 市场频率 {Math.round(focus.market_frequency * 100)}% · 表现 {focus.performance.average_content_score ?? "—"} · {focus.performance.status === "supported" ? "当前回答有可用证据" : "需要更多事实 / 机制"}</p>
            {focus.responses.map((response) => (
              <div key={`${focus.capability}-${response.question_index}`} className="ou-capsule-card mt-3 rounded-[var(--ou-radius-1)] px-3 py-2">
                <p className="iv-meta">第 {response.question_index + 1} 题 · {QUESTION_MODE_LABEL[response.mode] || response.mode}</p>
                <p className="mt-1 font-semibold text-[var(--ou-text-primary)]">{response.question}</p>
                <p className="mt-2">评价引用（实际回答）：“{response.transcript_excerpt || response.answer_excerpt}”</p>
                {response.answer_evidence.length > 0 && <p className="iv-quote mt-1">回答中的可核对证据：{response.answer_evidence.join("；")}</p>}
                {response.why_asked && <p className="iv-quote mt-1">提问依据：{response.why_asked}</p>}
              </div>
            ))}
            {focus.observed_answer_gaps.length > 0 && <p className="mt-3 font-medium text-[var(--ou-tone-red-text)]">回答缺口：{focus.observed_answer_gaps.join("；")}</p>}
            {focus.candidate_evidence_not_utilized.length > 0 && <p className="mt-2">已有 Evidence 尚未在回答中被有效利用：{focus.candidate_evidence_not_utilized.map((item) => item.title || item.profile_section_id).join("、")}</p>}
            <p className="mt-3 font-semibold text-[var(--ou-text-primary)]">下一轮：{focus.next_practice}</p>
          </Disclosure>
        ))}
      </div>
      <p className="iv-quote mt-4">{debrief.boundary}</p>
    </section>
  );
}

function DeliveryFeedback({ summary, questions }: { summary: Record<string, unknown>; questions?: string[] }) {
  const counts = summary.event_counts && typeof summary.event_counts === "object"
    ? summary.event_counts as Record<string, number>
    : {};
  const labels = summary.event_labels && typeof summary.event_labels === "object"
    ? summary.event_labels as Record<string, string>
    : {};
  const perQuestion = summary.per_question && typeof summary.per_question === "object"
    ? summary.per_question as Record<string, { event_counts?: Record<string, number> }>
    : {};
  const items = Object.entries(counts);
  const questionEntries = Object.entries(perQuestion).sort(
    (a, b) => Number(a[0]) - Number(b[0])
  );
  const total = items.reduce((sum, [, count]) => sum + count, 0);
  return (
    <Disclosure title="镜头前的表达事件" summary={items.length ? `${total} 次 · 不评分` : "不评分"}>
      {items.length ? (
        <div className="grid grid-cols-2 gap-2 pt-1 sm:grid-cols-3">
          {items.map(([key, count]) => <div key={key} className="ou-capsule-card rounded-[var(--ou-radius-1)] p-3"><p className="iv-meta">{labels[key] || key}</p><p className="mt-1 text-[length:var(--ou-type-section)] font-semibold text-[var(--ou-text-primary)]">{count} 次</p></div>)}
        </div>
      ) : <p>本场没有已同步的派生事件。</p>}
      {questionEntries.length > 0 && (
        <div className="mt-4 space-y-2">
          <p className="iv-label">按题分解</p>
          {questionEntries.map(([index, bucket]) => {
            const questionCounts = Object.entries(bucket.event_counts ?? {});
            if (!questionCounts.length) return null;
            return (
              <div key={index}>
                <p className="truncate text-[var(--ou-text-primary)]">第 {Number(index) + 1} 题{questions?.[Number(index)] ? ` · ${questions[Number(index)]}` : ""}</p>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {questionCounts.map(([key, count]) => <Pill key={key} tone="gray">{labels[key] || key} × {count}</Pill>)}
                </div>
              </div>
            );
          })}
        </div>
      )}
      <p className="iv-quote mt-4">只统计事件类型、次数、区间、置信度和检测器版本；不保存视频帧，也不推断性格、情绪或录用概率。</p>
    </Disclosure>
  );
}

function ReportList({ title, items, icon }: { title: string; items: string[]; icon: ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="flex items-center gap-2 iv-h3">{icon}{title}</p>
      {items.length ? <ul className="mt-3 space-y-2">{items.map((item) => <li key={item} className="iv-muted">{item}</li>)}</ul> : <p className="iv-meta mt-3">本场暂无记录</p>}
    </div>
  );
}
