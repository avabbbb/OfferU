"use client";

import { useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Button, Chip, Input, Spinner, Textarea } from "@nextui-org/react";
import {
  ArrowLeft,
  ArrowRight,
  BriefcaseBusiness,
  Check,
  CheckCircle2,
  CircleAlert,
  Clock3,
  FileText,
  GraduationCap,
  Sparkles,
  Upload,
  X,
} from "lucide-react";
import {
  type PersonalArchive,
  SHARED_ROOT_PATHS,
  applyResumeToApplicationSync,
  buildProfileBaseInfoForSave,
  createDefaultPersonalArchive,
  normalizePersonalArchiveFromProfile,
  personalArchiveFactories,
} from "@/lib/personalArchive";
import {
  importProfileResume,
  confirmProfileCandidate,
  updateProfileData,
  type ProfileData,
  type ProfileImportResult,
  type ResumeImportParseMode,
} from "@/lib/hooks";
import { memoryApi } from "@/lib/api";
import { safeClientErrorMessage } from "@/lib/safe-error";
import AIImportModal from "./AIImportModal";

interface ProfileOnboardingProps {
  currentArchive?: PersonalArchive;
  profile?: ProfileData | null;
  onComplete: (archive: PersonalArchive) => void | Promise<void>;
  onClose?: () => void;
}

type RoleFit = "primary" | "secondary" | "adjacent";

interface OnboardingFormState {
  name: string;
  phone: string;
  email: string;
  currentCity: string;
  school: string;
  major: string;
  degree: string;
  graduationDate: string;
  gpa: string;
  targetRoles: Array<{ title: string; fit: RoleFit }>;
  experiences: string[];
  skillsText: string;
  summary: string;
}

const STEP_LABELS = ["身份", "方向", "经历", "检查"];
const ROLE_OPTIONS = ["AI产品运营", "产品助理", "内容运营", "用户运营", "市场策划", "数据运营", "项目助理", "人力资源"];
const DEFAULT_FORM: OnboardingFormState = {
  name: "",
  phone: "",
  email: "",
  currentCity: "",
  school: "",
  major: "",
  degree: "本科",
  graduationDate: "",
  gpa: "",
  targetRoles: [],
  experiences: ["", "", ""],
  skillsText: "",
  summary: "",
};

type CandidateReviewState = "pending" | "accepted" | "rejected" | "deferred";

function candidateProposalId(candidate: ProfileImportResult["bullets"][number]): number {
  const value = Number(candidate.memory_proposal_id || 0);
  return Number.isInteger(value) && value > 0 ? value : 0;
}

function normalizeCandidateReviewState(candidate: ProfileImportResult["bullets"][number]): CandidateReviewState {
  switch (candidate.candidate_state) {
    case "accepted":
      return "accepted";
    case "rejected":
      return "rejected";
    case "deferred":
      return "deferred";
    default:
      return "pending";
  }
}

function candidateSummary(candidate: ProfileImportResult["bullets"][number]): string {
  const content = candidate.content_json || {};
  const direct = [content.bullet, content.description, content.summary].find(
    (value) => typeof value === "string" && value.trim()
  );
  if (direct) return String(direct).trim();
  const normalized = content.normalized;
  if (normalized && typeof normalized === "object") {
    return Object.values(normalized)
      .filter((value) => typeof value === "string" && value.trim())
      .join(" · ")
      .trim();
  }
  return JSON.stringify(content, null, 0);
}

