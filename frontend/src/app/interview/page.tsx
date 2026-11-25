"use client";

import Link from "next/link";
import { PageHeader } from "@/components/layout/PageHeader";
import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import {
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Spinner,
  Textarea,
  useDisclosure,
} from "@heroui/react";
import { ArrowRight, Building2, ClipboardList, PersonStanding, Plus, Search, Sparkles, X } from "lucide-react";
import {
  collectExperience,
  extractQuestions,
  generateAnswer,
  useInterviewExperiences,
  useInterviewQuestions,
} from "@/lib/hooks";
import { bauhausFieldClassNames, bauhausModalContentClassName } from "@/lib/bauhaus";
import { safeClientErrorMessage } from "@/lib/safe-error";
import { Pill } from "@/components/ui";
import { Disclosure, SPRING, Segmented } from "./kit";

const container = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.05 } },
};

const item = {
  hidden: { opacity: 0, y: 10 },
  show: { opacity: 1, y: 0, transition: SPRING },
};

const categoryConfig: Record<string, { label: string }> = {
  behavioral: { label: "行为类" },
  technical: { label: "技术类" },
  case: { label: "案例类" },
  motivation: { label: "动机类" },
};

const roundConfig: Record<string, string> = {
  hr: "HR面",
  department: "业务面",
  final: "终面",
};

