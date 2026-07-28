"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { motion } from "framer-motion";
import { Button, Checkbox, Chip, Input, Progress, Spinner, Textarea } from "@nextui-org/react";
import {
  ArrowRight,
  Bot,
  BrainCircuit,
  Building2,
  CheckCircle2,
  ChevronDown,
  Lightbulb,
  MessageSquareText,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Target,
  Video,
} from "lucide-react";
import {
  createAIInterview,
  getAIInterviewRuntime,
  submitAIInterviewAnswer,
  type AIInterviewEvaluation,
  type AIInterviewReport,
  type AIInterviewRuntime,
  type AIInterviewSession,
} from "@/lib/hooks";
import { bauhausFieldClassNames } from "@/lib/bauhaus";
import InterviewStage from "./components/InterviewStage";

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

const DIMENSION_LABEL: Record<string, string> = {
  relevance: "相关性",
  evidence_specificity: "证据具体度",
  reasoning_structure: "推理结构",
  reflection_tradeoffs: "复盘与权衡",
};

export default function AIInterviewPage() {
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
  const [showTips, setShowTips] = useState(false);
  const [creating, setCreating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [runtime, setRuntime] = useState<AIInterviewRuntime | null>(null);
  const [dataConsent, setDataConsent] = useState(false);
  const [behaviorSummary, setBehaviorSummary] = useState<Record<string, unknown>>({});

  useEffect(() => {
    let active = true;
    getAIInterviewRuntime()
      .then((value) => {
        if (active) setRuntime(value);
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : "读取模型配置失败");
      });
    return () => {
      active = false;
    };
  }, []);

  const currentQuestion = session?.questions[currentQuestionIndex];
  const progress = session ? ((currentQuestionIndex + (report ? 1 : 0)) / session.questions.length) * 100 : 0;
  const selectedType = TYPE_OPTIONS.find((option) => option.value === interviewType);

  const reset = () => {
    setSession(null);
    setCurrentQuestionIndex(0);
    setAnswer("");
    setEvaluation(null);
    setReport(null);
    setShowTips(false);
    setError("");
    setDataConsent(false);
    setBehaviorSummary({});
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
    if (!dataConsent) {
      setError("请先确认本场问题与回答的数据发送范围");
      return;
    }

    setCreating(true);
    setError("");
    try {
      const created = await createAIInterview({
        title: `${company.trim() || "通用"} · ${position.trim()}模拟面试`,
        target_company: company.trim(),
        target_position: position.trim(),
        interview_type: interviewType,
        difficulty,
        question_count: questionCount,
        model_provider: runtime.runtime.provider,
        data_consent: true,
        consented_data_categories: ["interview_configuration", "interview_transcript"],
        user_confirmed: true,
      });
      if (!created.questions.length) throw new Error("AI 没有生成可用问题，请重新创建");
      setSession(created);
      setCurrentQuestionIndex(0);
      setEvaluation(null);
      setReport(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "创建模拟面试失败");
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
      setEvaluation(result.evaluation);
      setAnswer("");
      setShowTips(false);

      if (result.completed && result.report) {
        setReport(result.report);
      } else {
        const nextIndex = result.progress?.current ?? currentQuestionIndex + 1;
        setCurrentQuestionIndex(Math.min(nextIndex, session.questions.length - 1));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "提交回答失败");
    } finally {
      setSubmitting(false);
    }
  };

  if (report && session) {
    return <InterviewReport report={report} session={session} behaviorSummary={behaviorSummary} onRestart={reset} />;
  }

  if (session && currentQuestion) {
    return (
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="mx-auto max-w-7xl space-y-5">
        <header className="flex flex-col gap-4 rounded-2xl border border-[var(--border-strong)] bg-white p-5 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--foreground-muted)]">
              <Chip size="sm" variant="flat" className="bg-[var(--status-sage)] font-semibold text-[var(--primary-green)]">进行中</Chip>
              <span>{session.target_company || "通用场景"}</span>
              <span>·</span>
              <span>{session.target_position}</span>
            </div>
            <h1 className="mt-2 text-2xl font-semibold tracking-[-0.04em] text-[var(--foreground)]">AI 模拟面试</h1>
          </div>
          <div className="w-full md:w-72">
            <div className="mb-2 flex items-center justify-between text-xs text-[var(--foreground-muted)]">
              <span>第 {currentQuestionIndex + 1} / {session.questions.length} 题</span>
              <button onClick={reset} className="flex items-center gap-1 transition hover:text-[var(--foreground)]"><RotateCcw size={12} /> 退出本场</button>
            </div>
            <Progress aria-label="面试进度" value={progress} size="sm" classNames={{ indicator: "bg-[var(--foreground)]", track: "bg-[var(--surface-hover)]" }} />
          </div>
        </header>

        <InterviewStage interviewId={session.id} questionIndex={currentQuestionIndex} onBehaviorSummary={setBehaviorSummary} />

        {error && <div role="alert" className="rounded-xl border border-[#b4451f]/20 bg-[var(--status-blush)] px-4 py-3 text-sm text-[var(--primary-red)]">{error}</div>}

        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
          <section className="rounded-2xl border border-[var(--border-strong)] bg-white p-5 md:p-7">
            <div className="flex flex-wrap items-center gap-2">
              <Chip size="sm" variant="flat" className="bg-[var(--surface-muted)] font-semibold text-[var(--foreground-soft)]">
                {QUESTION_TYPE_LABEL[currentQuestion.type] || "面试题"}
              </Chip>
              {currentQuestion.focus && <span className="text-xs text-[var(--foreground-muted)]">考察：{currentQuestion.focus}</span>}
            </div>
            <h2 className="mt-4 text-2xl font-semibold leading-snug tracking-[-0.035em] text-[var(--foreground)]">{currentQuestion.question}</h2>

            {currentQuestion.tips && (
              <div className="mt-4">
                <button onClick={() => setShowTips((value) => !value)} className="flex items-center gap-1.5 text-xs font-medium text-[var(--foreground-muted)] transition hover:text-[var(--foreground)]">
                  <Lightbulb size={14} /> {showTips ? "收起回答提示" : "卡住了？查看回答提示"} <ChevronDown size={13} className={`transition-transform ${showTips ? "rotate-180" : ""}`} />
                </button>
                {showTips && <p className="mt-2 rounded-xl bg-[var(--surface-muted)] p-3 text-sm leading-relaxed text-[var(--foreground-soft)]">{currentQuestion.tips}</p>}
              </div>
            )}

            <Textarea
              aria-label="输入本题回答"
              placeholder="像真实面试一样作答。建议先说结论，再用具体经历和结果支撑……"
              minRows={7}
              maxRows={14}
              value={answer}
              onValueChange={setAnswer}
              className="mt-6"
              classNames={bauhausFieldClassNames}
              onKeyDown={(event) => {
                if ((event.ctrlKey || event.metaKey) && event.key === "Enter") handleSubmit();
              }}
            />
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
              <span className="text-[11px] text-[var(--foreground-muted)]">Ctrl / ⌘ + Enter 提交 · 回答文本会发送给本地后端配置的模型</span>
              <Button onPress={handleSubmit} isDisabled={!answer.trim() || submitting} className="bg-[var(--foreground)] font-semibold text-white" endContent={submitting ? <Spinner color="current" size="sm" /> : <ArrowRight size={15} />}>
                {submitting ? "AI 正在评估" : currentQuestionIndex === session.questions.length - 1 ? "提交并生成报告" : "提交并进入下一题"}
              </Button>
            </div>
          </section>

          <EvaluationPanel evaluation={evaluation} />
        </div>
      </motion.div>
    );
  }

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="mx-auto max-w-6xl space-y-6">
      <section className="overflow-hidden rounded-2xl border border-[var(--border-strong)] bg-white">
        <div className="grid gap-8 p-6 md:p-8 lg:grid-cols-[1.12fr_0.88fr] lg:p-10">
          <div>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--status-sage)] px-3 py-1 text-[11px] font-semibold text-[var(--primary-green)]"><Sparkles size={13} /> AI INTERVIEW STUDIO</span>
            <h1 className="mt-5 max-w-2xl text-4xl font-semibold leading-[1.04] tracking-[-0.055em] text-[var(--foreground)] md:text-5xl">
              不只练答案，<br />也练镜头前的表达。
            </h1>
            <p className="mt-5 max-w-xl text-sm leading-7 text-[var(--foreground-soft)]">
              AI 根据目标岗位生成连续问题、逐题评估回答；摄像头只在本机识别姿态、笑容与手势，右侧图片实时映射你的表达状态。
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-1">
            {[
              { icon: BrainCircuit, title: "岗位化提问", detail: "由浅入深生成面试题" },
              { icon: Video, title: "本地视觉反馈", detail: "姿态、笑容与手势实时响应" },
              { icon: MessageSquareText, title: "逐题复盘", detail: "结构、相关性与具体度" },
            ].map(({ icon: Icon, title, detail }) => (
              <div key={title} className="flex items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-4">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white text-[var(--foreground)]"><Icon size={17} /></div>
                <div><p className="text-sm font-semibold">{title}</p><p className="mt-0.5 text-xs text-[var(--foreground-muted)]">{detail}</p></div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_330px]">
        <section className="rounded-2xl border border-[var(--border-strong)] bg-white p-6 md:p-8">
          <div className="flex items-center gap-2"><Target size={17} /><h2 className="text-base font-semibold">设置本场面试</h2></div>
          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            <Input label="目标公司（可选）" placeholder="例如：字节跳动" value={company} onValueChange={setCompany} startContent={<Building2 size={15} className="text-[var(--foreground-muted)]" />} classNames={bauhausFieldClassNames} />
            <Input label="目标岗位" placeholder="例如：前端开发工程师" value={position} onValueChange={setPosition} isRequired classNames={bauhausFieldClassNames} />
          </div>

          <div className="mt-6">
            <p className="text-xs font-semibold text-[var(--foreground-soft)]">面试类型</p>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {TYPE_OPTIONS.map((option) => (
                <button key={option.value} onClick={() => setInterviewType(option.value)} className={`rounded-xl border p-3 text-left transition ${interviewType === option.value ? "border-[var(--foreground)] bg-[var(--surface-muted)]" : "border-[var(--border-strong)] bg-white hover:bg-[var(--surface-muted)]"}`}>
                  <p className="text-sm font-semibold">{option.label}</p><p className="mt-1 text-xs text-[var(--foreground-muted)]">{option.detail}</p>
                </button>
              ))}
            </div>
          </div>

          <div className="mt-6 grid gap-5 sm:grid-cols-2">
            <div>
              <p className="text-xs font-semibold text-[var(--foreground-soft)]">难度</p>
              <div className="mt-2 flex gap-2">
                {DIFFICULTY_OPTIONS.map((option) => (
                  <button key={option.value} onClick={() => setDifficulty(option.value)} className={`flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition ${difficulty === option.value ? "border-[var(--foreground)] bg-[var(--foreground)] text-white" : "border-[var(--border-strong)] bg-white text-[var(--foreground-soft)]"}`}>{option.label}</button>
                ))}
              </div>
            </div>
            <div>
              <p className="text-xs font-semibold text-[var(--foreground-soft)]">题目数量</p>
              <div className="mt-2 flex gap-2">
                {[3, 5, 8].map((count) => (
                  <button key={count} onClick={() => setQuestionCount(count)} className={`flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition ${questionCount === count ? "border-[var(--foreground)] bg-[var(--foreground)] text-white" : "border-[var(--border-strong)] bg-white text-[var(--foreground-soft)]"}`}>{count} 题</button>
                ))}
              </div>
            </div>
          </div>

          <div className="mt-6 rounded-xl border border-[var(--border-strong)] bg-[var(--surface-muted)] p-4">
            <Checkbox isSelected={dataConsent} onValueChange={setDataConsent} isDisabled={!runtime}>
              <span className="text-xs font-medium">确认本场数据范围：配置与回答发给模型，摄像头只同步派生事件</span>
            </Checkbox>
            <p className="mt-2 pl-7 text-[11px] leading-5 text-[var(--foreground-muted)]">
              {runtime
                ? `${runtime.runtime.provider} / ${runtime.runtime.model}${runtime.runtime.is_local ? "（本地）" : "（云端）"}`
                : "正在读取模型配置…"}
              。视频帧不会发送到后端；只会同步你已确认的派生行为事件。
            </p>
          </div>

          {error && <p role="alert" className="mt-5 rounded-xl bg-[var(--status-blush)] p-3 text-sm text-[var(--primary-red)]">{error}</p>}

          <Button onPress={handleCreate} isDisabled={creating || !position.trim() || !runtime || !dataConsent} size="lg" className="mt-7 w-full bg-[var(--foreground)] font-semibold text-white" endContent={creating ? <Spinner color="current" size="sm" /> : <ArrowRight size={16} />}>
            {creating ? "正在准备本场问题" : "生成面试并进入房间"}
          </Button>
        </section>

        <aside className="rounded-2xl border border-[var(--border-strong)] bg-[var(--surface-muted)] p-6">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-white"><Bot size={20} /></div>
          <h2 className="mt-5 text-lg font-semibold tracking-[-0.03em]">本场预览</h2>
          <dl className="mt-5 space-y-4 text-sm">
            <div><dt className="text-xs text-[var(--foreground-muted)]">面试方向</dt><dd className="mt-1 font-medium">{selectedType?.label}</dd></div>
            <div><dt className="text-xs text-[var(--foreground-muted)]">目标岗位</dt><dd className="mt-1 font-medium">{position.trim() || "等待填写"}</dd></div>
            <div><dt className="text-xs text-[var(--foreground-muted)]">预计时长</dt><dd className="mt-1 font-medium">约 {questionCount * 3}–{questionCount * 5} 分钟</dd></div>
          </dl>
          <div className="mt-6 border-t border-[var(--border-strong)] pt-5">
            <p className="flex items-center gap-2 text-xs font-semibold"><ShieldCheck size={15} /> 隐私边界</p>
            <p className="mt-2 text-xs leading-6 text-[var(--foreground-muted)]">摄像头视频只参与本地姿态、表情和手势推理。回答文本会发送给你在 OfferU 中配置的 AI 服务，用于生成问题与评估。</p>
          </div>
        </aside>
      </div>
    </motion.div>
  );
}