function candidateTypeLabel(sectionType: string): string {
  return ({
    education: "教育",
    experience: "工作经历",
    internship: "实习经历",
    project: "项目",
    skill: "技能",
    certificate: "证书",
  } as Record<string, string>)[sectionType] || sectionType || "经历素材";
}

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function splitList(value: string): string[] {
  return value
    .split(/[,，、；;\n|]+/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

function textToHtml(value: string): string {
  const lines = value
    .split(/\n+/g)
    .map((item) => item.replace(/^[•·●▪◦*+\-\d.)、\s]+/, "").trim())
    .filter(Boolean);
  if (lines.length === 0) return "";
  if (lines.length === 1) return `<p>${lines[0]}</p>`;
  return `<ul>${lines.map((l) => `<li>${l}</li>`).join("")}</ul>`;
}

function buildImportedArchive(imported: ProfileImportResult | null, profile?: ProfileData | null): PersonalArchive {
  if (!imported) return createDefaultPersonalArchive();
  return normalizePersonalArchiveFromProfile({
    id: profile?.id || 0,
    name: clean(imported.base_info?.name || profile?.name),
    headline: profile?.headline || "",
    exit_story: profile?.exit_story || "",
    cross_cutting_advantage: profile?.cross_cutting_advantage || "",
    base_info_json: {
      ...(profile?.base_info_json || {}),
      ...(imported.base_info || {}),
      personal_archive: undefined,
    },
    is_default: true,
    created_at: profile?.created_at || "",
    updated_at: profile?.updated_at || new Date().toISOString(),
    target_roles: profile?.target_roles || [],
    sections:
      imported.bullets?.map((item) => ({
        id: item.index,
        profile_id: profile?.id || 0,
        section_type: item.section_type,
        raw_section_type: item.section_type,
        category_key: item.section_type,
        category_label: "",
        is_custom_category: false,
        parent_id: null,
        title: item.title || "",
        sort_order: item.index,
        content_json: item.content_json || {},
        source: "ai_import",
        confidence: item.confidence ?? 0.7,
        created_at: "",
        updated_at: "",
      })) || [],
  });
}

export function buildOnboardingArchive(
  form: OnboardingFormState,
  imported: ProfileImportResult | null,
  profile?: ProfileData | null
): PersonalArchive {
  const base = buildImportedArchive(imported, profile);
  const archive = JSON.parse(JSON.stringify(base)) as PersonalArchive;
  const resume = archive.resumeArchive;
  const primaryRole = form.targetRoles[0]?.title || resume.basicInfo.jobIntention;

  resume.basicInfo = {
    ...resume.basicInfo,
    name: form.name.trim() || resume.basicInfo.name,
    phone: form.phone.trim() || resume.basicInfo.phone,
    email: form.email.trim() || resume.basicInfo.email,
    currentCity: form.currentCity.trim() || resume.basicInfo.currentCity,
    jobIntention: form.targetRoles.map((item) => item.title).join(" / ") || resume.basicInfo.jobIntention,
  };
  resume.personalSummary =
    form.summary.trim() ||
    resume.personalSummary ||
    (primaryRole ? `面向${primaryRole}方向，具备学习能力、执行推进和项目复盘意识。` : "");

  if (form.school.trim() && !resume.education.some((item) => item.schoolName.trim())) {
    resume.education.unshift({
      ...personalArchiveFactories.createEmptyEducation(),
      schoolName: form.school.trim(),
      degree: form.degree.trim(),
      educationLevel: form.degree.trim(),
      major: form.major.trim(),
      endDate: form.graduationDate.trim(),
      gpa: form.gpa.trim(),
      description: form.gpa.trim() ? `<p>GPA：${form.gpa.trim()}</p>` : "",
    });
  }

  const hasCoreExperience =
    resume.workExperiences.some((item) => item.companyName.trim()) ||
    resume.internshipExperiences.some((item) => item.companyName.trim()) ||
    resume.projects.some((item) => item.projectName.trim());

  if (!hasCoreExperience) {
    form.experiences
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 3)
      .forEach((item, index) => {
        resume.projects.push({
          ...personalArchiveFactories.createEmptyProject(),
          projectName: `补充经历 ${index + 1}`,
          projectRole: primaryRole ? `${primaryRole}候选人` : "",
          description: textToHtml(item),
        });
      });
  }

  const existingSkills = new Set(resume.skills.map((item) => item.skillName.trim()).filter(Boolean));
  for (const skill of splitList(form.skillsText)) {
    if (existingSkills.has(skill)) continue;
    resume.skills.push({
      ...personalArchiveFactories.createEmptySkill(),
      skillName: skill,
    });
    existingSkills.add(skill);
  }

  const synced = applyResumeToApplicationSync(archive, [...SHARED_ROOT_PATHS], true).nextArchive;
  const basic = synced.resumeArchive.basicInfo;
  synced.applicationArchive.identityContact = {
    ...synced.applicationArchive.identityContact,
    chineseName: basic.name,
    phone: basic.phone,
    email: basic.email,
    currentCity: basic.currentCity,
  };
  synced.applicationArchive.jobPreference = {
    ...synced.applicationArchive.jobPreference,
    expectedPosition: basic.jobIntention,
    expectedCities: basic.currentCity ? [basic.currentCity] : synced.applicationArchive.jobPreference.expectedCities,
    employmentType: synced.applicationArchive.jobPreference.employmentType || "实习/校招",
    currentJobSearchStatus: synced.applicationArchive.jobPreference.currentJobSearchStatus || "正在投递",
  };
  synced.applicationArchive.campusFields = {
    ...synced.applicationArchive.campusFields,
    isFreshGraduate: synced.applicationArchive.campusFields.isFreshGraduate || "是",
    graduationDate: form.graduationDate.trim() || synced.applicationArchive.campusFields.graduationDate,
    gpa: form.gpa.trim() || synced.applicationArchive.campusFields.gpa,
  };
  synced.updatedAt = new Date().toISOString();
  return synced;
}

