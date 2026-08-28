"use client";

import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import {
  Button,
  Card,
  CardBody,
  Chip,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Spinner,
  Tab,
  Tabs,
  Textarea,
  useDisclosure,
} from "@nextui-org/react";
import {
  Briefcase,
  Building2,
  GraduationCap,
  MessageSquare,
  Plus,
  Search,
  Sparkles,
} from "lucide-react";
import {
  collectExperience,
  extractQuestions,
  generateAnswer,
  useInterviewExperiences,
  useInterviewQuestions,
} from "@/lib/hooks";
import {
  bauhausFieldClassNames,
  bauhausModalContentClassName,
  bauhausTabsClassNames,
} from "@/lib/bauhaus";

const container = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.08 } },
};

const item = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.24, ease: "easeOut" } },
};

const categoryConfig: Record<string, { label: string; chipClass: string }> = {
  behavioral: { label: "行为类", chipClass: "border border-[var(--border-strong)] bg-[var(--surface-muted)] text-[var(--foreground)] font-semibold" },
  technical: { label: "技术类", chipClass: "border border-[var(--border-strong)] bg-[var(--surface-muted)] text-[var(--foreground)] font-semibold" },
  case: { label: "案例类", chipClass: "border border-[var(--border-strong)] bg-[var(--status-blush)] text-[var(--foreground)] font-semibold" },
  motivation: { label: "动机类", chipClass: "border border-[var(--border-strong)] bg-white text-[var(--foreground)] font-semibold" },
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
      setInterviewError(error.message || "提交失败");
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
      setInterviewError(error.message || "提炼失败");
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
      setInterviewError(error.message || "生成失败");
    } finally {
      setGeneratingId(null);
    }
  };

  const difficultyStars = (difficulty: number) => "★".repeat(difficulty) + "☆".repeat(5 - difficulty);

  return (
    <motion.div variants={container} initial="hidden" animate="show" className="stage-page stage-page--interview space-y-6">
      <motion.section variants={item} className="stage-hero bauhaus-panel overflow-hidden bg-white">
        <div className="grid gap-6 p-6 md:p-8 xl:grid-cols-[1.05fr_0.95fr]">
          <div className="space-y-4">
            <span className="bauhaus-chip bg-[var(--surface-muted)] text-[var(--foreground)]">面试题库</span>
            <div>
              <p className="bauhaus-label text-[var(--foreground-muted)]">题目面板</p>
              <h1 className="mt-3 text-5xl font-black uppercase leading-[0.88] tracking-[-0.08em] sm:text-6xl">面试</h1>
              <p className="mt-4 max-w-2xl text-base font-medium leading-relaxed text-[var(--foreground-muted)]">
                把散落在社群、帖子和个人记录里的面经重新组织成可搜索题库，再基于档案生成回答思路，
                让准备面试的节奏更稳定，也更容易复盘高频题。
              </p>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-3 xl:grid-cols-1">
            <div className="bauhaus-panel-sm bg-[var(--surface-muted)] p-4 text-[var(--foreground)]">
              <p className="bauhaus-label text-[var(--foreground-muted)]">题目</p>
              <p className="mt-3 text-4xl font-black uppercase tracking-[-0.08em]">{questions?.length ?? 0}</p>
            </div>
            <div className="bauhaus-panel-sm bg-[var(--surface-muted)] p-4 text-[var(--foreground)]">
              <p className="bauhaus-label text-[var(--foreground-muted)]">经验</p>
              <p className="mt-3 text-4xl font-black uppercase tracking-[-0.08em]">{experiences?.length ?? 0}</p>
            </div>
            <div className="bauhaus-panel-sm bg-[var(--status-blush)] p-4 text-[var(--foreground)]">
              <p className="bauhaus-label text-[var(--foreground-muted)]">行动</p>
              <p className="mt-3 text-lg font-black uppercase tracking-[-0.05em]">AI 提炼 / AI 回答</p>
            </div>
          </div>
        </div>
      </motion.section>

      <motion.section variants={item} className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <Input
            placeholder="搜索公司..."
            size="sm"
            variant="bordered"
            startContent={<Search size={14} className="text-[var(--foreground-muted)]" />}
            value={companyFilter}
            onValueChange={setCompanyFilter}
            classNames={{
              ...bauhausFieldClassNames,
              base: "w-[220px]",
            }}
          />
          <Tabs
            selectedKey={activeTab}
            onSelectionChange={(key) => setActiveTab(key as string)}
            size="sm"
            classNames={bauhausTabsClassNames}
          >
            <Tab key="questions" title={`题库 (${questions?.length ?? 0})`} />
            <Tab key="experiences" title={`面经 (${experiences?.length ?? 0})`} />
          </Tabs>
        </div>

        <Button
          startContent={<Plus size={16} />}
          onPress={onCollectOpen}
          className="bauhaus-button bauhaus-button-red !px-4 !py-3 !text-[11px]"
        >
          粘贴面经
        </Button>
      </motion.section>

      {interviewError && (
        <motion.div variants={item} role="alert" className="bauhaus-panel-sm flex items-center justify-between bg-[var(--status-blush)] px-5 py-3 text-sm font-bold text-[#b7483c]">
          <span>{interviewError}</span>
          <button onClick={() => setInterviewError("")} className="ml-4 font-black" aria-label="关闭错误提示">✕</button>
        </motion.div>
      )}

      {activeTab === "questions" && (
        <motion.section variants={item} className="flex flex-wrap gap-2">
          <Chip
            variant="flat"
            className={`cursor-pointer border border-[var(--border-strong)] font-semibold ${
              categoryFilter === "all" ? "bg-[var(--surface-muted)] text-[var(--foreground)]" : "bg-white text-[var(--foreground)]"
            }`}
            onClick={() => setCategoryFilter("all")}
          >
            全部
          </Chip>
          {Object.entries(categoryConfig).map(([key, cfg]) => (
            <Chip
              key={key}
              variant="flat"
              className={`${cfg.chipClass} cursor-pointer ${categoryFilter === key ? "" : "opacity-75"}`}
              onClick={() => setCategoryFilter(key)}
            >
              {cfg.label}
            </Chip>
          ))}
        </motion.section>
      )}

      {activeTab === "questions" && (
        <div className="space-y-4">
          {questions && questions.length > 0 ? (
            questions.map((question) => {
              const cfg = categoryConfig[question.category] || categoryConfig.behavioral;
              const answer = answerMap[question.id] || question.suggested_answer;
              return (
                <motion.div key={question.id} variants={item}>
                  <Card className="bauhaus-panel rounded-none bg-white shadow-none">
                    <CardBody className="space-y-4 p-5">
                      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                        <div>
                          <p className="text-xl font-black tracking-[-0.04em] text-[var(--foreground)]">{question.question_text}</p>
                          <div className="mt-3 flex flex-wrap items-center gap-2">
                            <Chip size="sm" variant="flat" className={cfg.chipClass}>{cfg.label}</Chip>
                            <Chip size="sm" variant="flat" className="border border-[var(--border-strong)] bg-white font-semibold text-[var(--foreground)]">
                              {roundConfig[question.round_type] || question.round_type}
                            </Chip>
                            <span className="text-xs font-bold tracking-[0.08em] text-[var(--foreground-muted)]" aria-label={`难度 ${question.difficulty}/5`}>{difficultyStars(question.difficulty)}</span>
                            {question.frequency > 1 && (
                              <Chip size="sm" variant="flat" className="border border-[var(--border-strong)] bg-[var(--status-blush)] font-semibold text-[#b7483c]">
                                出现 {question.frequency} 次
                              </Chip>
                            )}
                          </div>
                        </div>
                        <Button
                          size="sm"
                          startContent={generatingId === question.id ? <Spinner size="sm" /> : <Sparkles size={14} />}
                          isDisabled={generatingId === question.id}
                          onPress={() => handleGenerateAnswer(question.id)}
                          className="bauhaus-button bauhaus-button-blue !px-4 !py-3 !text-[11px]"
                        >
                          {answer ? "重新生成" : "生成回答"}
                        </Button>
                      </div>

                      {answer && (
                        <div className="bauhaus-panel-sm bg-[var(--surface-muted)] p-4">
                          <div className="mb-2 flex items-center gap-1 text-xs font-semibold tracking-[0.04em] text-[var(--foreground-muted)]">
                            <MessageSquare size={12} />
                            推荐回答思路
                          </div>
                          <p className="whitespace-pre-wrap text-sm font-medium leading-relaxed text-[var(--foreground-muted)]">
                            {answer}
                          </p>
                        </div>
                      )}
                    </CardBody>
                  </Card>
                </motion.div>
              );
            })
          ) : (
            <motion.div variants={item}>
              <Card className="bauhaus-panel rounded-none bg-[var(--surface-muted)] text-[var(--foreground)] shadow-none">
                <CardBody className="p-10 text-center">
                  <GraduationCap size={54} className="mx-auto text-[var(--foreground-muted)]" aria-hidden="true" />
                  <p className="mt-4 text-2xl font-black uppercase tracking-[-0.05em]">题库为空</p>
                  <p className="mt-3 text-sm font-medium text-[var(--foreground-muted)]">
                    点击右上角「粘贴面经」添加第一条原始记录，AI 会自动提炼问题。
                  </p>
                </CardBody>
              </Card>
            </motion.div>
          )}
        </div>
      )}

      {activeTab === "experiences" && (
        <div className="space-y-4">
          {experiences && experiences.length > 0 ? (
            experiences.map((experience) => (
              <motion.div key={experience.id} variants={item}>
                <Card className="bauhaus-panel rounded-none bg-white shadow-none">
                  <CardBody className="space-y-4 p-5">
                    <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                      <div>
                        <div className="flex flex-wrap items-center gap-2 text-[var(--foreground)]">
                          <Building2 size={14} className="text-[var(--foreground-muted)]" />
                          <span className="text-lg font-black tracking-[-0.04em]">{experience.company}</span>
                          <span className="text-[var(--foreground-muted)]">·</span>
                          <Briefcase size={14} className="text-[var(--foreground-muted)]" />
                          <span className="text-sm font-bold">{experience.role}</span>
                        </div>
                        <div className="mt-2 flex flex-wrap items-center gap-3 text-xs font-medium text-[var(--foreground-muted)]">
                          <span>来源: {experience.source_platform}</span>
                          {experience.collected_at && (
                            <span>{new Date(experience.collected_at).toLocaleDateString("zh-CN")}</span>
                          )}
                        </div>
                      </div>

                      <Button
                        size="sm"
                        startContent={extractingId === experience.id ? <Spinner size="sm" /> : <Sparkles size={14} />}
                        isDisabled={extractingId === experience.id}
                        onPress={() => handleExtract(experience.id)}
                        className="bauhaus-button bauhaus-button-yellow !px-4 !py-3 !text-[11px]"
                      >
                        提炼问题
                      </Button>
                    </div>
                  </CardBody>
                </Card>
              </motion.div>
            ))
          ) : (
            <motion.div variants={item}>
              <Card className="bauhaus-panel rounded-none bg-[var(--surface-muted)] text-[var(--foreground)] shadow-none">
                <CardBody className="p-10 text-center">
                  <GraduationCap size={54} className="mx-auto text-[var(--foreground-muted)]" aria-hidden="true" />
                  <p className="mt-4 text-2xl font-black uppercase tracking-[-0.05em]">暂无经验</p>
                  <p className="mt-3 text-sm font-medium text-[var(--foreground-muted)]">点击右上角「粘贴面经」开始收集。</p>
                </CardBody>
              </Card>
            </motion.div>
          )}
        </div>
      )}

      <Modal isOpen={isCollectOpen} onClose={onCollectClose} size="2xl" placement="center">
        <ModalContent className={bauhausModalContentClassName}>
          <ModalHeader className="flex items-center gap-2 border-b border-[var(--border-strong)]/12 bg-[var(--surface-muted)] px-6 py-5 text-xl font-black tracking-[-0.06em]">
            <GraduationCap size={20} aria-hidden="true" />
            粘贴面经原文
          </ModalHeader>
          <ModalBody className="space-y-4 px-6 py-6">
            <div className="grid gap-3 md:grid-cols-2">
              <Input
                label="公司"
                placeholder="如：字节跳动"
                variant="bordered"
                value={newCompany}
                onValueChange={setNewCompany}
                classNames={bauhausFieldClassNames}
              />
              <Input
                label="岗位"
                placeholder="如：前端开发"
                variant="bordered"
                value={newRole}
                onValueChange={setNewRole}
                classNames={bauhausFieldClassNames}
              />
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
            <div className="bauhaus-panel-sm bg-white px-4 py-3 text-xs font-medium text-[var(--foreground-muted)]">
              提交后 AI 会自动提炼面试问题，通常耗时 10-20 秒。
            </div>
          </ModalBody>
          <ModalFooter className="border-t-2 border-[var(--border-strong)] px-6 py-5">
            <Button variant="light" onPress={onCollectClose} className="bauhaus-button bauhaus-button-outline !px-4 !py-3 !text-[11px]">
              取消
            </Button>
            <Button
              isLoading={submitting}
              isDisabled={!newCompany.trim() || !newRole.trim() || !newRawText.trim()}
              onPress={handleCollect}
              className="bauhaus-button bauhaus-button-red !px-4 !py-3 !text-[11px]"
            >
              提交并提炼
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </motion.div>
  );
}