function EvaluationPanel({ evaluation }: { evaluation: AIInterviewEvaluation | null }) {
  if (!evaluation) {
    return (
      <aside className="flex min-h-72 flex-col items-center justify-center rounded-2xl border border-dashed border-[var(--border-strong)] bg-[var(--surface-muted)] p-6 text-center">
        <MessageSquareText size={26} className="text-[var(--foreground-muted)]" />
        <p className="mt-3 text-sm font-semibold">上一题反馈会出现在这里</p>
        <p className="mt-1 text-xs leading-relaxed text-[var(--foreground-muted)]">先完成回答，AI 会按固定版本评分规则引用你的回答原文，再由后端确定性聚合内容分。</p>
      </aside>
    );
  }

  return (
    <aside className="rounded-2xl border border-[var(--border-strong)] bg-white p-5">
      <div className="flex items-center justify-between"><div><p className="text-sm font-semibold">上一题内容反馈</p><p className="mt-1 text-[10px] text-[var(--foreground-muted)]">{evaluation.skill_id}@{evaluation.skill_version} · {evaluation.score_band}</p></div><span className="text-3xl font-semibold tracking-[-0.05em]">{evaluation.content_score}</span></div>
      <div className="mt-4 grid grid-cols-2 gap-2">
        {Object.entries(evaluation.dimensions).map(([key, value]) => (
          <div key={key} className="rounded-lg bg-[var(--surface-muted)] p-2.5"><p className="text-[10px] text-[var(--foreground-muted)]">{DIMENSION_LABEL[key] || key}</p><p className="mt-1 text-sm font-semibold">{value.not_applicable ? "不适用" : value.score}</p>{value.evidence[0] && <p className="mt-1 line-clamp-2 text-[10px] leading-4 text-[var(--foreground-muted)]">“{value.evidence[0]}”</p>}</div>
        ))}
      </div>
      {!!evaluation.strengths.length && <FeedbackList title="做得好" items={evaluation.strengths} tone="good" />}
      {!!evaluation.improvements.length && <FeedbackList title="下一题注意" items={evaluation.improvements} tone="improve" />}
      {evaluation.suggestion && <p className="mt-4 rounded-xl border border-[var(--border)] bg-[var(--status-sage)] p-3 text-xs leading-relaxed text-[var(--foreground-soft)]">{evaluation.suggestion}</p>}
    </aside>
  );
}