export default function InterviewPage() {
  const [companyFilter, setCompanyFilter] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [activeTab, setActiveTab] = useState<string>("questions");

  const { data: questions, mutate: mutateQuestions } = useInterviewQuestions(
    categoryFilter === "all"
      ? companyFilter
        ? { company: companyFilter }
        : undefined
      : { category: categoryFilter, ...(companyFilter ? { company: companyFilter } : {}) }
  );
  const { data: experiences, mutate: mutateExperiences } = useInterviewExperiences(
    companyFilter || undefined
  );

  const { isOpen: isCollectOpen, onOpen: onCollectOpen, onClose: onCollectClose } = useDisclosure();
  const [newCompany, setNewCompany] = useState("");
  const [newRole, setNewRole] = useState("");
  const [newRawText, setNewRawText] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const [extractingId, setExtractingId] = useState<number | null>(null);
  const [generatingId, setGeneratingId] = useState<number | null>(null);
  const [answerMap, setAnswerMap] = useState<Record<number, string>>({});
  const [interviewError, setInterviewError] = useState("");

  useEffect(() => {
    if (!interviewError) return;
    const t = setTimeout(() => setInterviewError(""), 5500);
    return () => clearTimeout(t);
  }, [interviewError]);

  const handleCollect = async () => {
    if (!newCompany.trim() || !newRole.trim() || !newRawText.trim()) return;
    setSubmitting(true);
    try {
      const result = await collectExperience({
        company: newCompany.trim(),
        role: newRole.trim(),
        raw_text: newRawText.trim(),
      });
      setExtractingId(result.id);
      try {
        await extractQuestions(result.id);
      } catch {}
      setExtractingId(null);
      mutateExperiences();
      mutateQuestions();
      onCollectClose();
      setNewCompany("");
      setNewRole("");
      setNewRawText("");
    } catch (error: any) {
      setInterviewError(safeClientErrorMessage(error, "提交失败"));
    } finally {
      setSubmitting(false);
    }
  };

  const handleExtract = async (experienceId: number) => {
    setExtractingId(experienceId);
    try {
      await extractQuestions(experienceId);
      mutateQuestions();
    } catch (error: any) {
      setInterviewError(safeClientErrorMessage(error, "提炼失败"));
    } finally {
      setExtractingId(null);
    }
  };

  const handleGenerateAnswer = async (questionId: number) => {
    setGeneratingId(questionId);
    try {
      const result = await generateAnswer(questionId);
      setAnswerMap((prev) => ({ ...prev, [questionId]: result.suggested_answer }));
      mutateQuestions();
    } catch (error: any) {
      setInterviewError(safeClientErrorMessage(error, "生成失败"));
    } finally {
      setGeneratingId(null);
    }
  };

  const difficultyStars = (difficulty: number) => "★".repeat(difficulty) + "☆".repeat(5 - difficulty);
  const tab = activeTab as "questions" | "experiences";

  return (
    <motion.div variants={container} initial="hidden" animate="show" className="stage-page stage-page--interview iv-page-wide space-y-8">
      <PageHeader title="准备" description="先来一场模拟面试；题库和面经在下面，随时翻。" />

      <motion.section variants={item} className="iv-hero-actions" aria-label="开始练习">
        <Link href="/interview/ai" className="iv-launch" data-testid="interview-start-mock">
          <span className="iv-launch-soft text-[length:var(--ou-type-sm)] font-medium">约 15–25 分钟 · AI 出题、逐题反馈</span>
          <span className="flex items-end justify-between gap-3">
            <span className="text-[length:var(--ou-type-page)] font-semibold leading-tight">开始模拟面试</span>
            <ArrowRight size={22} aria-hidden="true" className="shrink-0" />
          </span>
        </Link>
        <Link href="/interview/pose" className="iv-tile-link">
          <span className="ou-tile" aria-hidden="true"><PersonStanding size={15} /></span>
          <span>
            <span className="iv-h3 block">姿态训练</span>
            <span className="iv-meta mt-0.5 block">1 分钟坐姿校准练习</span>
          </span>
        </Link>
        <Link href="/interview/review" className="iv-tile-link">
          <span className="ou-tile" aria-hidden="true"><ClipboardList size={15} /></span>
          <span>
            <span className="iv-h3 block">复盘</span>
            <span className="iv-meta mt-0.5 block">记下真实面试被问到的题</span>
          </span>
        </Link>
      </motion.section>

      <motion.section variants={item} className="space-y-4" aria-label="题库与面经">
        <div className="iv-toolbar">
          <Segmented
            inline
            label="题库或面经"
            value={tab}
            onChange={(key) => setActiveTab(key)}
            options={[
              { value: "questions", label: `题库 ${questions?.length ?? 0}` },
              { value: "experiences", label: `面经 ${experiences?.length ?? 0}` },
            ]}
          />
          <label className="iv-search">
            <Search size={15} aria-hidden="true" />
            <input placeholder="搜索公司…" aria-label="搜索公司" value={companyFilter} onChange={(event) => setCompanyFilter(event.target.value)} />
          </label>
          <button type="button" onClick={onCollectOpen} className="iv-secondary ml-auto"><Plus size={16} aria-hidden="true" /> 粘贴面经</button>
        </div>

        {tab === "questions" && (
          <div className="iv-filter" role="group" aria-label="题目类型">
            <button type="button" className="iv-chip" aria-pressed={categoryFilter === "all"} onClick={() => setCategoryFilter("all")}><span>全部</span></button>
            {Object.entries(categoryConfig).map(([key, cfg]) => (
              <button key={key} type="button" className="iv-chip" aria-pressed={categoryFilter === key} onClick={() => setCategoryFilter(key)}><span>{cfg.label}</span></button>
            ))}
          </div>
        )}

        {interviewError && (
          <div role="alert" className="iv-alert flex items-center justify-between gap-3">
            <span>{interviewError}</span>
            <button type="button" onClick={() => setInterviewError("")} className="iv-icon-btn -my-2 -mr-2" aria-label="关闭错误提示"><X size={15} /></button>
          </div>
        )}
      </motion.section>

      {tab === "questions" && (
        <div className="space-y-3">
          {questions && questions.length > 0 ? (
            questions.map((question) => {
              const cfg = categoryConfig[question.category] || categoryConfig.behavioral;
              const answer = answerMap[question.id] || question.suggested_answer;
              const busy = generatingId === question.id;
              return (
                <motion.article key={question.id} variants={item} className="iv-card">
                  <p className="iv-h3 leading-snug">{question.question_text}</p>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <Pill tone="gray">{cfg.label}</Pill>
                    <Pill tone="gray">{roundConfig[question.round_type] || question.round_type}</Pill>
                    {question.frequency > 1 && <Pill tone="orange">出现 {question.frequency} 次</Pill>}
                    <span className="iv-meta tracking-[0.08em]" aria-label={`难度 ${question.difficulty}/5`}>{difficultyStars(question.difficulty)}</span>
                  </div>
                  <div className="mt-4 space-y-2">
                    {answer && <Disclosure title="推荐回答思路"><p className="whitespace-pre-wrap">{answer}</p></Disclosure>}
                    <button type="button" className="iv-quiet -ml-3" disabled={busy} onClick={() => handleGenerateAnswer(question.id)}>
                      {busy ? <Spinner size="sm" color="current" /> : <Sparkles size={15} aria-hidden="true" />}
                      {answer ? "重新生成回答" : "生成回答思路"}
                    </button>
                  </div>
                </motion.article>
              );
            })
          ) : (
            <motion.div variants={item} className="iv-card iv-empty">
              <p className="iv-h3">题库还是空的</p>
              <p className="iv-muted max-w-sm">粘贴一篇面经，AI 会把里面的问题提炼出来放进题库。</p>
              <button type="button" onClick={onCollectOpen} className="iv-quiet mt-1"><Plus size={15} aria-hidden="true" /> 粘贴面经</button>
            </motion.div>
          )}
        </div>
      )}

      {tab === "experiences" && (
        <div className="space-y-3">
          {experiences && experiences.length > 0 ? (
            experiences.map((experience) => (
              <motion.article key={experience.id} variants={item} className="iv-card">
                <div className="iv-row">
                  <div className="min-w-0">
                    <p className="iv-h3 flex flex-wrap items-center gap-x-2"><Building2 size={15} className="text-[var(--ou-text-tertiary)]" aria-hidden="true" />{experience.company}<span className="font-medium text-[var(--ou-text-secondary)]">· {experience.role}</span></p>
                    <p className="iv-meta mt-1">
                      来源：{experience.source_platform}
                      {experience.collected_at && ` · ${new Date(experience.collected_at).toLocaleDateString("zh-CN")}`}
                    </p>
                  </div>
                  <button type="button" className="iv-quiet" disabled={extractingId === experience.id} onClick={() => handleExtract(experience.id)}>
                    {extractingId === experience.id ? <Spinner size="sm" color="current" /> : <Sparkles size={15} aria-hidden="true" />} 提炼问题
                  </button>
                </div>
              </motion.article>
            ))
          ) : (
            <motion.div variants={item} className="iv-card iv-empty">
              <p className="iv-h3">还没有面经</p>
              <p className="iv-muted">把看到的面经原文粘贴进来，就会出现在这里。</p>
              <button type="button" onClick={onCollectOpen} className="iv-quiet mt-1"><Plus size={15} aria-hidden="true" /> 粘贴面经</button>
            </motion.div>
          )}
        </div>
      )}

      <Modal isOpen={isCollectOpen} onClose={onCollectClose} size="2xl" placement="center">
        <ModalContent className={bauhausModalContentClassName}>
          <ModalHeader className="px-6 pb-2 pt-6">
            <span className="iv-h2">粘贴面经原文</span>
          </ModalHeader>
          <ModalBody className="space-y-4 px-6 py-4">
            <div className="grid gap-3 md:grid-cols-2">
              <Input label="公司" placeholder="如：字节跳动" variant="bordered" value={newCompany} onValueChange={setNewCompany} classNames={bauhausFieldClassNames} />
              <Input label="岗位" placeholder="如：前端开发" variant="bordered" value={newRole} onValueChange={setNewRole} classNames={bauhausFieldClassNames} />
            </div>
            <Textarea
              label="面经原文"
              placeholder="将面经原文粘贴到这里，AI 会自动提炼出面试问题..."
              variant="bordered"
              minRows={8}
              maxRows={16}
              value={newRawText}
              onValueChange={setNewRawText}
              classNames={bauhausFieldClassNames}
            />
            <p className="iv-meta">提交后 AI 会自动提炼面试问题，通常 10–20 秒。</p>
          </ModalBody>
          <ModalFooter className="px-6 pb-6 pt-2">
            <button type="button" onClick={onCollectClose} className="iv-quiet">取消</button>
            <button
              type="button"
              disabled={submitting || !newCompany.trim() || !newRole.trim() || !newRawText.trim()}
              onClick={handleCollect}
              className="iv-primary"
            >
              {submitting && <Spinner size="sm" color="current" />} 提交并提炼
            </button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </motion.div>
  );
}