function getDeliverableMissing(archive: PersonalArchive): string[] {
  const resume = archive.resumeArchive;
  const app = archive.applicationArchive;
  const missing: string[] = [];
  if (!resume.basicInfo.name.trim()) missing.push("姓名");
  if (!resume.basicInfo.phone.trim()) missing.push("手机号");
  if (!resume.basicInfo.email.trim()) missing.push("邮箱");
  if (!resume.basicInfo.jobIntention.trim()) missing.push("目标岗位");
  if (!resume.education.some((item) => item.schoolName.trim() && item.major.trim())) missing.push("教育经历");
  if (
    !resume.workExperiences.some((item) => item.companyName.trim()) &&
    !resume.internshipExperiences.some((item) => item.companyName.trim()) &&
    !resume.projects.some((item) => item.projectName.trim())
  ) {
    missing.push("至少一段经历");
  }
  if (!resume.skills.some((item) => item.skillName.trim()) && resume.certificates.length === 0) missing.push("技能/证书");
  if (!app.identityContact.chineseName.trim() || !app.jobPreference.expectedPosition.trim()) missing.push("网申同步字段");
  return missing;
}

export function ProfileOnboarding({ currentArchive, profile, onComplete, onClose }: ProfileOnboardingProps) {
  const [step, setStep] = useState(0);
  const [direction, setDirection] = useState(1);
  const [form, setForm] = useState<OnboardingFormState>(() => {
    const resume = currentArchive?.resumeArchive;
    return {
      ...DEFAULT_FORM,
      name: resume?.basicInfo.name || "",
      phone: resume?.basicInfo.phone || "",
      email: resume?.basicInfo.email || "",
      currentCity: resume?.basicInfo.currentCity || "",
      school: resume?.education[0]?.schoolName || "",
      major: resume?.education[0]?.major || "",
      degree: resume?.education[0]?.degree || resume?.education[0]?.educationLevel || "本科",
      graduationDate: resume?.education[0]?.endDate || "",
      gpa: resume?.education[0]?.gpa || "",
      skillsText: resume?.skills.map((item) => item.skillName).filter(Boolean).join("、") || "",
      summary: resume?.personalSummary || "",
    };
  });
  const [customRole, setCustomRole] = useState("");
  const [imported, setImported] = useState<ProfileImportResult | null>(null);
  const [importing, setImporting] = useState<ResumeImportParseMode | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [aiImportOpen, setAiImportOpen] = useState(false);
  const [candidateReview, setCandidateReview] = useState<Record<number, CandidateReviewState>>({});
  const [reviewingCandidateIndex, setReviewingCandidateIndex] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const importModeRef = useRef<ResumeImportParseMode>("ai");

  const importedForPreview = useMemo(() => {
    if (!imported) return imported;
    return {
      ...imported,
      bullets: imported.bullets.filter((candidate, index) => {
        if (!candidateProposalId(candidate)) return true;
        const state = candidateReview[index] || normalizeCandidateReviewState(candidate);
        return state !== "rejected" && state !== "deferred";
      }),
    };
  }, [candidateReview, imported]);
  const previewArchive = useMemo(() => buildOnboardingArchive(form, importedForPreview, profile), [form, importedForPreview, profile]);
  const missing = useMemo(() => getDeliverableMissing(previewArchive), [previewArchive]);
  const deliverableScore = Math.max(0, Math.round(((8 - Math.min(missing.length, 8)) / 8) * 100));

  const trackedCandidates = imported?.bullets.filter(candidateProposalId) || [];
  const pendingCandidateCount = imported?.bullets.reduce((count, candidate, index) => {
    if (!candidateProposalId(candidate)) return count;
    const state = candidateReview[index] || normalizeCandidateReviewState(candidate);
    return state === "pending" ? count + 1 : count;
  }, 0) || 0;
  const missingEvidenceCandidateCount = imported?.bullets.filter(
    (candidate) => !candidateProposalId(candidate),
  ).length || 0;
  const untrustedAiImport = imported?.filename === "ai-import";
  const acceptedCandidateCount = imported?.bullets.reduce((count, candidate, index) => {
    if (!candidateProposalId(candidate)) return count;
    const state = candidateReview[index] || normalizeCandidateReviewState(candidate);
    return state === "accepted" ? count + 1 : count;
  }, 0) || 0;

  const update = (patch: Partial<OnboardingFormState>) => setForm((prev) => ({ ...prev, ...patch }));
  const canGoNext =
    step === 0
      ? Boolean(form.name.trim() && form.phone.trim() && form.email.trim() && form.school.trim() && form.major.trim())
      : step === 1
        ? form.targetRoles.length > 0
        : step === 2
          ? Boolean(imported || form.experiences.some((item) => item.trim()))
          : true;

  const goNext = () => {
    setDirection(1);
    setStep((prev) => Math.min(prev + 1, STEP_LABELS.length - 1));
  };
  const goBack = () => {
    setDirection(-1);
    setStep((prev) => Math.max(prev - 1, 0));
  };

  const toggleRole = (title: string) => {
    setForm((prev) => {
      const exists = prev.targetRoles.some((item) => item.title === title);
      return {
        ...prev,
        targetRoles: exists
          ? prev.targetRoles.filter((item) => item.title !== title)
          : [...prev.targetRoles, { title, fit: prev.targetRoles.length === 0 ? "primary" : "secondary" }],
      };
    });
  };

  const addCustomRole = () => {
    const title = customRole.trim();
    if (!title) return;
    toggleRole(title);
    setCustomRole("");
  };

  const setImportedResult = (result: ProfileImportResult) => {
    setImported(result);
    const initialReview: Record<number, CandidateReviewState> = {};
    result.bullets.forEach((candidate, index) => {
      if (candidateProposalId(candidate)) {
        initialReview[index] = normalizeCandidateReviewState(candidate);
      }
    });
    setCandidateReview(initialReview);
  };

  const clearImportedResult = () => {
    setImported(null);
    setCandidateReview({});
    setError("");
  };

  const handleAiImport = (result: ProfileImportResult) => {
    setImportedResult(result);
    const base = result.base_info || {};
    setForm((prev) => ({
      ...prev,
      name: prev.name || clean(base.name),
      phone: prev.phone || clean(base.phone),
      email: prev.email || clean(base.email),
      currentCity: prev.currentCity || clean(base.current_city),
      summary: prev.summary || clean(base.summary || base.personal_summary),
    }));
  };

  const openResumeImport = (parseMode: ResumeImportParseMode) => {
    importModeRef.current = parseMode;
    fileInputRef.current?.click();
  };

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    const parseMode = importModeRef.current;
    event.target.value = "";
    if (!file) return;
    setImporting(parseMode);
    setError("");
    try {
      const result = await importProfileResume(file, parseMode);
      setImportedResult(result);
      const base = result.base_info || {};
      setForm((prev) => ({
        ...prev,
        name: prev.name || clean(base.name),
        phone: prev.phone || clean(base.phone),
        email: prev.email || clean(base.email),
        currentCity: prev.currentCity || clean(base.current_city),
        summary: prev.summary || clean(base.summary || base.personal_summary),
      }));
      if (typeof window !== "undefined" && result.agent_session_id) {
        window.dispatchEvent(
          new CustomEvent("offeru:open-profile-agent", {
            detail: {
              sessionId: result.agent_session_id,
              source: "resume_import",
              parseMode,
            },
          })
        );
      }
    } catch (err: any) {
      setError(safeClientErrorMessage(err, "导入失败，请改用手填经历。"));
    } finally {
      setImporting(null);
    }
  };

  const reviewCandidate = async (index: number, action: Exclude<CandidateReviewState, "pending">) => {
    if (!imported || reviewingCandidateIndex !== null) return;
    const candidate = imported.bullets[index];
    const proposalId = candidate && candidateProposalId(candidate);
    if (!candidate || !proposalId) {
      setError("这条候选没有建立可审核的来源提案，暂不写入 Profile。请重新上传原始简历。");
      return;
    }
    setReviewingCandidateIndex(index);
    setError("");
    try {
      if (action === "accepted") {
        await confirmProfileCandidate({ session_id: imported.session_id, bullet_index: index });
      } else {
        await memoryApi.reviewProposal(
          proposalId,
          action === "rejected" ? "reject" : "defer",
          action === "rejected" ? "用户在 Resume 导入审核中拒绝" : "用户在 Resume 导入审核中选择稍后处理"
        );
      }
      setCandidateReview((prev) => ({ ...prev, [index]: action }));
    } catch (err: any) {
      setError(safeClientErrorMessage(err, "候选审核失败，请重试。"));
    } finally {
      setReviewingCandidateIndex(null);
    }
  };

  const handleFinish = async () => {
    if (untrustedAiImport) {
      setError("粘贴的 AI JSON 没有 OfferU 原始来源，不能写入职业档案；请上传 PDF/DOCX，或清除候选后手填并确认。");
      return;
    }
    if (pendingCandidateCount > 0 || missingEvidenceCandidateCount > 0) {
      setError(
        missingEvidenceCandidateCount > 0
          ? "部分简历候选没有建立证据提案，已阻止写入 Profile；请重新上传原始简历。"
          : `还有 ${pendingCandidateCount} 条 Resume 候选未审核。请逐条选择接受、拒绝或稍后处理。`
      );
      return;
    }
    setSaving(true);
    setError("");
    try {
      const reviewedImported = imported
        ? {
            ...imported,
            bullets: imported.bullets.filter((candidate, index) => {
              if (!candidateProposalId(candidate)) return true;
              const state = candidateReview[index] || normalizeCandidateReviewState(candidate);
              return state === "accepted";
            }),
          }
        : imported;
      const archive = buildOnboardingArchive(form, reviewedImported, profile);
      const baseInfoPayload = buildProfileBaseInfoForSave(profile?.base_info_json, archive);
      await updateProfileData({
        name: archive.resumeArchive.basicInfo.name || "默认档案",
        base_info_json: {
          ...(profile?.base_info_json || {}),
          ...baseInfoPayload,
          onboarding_completed_at: new Date().toISOString(),
        },
      });
      await onComplete(archive);
    } catch (err: any) {
      setError(safeClientErrorMessage(err, "保存失败，请稍后重试。"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-[#f6f3ed]/95 p-4 text-[var(--foreground)] backdrop-blur-md">
      <div className="mx-auto flex h-full max-w-6xl flex-col">
        <div className="flex items-center justify-between border-b border-[var(--border-strong)]/10 py-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--foreground-muted)]">OfferU Onboarding</p>
            <h2 className="text-xl font-semibold text-[var(--foreground)]">新人投递档案向导</h2>
          </div>
          <Button isIconOnly variant="light" aria-label="关闭新人向导" onPress={onClose}>
            <X size={18} />
          </Button>
        </div>

        <div className="grid min-h-0 flex-1 gap-5 py-5 lg:grid-cols-[260px_1fr_300px]">
          <aside className="space-y-3 border-r border-[var(--border-strong)]/10 pr-4">
            {STEP_LABELS.map((label, index) => (
              <button
                key={label}
                type="button"
                className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition ${
                  index === step ? "bg-black text-white" : "text-[var(--foreground-muted)] hover:bg-black/5"
                }`}
                onClick={() => {
                  setDirection(index > step ? 1 : -1);
                  setStep(index);
                }}
              >
                <span className="grid h-6 w-6 place-items-center rounded-full border border-current text-xs">
                  {index + 1}
                </span>
                {label}
              </button>
            ))}
          </aside>

          <main className="min-h-0 overflow-y-auto">
            <AnimatePresence mode="wait" custom={direction}>
              {step === 0 && (
                <StepFrame key="identity" direction={direction} icon={GraduationCap} title="先把实名和教育信息打牢" subtitle="这些字段会同时进入简历档案和网申档案。">
                  <div className="grid gap-3 md:grid-cols-2">
                    <Input label="姓名" value={form.name} onValueChange={(name) => update({ name })} variant="bordered" />
                    <Input label="手机号" value={form.phone} onValueChange={(phone) => update({ phone })} variant="bordered" />
                    <Input label="邮箱" value={form.email} onValueChange={(email) => update({ email })} variant="bordered" />
                    <Input label="当前城市" value={form.currentCity} onValueChange={(currentCity) => update({ currentCity })} variant="bordered" />
                    <Input label="学校" value={form.school} onValueChange={(school) => update({ school })} variant="bordered" />
                    <Input label="专业" value={form.major} onValueChange={(major) => update({ major })} variant="bordered" />
                    <Input label="学历" value={form.degree} onValueChange={(degree) => update({ degree })} variant="bordered" />
                    <Input label="毕业时间" placeholder="例如 2026-06" value={form.graduationDate} onValueChange={(graduationDate) => update({ graduationDate })} variant="bordered" />
                    <Input label="GPA / 成绩" value={form.gpa} onValueChange={(gpa) => update({ gpa })} variant="bordered" className="md:col-span-2" />
                  </div>
                </StepFrame>
              )}

              {step === 1 && (
                <StepFrame key="role" direction={direction} icon={BriefcaseBusiness} title="选一个能直接投递的岗位方向" subtitle="先聚焦 1-3 个方向，后面 AI 优化和岗位推荐会沿着它走。">
                  <div className="flex flex-wrap gap-2">
                    {ROLE_OPTIONS.map((role) => {
                      const selected = form.targetRoles.some((item) => item.title === role);
                      return (
                        <Chip key={role} variant={selected ? "solid" : "bordered"} color={selected ? "primary" : "default"} className="cursor-pointer" onClick={() => toggleRole(role)}>
                          {role}
                        </Chip>
                      );
                    })}
                  </div>
                  <div className="mt-4 flex gap-2">
                    <Input placeholder="输入其他岗位，例如 商业分析实习生" value={customRole} onValueChange={setCustomRole} variant="bordered" onKeyDown={(event) => event.key === "Enter" && addCustomRole()} />
                    <Button onPress={addCustomRole}>添加</Button>
                  </div>
                  <div className="mt-5 space-y-2">
                    {form.targetRoles.map((role, index) => (
                      <div key={role.title} className="flex items-center justify-between rounded-md border border-[var(--border-strong)]/10 px-3 py-2">
                        <span className="text-sm font-medium">{role.title}</span>
                        <Chip size="sm" variant="flat">{index === 0 ? "主投" : "备选"}</Chip>
                      </div>
                    ))}
                  </div>
                </StepFrame>
              )}

              {step === 2 && (
                <StepFrame key="experience" direction={direction} icon={FileText} title="导入简历，或者先手填三段经历" subtitle="新人没有完整简历也没关系，先把可投递素材写进档案。">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".pdf,.docx"
                    className="hidden"
                    onChange={handleFileChange}
                  />
                  <div className="grid gap-2 sm:grid-cols-2">
                    <Button
                      className="w-full justify-center"
                      color="primary"
                      startContent={importing === "ai" ? <Spinner size="sm" /> : <Sparkles size={16} />}
                      onPress={() => openResumeImport("ai")}
                      isDisabled={Boolean(importing)}
                    >
                      {importing === "ai" ? "AI 正在精准解析..." : imported?.parse_mode === "ai" ? `AI 已导入 ${imported.filename}` : "AI 精准解析简历"}
                    </Button>
                    <Button
                      className="w-full justify-center"
                      variant="bordered"
                      startContent={importing === "mechanical" ? <Spinner size="sm" /> : <Upload size={16} />}
                      onPress={() => openResumeImport("mechanical")}
                      isDisabled={Boolean(importing)}
                    >
                      {importing === "mechanical"
                        ? "机械解析中..."
                        : imported?.parse_mode === "mechanical"
                          ? `机械已导入 ${imported.filename}`
                          : "原版机械解析"}
                    </Button>
                  </div>
                  <div className="mt-2">
                    <Button className="w-full justify-center" variant="bordered" startContent={<Sparkles size={16} />} onPress={() => setAiImportOpen(true)}>
                      {imported ? `已导入 ${imported.filename === "ai-import" ? "AI 解析结果（仅预览）" : imported.filename}` : "AI 对话导入简历"}
                    </Button>
                  </div>
                  {untrustedAiImport && (
                    <div role="alert" className="mt-3 flex flex-wrap items-start justify-between gap-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-3 text-xs leading-relaxed text-amber-900">
                      <p className="min-w-0 flex-1">这份 AI JSON 没有绑定 OfferU 原始 PDF/DOCX 和证据提案，只能作为临时预览；完成向导前必须清除它并手填，或重新上传原始文件。</p>
                      <Button size="sm" variant="flat" onPress={clearImportedResult}>清除候选，改为手填</Button>
                    </div>
                  )}
                  {imported?.parse_diagnostics && (
                    <div className="mt-3 rounded-md border border-[var(--border-strong)]/10 bg-black/[0.025] px-3 py-2 text-xs text-[var(--foreground-muted)]">
                      <p>
                        {imported.parse_diagnostics.parser === "python-docx"
                          ? "已解析 Word 文档"
                          : `已解析 ${imported.parse_diagnostics.page_count} 页`}
                        {imported.parse_diagnostics.parser === "python-docx"
                          ? ""
                          : imported.parse_diagnostics.used_ocr
                            ? "，其中扫描页已使用 OCR"
                            : "，使用原生文本层"}
                        {` · 质量 ${Math.round(imported.parse_diagnostics.average_quality * 100)}%`}
                      </p>
                      {imported.parse_diagnostics.parser !== "python-docx"
                        && imported.parse_diagnostics.low_quality_pages.length > 0 && (
                        <p className="mt-1 text-amber-700">
                          第 {imported.parse_diagnostics.low_quality_pages.join("、")} 页识别质量偏低，请在确认候选时重点核对。
                        </p>
                        )}
                    </div>
                  )}
                  <AIImportModal
                    open={aiImportOpen}
                    onClose={() => setAiImportOpen(false)}
                    onImport={handleAiImport}
                  />
                  <div className="mt-4 space-y-3">
                    {form.experiences.map((value, index) => (
                      <Textarea
                        key={index}
                        label={`经历 ${index + 1}`}
                        minRows={3}
                        value={value}
                        onValueChange={(next) => {
                          const experiences = [...form.experiences];
                          experiences[index] = next;
                          update({ experiences });
                        }}
                        placeholder="写背景、你负责什么、结果是什么。比如：负责学院公众号选题和推文撰写，单篇最高阅读 8000+。"
                        variant="bordered"
                      />
                    ))}
                  </div>
                </StepFrame>
              )}

              {step === 3 && (
                <StepFrame key="review" direction={direction} icon={Sparkles} title="审核证据，生成可投递档案" subtitle="Resume 候选先进入证据收件箱；逐条确认后，才会进入 Profile T0 和后续岗位分析。">
                  {imported?.bullets.length ? (
                    <div className="mb-4 rounded-md border border-[var(--border-strong)]/10 bg-white p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-sm font-semibold">Resume 证据审核</p>
                          <p className="mt-1 text-xs leading-relaxed text-[var(--foreground-muted)]">
                            已识别 {imported.bullets.length} 条候选 · {trackedCandidates.length} 条可追溯提案 · 已确认 {acceptedCandidateCount} 条
                          </p>
                        </div>
                        <Chip size="sm" color={pendingCandidateCount || missingEvidenceCandidateCount ? "warning" : "success"} variant="flat">
                          {pendingCandidateCount ? `待审核 ${pendingCandidateCount}` : missingEvidenceCandidateCount ? "缺少来源" : "审核完成"}
                        </Chip>
                      </div>
                      <div className="mt-3 space-y-2">
                        {imported.bullets.map((candidate, index) => {
                          const proposalId = candidateProposalId(candidate);
                          const tracked = Boolean(proposalId);
                          const state = tracked
                            ? candidateReview[index] || normalizeCandidateReviewState(candidate)
                            : "pending";
                          const busy = reviewingCandidateIndex === index;
                          return (
                            <div key={`${candidate.index}-${candidate.title}`} className="rounded-md border border-[var(--border-strong)]/10 bg-black/[0.02] p-3">
                              <div className="flex items-start gap-2">
                                <div className="min-w-0 flex-1">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <span className="text-xs font-semibold">{candidate.title || `候选 ${index + 1}`}</span>
                                    <Chip size="sm" variant="flat">{candidateTypeLabel(candidate.section_type)}</Chip>
                                    {candidate.source_pages?.length ? <span className="text-[11px] text-[var(--foreground-muted)]">第 {candidate.source_pages.join("、")} 页</span> : null}
                                  </div>
                                  <p className="mt-1 break-words text-xs leading-relaxed text-[var(--foreground-muted)]">{candidateSummary(candidate)}</p>
                                </div>
                                {tracked ? (
                                  state === "pending" ? (
                                    <span className="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-800">待确认</span>
                                  ) : (
                                    <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] ${state === "accepted" ? "bg-green-100 text-green-700" : state === "rejected" ? "bg-red-100 text-red-700" : "bg-black/5 text-[var(--foreground-muted)]"}`}>
                                      {state === "accepted" ? "已写入" : state === "rejected" ? "已拒绝" : "稍后处理"}
                                    </span>
                                  )
                                ) : (
                                  <CircleAlert className="shrink-0 text-amber-600" size={16} />
                                )}
                              </div>
                              {tracked && state === "pending" ? (
                                <div className="mt-2 flex flex-wrap gap-2">
                                  <Button size="sm" color="success" variant="flat" startContent={<Check size={13} />} isLoading={busy} isDisabled={reviewingCandidateIndex !== null} onPress={() => reviewCandidate(index, "accepted")}>
                                    确认事实
                                  </Button>
                                  <Button size="sm" color="danger" variant="flat" startContent={<X size={13} />} isLoading={busy} isDisabled={reviewingCandidateIndex !== null} onPress={() => reviewCandidate(index, "rejected")}>
                                    不是我的经历
                                  </Button>
                                  <Button size="sm" variant="light" startContent={<Clock3 size={13} />} isLoading={busy} isDisabled={reviewingCandidateIndex !== null} onPress={() => reviewCandidate(index, "deferred")}>
                                    稍后核对
                                  </Button>
                                </div>
                              ) : !tracked ? (
                                <p className="mt-2 text-[11px] leading-relaxed text-amber-700">未建立后端证据提案，这条内容不会写入职业模型；请重新上传原始简历以获得可追溯审核。</p>
                              ) : null}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}
                  <Textarea label="技能 / 工具 / 证书" minRows={3} value={form.skillsText} onValueChange={(skillsText) => update({ skillsText })} placeholder="例如：Excel、SQL、Canva、用户访谈、公众号排版、英语六级" variant="bordered" />
                  <Textarea label="个人简介" minRows={3} value={form.summary} onValueChange={(summary) => update({ summary })} placeholder="一句话总结你的方向和优势；不填也会自动生成基础版本。" variant="bordered" className="mt-3" />
                  <div className="mt-4 rounded-md border border-[var(--border-strong)]/10 bg-white p-4">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-semibold">可投递度 {deliverableScore}%</span>
                      {missing.length === 0 ? <CheckCircle2 className="text-green-600" size={18} /> : <span className="text-xs text-[var(--foreground-muted)]">还差 {missing.length} 项</span>}
                    </div>
                    <div className="mt-3 h-2 overflow-hidden rounded-full bg-black/10">
                      <div className="h-full bg-black transition-all" style={{ width: `${deliverableScore}%` }} />
                    </div>
                    {missing.length > 0 && (
                      <div className="mt-3 flex flex-wrap gap-2">
                        {missing.map((item) => (
                          <Chip key={item} size="sm" variant="flat" color="warning">{item}</Chip>
                        ))}
                      </div>
                    )}
                  </div>
                </StepFrame>
              )}
            </AnimatePresence>

            {error && <div className="mt-4 rounded-md bg-red-600 px-4 py-3 text-sm text-white">{error}</div>}
          </main>

          <aside className="border-l border-[var(--border-strong)]/10 pl-4">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--foreground-muted)]">Result</p>
            <h3 className="mt-2 text-2xl font-semibold">{deliverableScore}%</h3>
            <p className="mt-1 text-sm text-[var(--foreground-muted)]">{missing.length === 0 ? "已经可以作为第一版投递档案。" : `还差 ${missing.join("、")}。`}</p>
            <div className="mt-5 space-y-3 text-sm">
              <PreviewLine label="姓名" value={previewArchive.resumeArchive.basicInfo.name} />
              <PreviewLine label="目标岗位" value={previewArchive.resumeArchive.basicInfo.jobIntention} />
              <PreviewLine label="教育" value={previewArchive.resumeArchive.education[0]?.schoolName} />
              <PreviewLine label="经历数" value={String(previewArchive.resumeArchive.projects.length + previewArchive.resumeArchive.workExperiences.length + previewArchive.resumeArchive.internshipExperiences.length)} />
              <PreviewLine label="技能数" value={String(previewArchive.resumeArchive.skills.length + previewArchive.resumeArchive.certificates.length)} />
            </div>
          </aside>
        </div>

        <div className="flex items-center justify-between border-t border-[var(--border-strong)]/10 py-3">
          <Button variant="light" startContent={<ArrowLeft size={16} />} isDisabled={step === 0 || saving} onPress={goBack}>上一步</Button>
          {step < STEP_LABELS.length - 1 ? (
            <Button color="primary" endContent={<ArrowRight size={16} />} isDisabled={!canGoNext} onPress={goNext}>下一步</Button>
          ) : (
            <Button color="primary" startContent={<CheckCircle2 size={16} />} isLoading={saving} isDisabled={missing.length > 0 || pendingCandidateCount > 0 || missingEvidenceCandidateCount > 0} onPress={handleFinish}>
              {pendingCandidateCount > 0 ? `先审核 ${pendingCandidateCount} 条候选` : "确认并生成可投递档案"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function StepFrame(props: {
  direction: number;
  icon: React.ElementType;
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  const Icon = props.icon;
  return (
    <motion.section
      custom={props.direction}
      initial={{ opacity: 0, x: props.direction > 0 ? 24 : -24 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: props.direction > 0 ? -24 : 24 }}
      transition={{ duration: 0.18 }}
      className="mx-auto max-w-3xl"
    >
      <div className="mb-5 flex items-start gap-3">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-black text-white">
          <Icon size={19} />
        </div>
        <div>
          <h2 className="text-2xl font-semibold text-[var(--foreground)]">{props.title}</h2>
          <p className="mt-1 text-sm text-[var(--foreground-muted)]">{props.subtitle}</p>
        </div>
      </div>
      {props.children}
    </motion.section>
  );
}

function PreviewLine(props: { label: string; value?: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-[var(--border-strong)]/10 pb-2">
      <span className="text-[var(--foreground-muted)]">{props.label}</span>
      <span className="max-w-[160px] truncate text-right font-medium">{props.value?.trim() || "未填写"}</span>
    </div>
  );
}