function FeedbackList({ title, items, tone }: { title: string; items: string[]; tone: "good" | "improve" }) {
  return (
    <div className="mt-4"><p className="text-xs font-semibold">{title}</p><ul className="mt-2 space-y-1.5">{items.map((item) => <li key={item} className="flex gap-2 text-xs leading-relaxed text-[var(--foreground-soft)]">{tone === "good" ? <CheckCircle2 size={13} className="mt-0.5 shrink-0 text-[var(--primary-green)]" /> : <Target size={13} className="mt-0.5 shrink-0 text-[var(--primary-yellow)]" />}{item}</li>)}</ul></div>
  );
}

function InterviewReport({ report, session, behaviorSummary, onRestart }: { report: AIInterviewReport; session: AIInterviewSession; behaviorSummary: Record<string, unknown>; onRestart: () => void }) {
  const dimensions = useMemo(() => Object.entries(report.dimension_scores), [report.dimension_scores]);
  const delivery = Object.keys(behaviorSummary).length ? behaviorSummary : report.delivery_feedback;
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="mx-auto max-w-5xl space-y-6">
      <section className="rounded-2xl border border-[var(--border-strong)] bg-white p-7 md:p-10">
        <div className="grid gap-8 md:grid-cols-[220px_1fr] md:items-center">
          <div className="text-center"><p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--foreground-muted)]">CONTENT SCORE</p><p className="mt-2 text-8xl font-semibold tracking-[-0.09em]">{report.content_score}</p><p className="mt-2 text-xs text-[var(--foreground-muted)]">{session.target_position} · {session.questions.length} 题</p></div>
          <div><Chip size="sm" variant="flat" className="bg-[var(--status-sage)] font-semibold text-[var(--primary-green)]">面试完成</Chip><h1 className="mt-4 text-3xl font-semibold tracking-[-0.045em]">本场模拟面试报告</h1><p className="mt-3 text-sm leading-7 text-[var(--foreground-soft)]">{report.summary}</p><Button onPress={onRestart} className="mt-6 bg-[var(--foreground)] font-semibold text-white" startContent={<RotateCcw size={15} />}>再练一场</Button></div>
        </div>
      </section>

      {!!dimensions.length && <section className="rounded-2xl border border-[var(--border-strong)] bg-white p-6"><h2 className="text-sm font-semibold">能力维度</h2><div className="mt-5 grid gap-4 sm:grid-cols-2">{dimensions.map(([key, value]) => <div key={key}><div className="mb-2 flex justify-between text-xs"><span className="text-[var(--foreground-soft)]">{DIMENSION_LABEL[key] || key}</span><span className="font-semibold">{value}</span></div><Progress aria-label={DIMENSION_LABEL[key] || key} value={value} size="sm" classNames={{ indicator: "bg-[var(--foreground)]", track: "bg-[var(--surface-hover)]" }} /></div>)}</div></section>}

      <p className="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-4 text-xs leading-6 text-[var(--foreground-muted)]">{report.boundary}</p>

      <DeliveryFeedback summary={delivery} />

      <div className="grid gap-5 md:grid-cols-3">
        <ReportList title="表现亮点" items={report.highlights} icon={<Sparkles size={16} />} />
        <ReportList title="优先改进" items={report.areas_for_improvement} icon={<Target size={16} />} />
        <ReportList title="下一步练习" items={report.recommendations} icon={<BrainCircuit size={16} />} />
      </div>
    </motion.div>
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
  return (
    <section className="rounded-2xl border border-[var(--border-strong)] bg-white p-6">
      <div className="flex items-center justify-between gap-3"><h2 className="text-sm font-semibold">可观察表达事件</h2><Chip size="sm" variant="flat">不评分</Chip></div>
      {items.length ? <div className="mt-4 grid gap-2 sm:grid-cols-2 md:grid-cols-3">{items.map(([key, count]) => <div key={key} className="rounded-lg bg-[var(--surface-muted)] p-3"><p className="text-xs text-[var(--foreground-muted)]">{labels[key] || key}</p><p className="mt-1 text-lg font-semibold">{count} 次</p></div>)}</div> : <p className="mt-4 text-xs text-[var(--foreground-muted)]">本场没有已同步的派生事件。</p>}
      {questionEntries.length > 0 && (
        <div className="mt-5 space-y-2">
          <h3 className="text-xs font-semibold text-[var(--foreground-soft)]">按题分解</h3>
          {questionEntries.map(([index, bucket]) => {
            const questionCounts = Object.entries(bucket.event_counts ?? {});
            if (!questionCounts.length) return null;
            return (
              <div key={index} className="rounded-lg border border-[var(--border)] p-3">
                <p className="text-xs font-medium text-[var(--foreground-soft)]">
                  第 {Number(index) + 1} 题
                  {questions?.[Number(index)] ? ` · ${questions[Number(index)].slice(0, 40)}` : ""}
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {questionCounts.map(([key, count]) => (
                    <span key={key} className="rounded bg-[var(--surface-muted)] px-2 py-1 text-[11px] text-[var(--foreground-muted)]">
                      {labels[key] || key} × {count}
                    </span>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
      <p className="mt-4 text-[11px] leading-5 text-[var(--foreground-muted)]">这里只统计事件类型、次数、区间、置信度和检测器版本；不保存视频帧，也不推断性格、情绪或录用概率。</p>
    </section>
  );
}

function ReportList({ title, items, icon }: { title: string; items: string[]; icon: ReactNode }) {
  return <section className="rounded-2xl border border-[var(--border-strong)] bg-white p-5"><div className="flex items-center gap-2 text-sm font-semibold">{icon}{title}</div>{items.length ? <ul className="mt-4 space-y-3">{items.map((item) => <li key={item} className="text-xs leading-6 text-[var(--foreground-soft)]">{item}</li>)}</ul> : <p className="mt-4 text-xs text-[var(--foreground-muted)]">本场暂无记录</p>}</section>;
}
