"use client";

import { motion } from "framer-motion";
import {
  ArrowRight,
  BadgeCheck,
  BriefcaseBusiness,
  ContactRound,
  GraduationCap,
  Sparkles,
  Target,
  Wrench,
} from "lucide-react";
import type {
  ArchiveCompletenessMetrics,
  ArchiveTab,
  PersonalArchive,
  ResumeBasicInfo,
} from "@/lib/personalArchive";
import { useWorkbench } from "@/lib/workbench";
import type {
  InspectorAction,
  InspectorField,
} from "@/components/workbench/InspectorPanel";

interface ProfileOverviewProps {
  archive: PersonalArchive;
  metrics: ArchiveCompletenessMetrics;
  onOpenView: (view: ArchiveTab, focusSection?: string) => void;
  onStartOnboarding: () => void;
  onUpdateBasicInfo: (field: keyof ResumeBasicInfo, value: string) => void;
  onSave: () => void | Promise<void>;
}

interface FactGroup {
  id: string;
  title: string;
  summary: string;
  meta: string;
  status: string;
  complete: boolean;
  icon: typeof ContactRound;
  focusSection: string;
  fields: InspectorField[];
}

function compact(values: Array<string | undefined>, fallback: string) {
  const text = values.map((value) => value?.trim()).filter(Boolean).join(" · ");
  return text || fallback;
}

export default function ProfileOverview(props: ProfileOverviewProps) {
  const { selection, select } = useWorkbench();
  const resume = props.archive.resumeArchive;
  const basic = resume.basicInfo;

  const identityValues = [basic.name, basic.phone, basic.email, basic.currentCity];
  const identityCompleted = identityValues.filter((value) => value.trim()).length;
  const experienceCount =
    resume.workExperiences.length +
    resume.internshipExperiences.length +
    resume.projects.length +
    resume.personalExperiences.length;
  const skillCount = resume.skills.length + resume.certificates.length + resume.awards.length;

  const experiencePreview = compact(
    [
      resume.workExperiences[0]
        ? compact(
            [
              resume.workExperiences[0].companyName,
              resume.workExperiences[0].positionName,
            ],
            ""
          )
        : undefined,
      resume.internshipExperiences[0]
        ? compact(
            [
              resume.internshipExperiences[0].companyName,
              resume.internshipExperiences[0].positionName,
            ],
            ""
          )
        : undefined,
      resume.projects[0]?.projectName,
    ],
    "还没有记录经历"
  );

  const groups: FactGroup[] = [
    {
      id: "identity",
      title: "身份与联系",
      summary: compact([basic.name, basic.currentCity], "补充姓名与所在城市"),
      meta: `${identityCompleted} / 4 项核心信息`,
      status: identityCompleted === 4 ? "基础信息已齐" : `待补 ${4 - identityCompleted} 项`,
      complete: identityCompleted === 4,
      icon: ContactRound,
      focusSection: "basicInfo",
      fields: [
        {
          label: "姓名",
          value: basic.name,
          placeholder: "填写姓名",
          onCommit: (value) => props.onUpdateBasicInfo("name", value),
        },
        {
          label: "电话",
          value: basic.phone,
          inputType: "tel",
          placeholder: "填写联系电话",
          onCommit: (value) => props.onUpdateBasicInfo("phone", value),
        },
        {
          label: "邮箱",
          value: basic.email,
          inputType: "email",
          placeholder: "填写常用邮箱",
          onCommit: (value) => props.onUpdateBasicInfo("email", value),
        },
        {
          label: "当前城市",
          value: basic.currentCity,
          placeholder: "填写所在城市",
          onCommit: (value) => props.onUpdateBasicInfo("currentCity", value),
        },
      ],
    },
    {
      id: "direction",
      title: "求职方向",
      summary: compact([basic.jobIntention], "还没有确定目标岗位"),
      meta: resume.personalSummary.trim() ? "方向与简介已建立" : "个人简介待补",
      status: basic.jobIntention.trim() ? "方向已记录" : "待明确方向",
      complete: Boolean(basic.jobIntention.trim()),
      icon: Target,
      focusSection: basic.jobIntention.trim() ? "personalSummary" : "basicInfo.jobIntention",
      fields: [
        {
          label: "目标岗位",
          value: basic.jobIntention,
          placeholder: "例如：产品运营",
          onCommit: (value) => props.onUpdateBasicInfo("jobIntention", value),
        },
        {
          label: "个人简介",
          value: resume.personalSummary || "未填写",
        },
        {
          label: "个人网站",
          value: basic.website,
          inputType: "url",
          placeholder: "https://",
          onCommit: (value) => props.onUpdateBasicInfo("website", value),
        },
        {
          label: "GitHub",
          value: basic.github,
          inputType: "url",
          placeholder: "https://github.com/",
          onCommit: (value) => props.onUpdateBasicInfo("github", value),
        },
      ],
    },
    {
      id: "education",
      title: "教育",
      summary: compact(
        [
          resume.education[0]?.schoolName,
          resume.education[0]?.major,
          resume.education[0]?.educationLevel,
        ],
        "还没有记录教育经历"
      ),
      meta: `${resume.education.length} 条教育经历`,
      status: resume.education.length > 0 ? "已有事实" : "待补教育",
      complete: resume.education.length > 0,
      icon: GraduationCap,
      focusSection: "education",
      fields: [
        { label: "条目数", value: String(resume.education.length), emphasis: true },
        { label: "学校", value: resume.education[0]?.schoolName || "未填写" },
        { label: "专业", value: resume.education[0]?.major || "未填写" },
        { label: "学历", value: resume.education[0]?.educationLevel || "未填写" },
      ],
    },
    {
      id: "experience",
      title: "经历",
      summary: experiencePreview,
      meta: `${experienceCount} 条工作、实习、项目或个人经历`,
      status: experienceCount > 0 ? "已有事实" : "待补经历",
      complete: experienceCount > 0,
      icon: BriefcaseBusiness,
      focusSection:
        resume.workExperiences.length > 0
          ? "workExperiences"
          : resume.internshipExperiences.length > 0
            ? "internshipExperiences"
            : "projects",
      fields: [
        { label: "工作", value: `${resume.workExperiences.length} 条` },
        { label: "实习", value: `${resume.internshipExperiences.length} 条` },
        { label: "项目", value: `${resume.projects.length} 条` },
        { label: "其他经历", value: `${resume.personalExperiences.length} 条` },
      ],
    },
    {
      id: "skills",
      title: "技能与证明",
      summary: compact(
        resume.skills.slice(0, 4).map((item) => item.skillName),
        "还没有记录技能、证书或奖项"
      ),
      meta: `${skillCount} 条技能、证书或奖项`,
      status: skillCount > 0 ? "已有事实" : "待补能力",
      complete: skillCount > 0,
      icon: Wrench,
      focusSection: "skills",
      fields: [
        { label: "技能", value: `${resume.skills.length} 条` },
        { label: "证书", value: `${resume.certificates.length} 条` },
        { label: "奖项", value: `${resume.awards.length} 条` },
        {
          label: "能力预览",
          value:
            resume.skills
              .slice(0, 5)
              .map((item) => item.skillName)
              .filter(Boolean)
              .join("、") || "未填写",
        },
      ],
    },
  ];

  const firstResumeMissing = props.metrics.missingResumeSections[0];
  const firstResumeMissingKey = props.metrics.missingResumeSectionKeys[0];
  const firstApplicationMissing = props.metrics.missingApplicationSections[0];
  const firstApplicationMissingKey = props.metrics.missingApplicationSectionKeys[0];

  const nextAction = !basic.name.trim()
    ? {
        eyebrow: "先建立第一版个人事实",
        title: "完成四步建档向导",
        description: "补齐身份、方向、经历和技能，生成可继续维护的个人档案。",
        label: "开始向导",
        run: props.onStartOnboarding,
      }
    : firstResumeMissing
      ? {
          eyebrow: "建议下一步",
          title: `补充${firstResumeMissing}`,
          description: `简历输出仍缺少${firstResumeMissing}，先补这一项能最大幅度减少后续重复填写。`,
          label: "去补充",
          run: () => props.onOpenView("resume", firstResumeMissingKey),
        }
      : firstApplicationMissing
        ? {
            eyebrow: "建议下一步",
            title: `补充${firstApplicationMissing}`,
            description: `个人事实已经可以支撑简历，继续补齐网申常用字段。`,
            label: "去补充",
            run: () => props.onOpenView("application", firstApplicationMissingKey),
          }
        : {
            eyebrow: "档案已具备基础可用性",
            title: "检查简历输出",
            description: "查看个人事实如何被组织成简历表达，再决定是否调整内容。",
            label: "查看简历输出",
            run: () => props.onOpenView("resume"),
          };

  const selectGroup = (group: FactGroup) => {
    const actions: InspectorAction[] = [
      {
        label: "保存档案",
        tone: "primary",
        onAction: props.onSave,
      },
      {
        label: "进入完整编辑",
        onAction: () => props.onOpenView("resume", group.focusSection),
      },
    ];
    select({
      kind: "profile-fact",
      id: group.id,
      title: group.title,
      subtitle: group.summary,
      data: {
        fields: group.fields,
        actions,
        agentContext: {
          fact_group: group.id,
          fact_status: group.status,
          fact_summary: group.summary,
        },
      },
    });
  };

  return (
    <div className="space-y-5">
      <section className="profile-woven-accent relative overflow-hidden rounded-lg border border-[var(--border)] px-5 py-4">
        <div className="relative z-10 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[11px] font-medium text-[var(--foreground-muted)]">
              <Sparkles size={13} strokeWidth={1.75} />
              {nextAction.eyebrow}
            </div>
            <h2 className="mt-1.5 text-[18px] font-semibold tracking-tight text-[var(--foreground)]">
              {nextAction.title}
            </h2>
            <p className="mt-1 max-w-2xl text-[13px] leading-5 text-[var(--foreground-soft)]">
              {nextAction.description}
            </p>
          </div>
          <button
            type="button"
            onClick={nextAction.run}
            className="flex shrink-0 items-center justify-center gap-1.5 rounded-md bg-[var(--foreground)] px-3 py-2 text-[12.5px] font-medium text-white transition-colors duration-[var(--dur-quick)] hover:bg-[var(--foreground-soft)]"
          >
            {nextAction.label}
            <ArrowRight size={13} />
          </button>
        </div>
      </section>

      <section className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)]">
        <header className="flex items-end justify-between gap-4 border-b border-[var(--border)] px-4 py-3">
          <div>
            <h2 className="text-[14px] font-semibold text-[var(--foreground)]">个人事实</h2>
            <p className="mt-0.5 text-[12px] text-[var(--foreground-muted)]">
              先维护事实，再决定它们如何进入简历和网申。
            </p>
          </div>
          <div className="hidden items-center gap-1.5 text-[11px] text-[var(--foreground-muted)] sm:flex">
            <BadgeCheck size={13} strokeWidth={1.75} />
            {props.metrics.missingFieldCount > 0
              ? `${props.metrics.missingFieldCount} 个模块待补`
              : "基础字段已齐"}
          </div>
        </header>

        <div className="divide-y divide-[var(--border)]">
          {groups.map((group) => {
            const Icon = group.icon;
            const active =
              selection?.kind === "profile-fact" && String(selection.id) === group.id;
            return (
              <button
                key={group.id}
                type="button"
                onClick={() => selectGroup(group)}
                className={`relative flex w-full items-center gap-3 px-4 py-3 text-left transition-colors duration-[var(--dur-quick)] ${
                  active ? "bg-[var(--surface-muted)]" : "hover:bg-[var(--surface-muted)]"
                }`}
              >
                {active && (
                  <motion.span
                    layoutId="profile-fact-active"
                    className="absolute inset-y-2 left-0 w-[2px] rounded-full bg-[var(--accent-clay)]"
                    transition={{ type: "spring", stiffness: 360, damping: 38, mass: 0.75 }}
                  />
                )}
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[var(--surface-muted)] text-[var(--foreground-soft)]">
                  <Icon size={15} strokeWidth={1.75} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="text-[13.5px] font-medium text-[var(--foreground)]">
                      {group.title}
                    </span>
                    <span
                      className={`text-[11px] ${
                        group.complete
                          ? "text-[var(--primary-green)]"
                          : "text-[var(--primary-yellow)]"
                      }`}
                    >
                      {group.status}
                    </span>
                  </span>
                  <span className="mt-0.5 block truncate text-[12px] text-[var(--foreground-muted)]">
                    {group.summary}
                  </span>
                </span>
                <span className="hidden shrink-0 text-[11.5px] text-[var(--foreground-faint)] md:block">
                  {group.meta}
                </span>
                <ArrowRight
                  size={13}
                  className="shrink-0 text-[var(--foreground-faint)]"
                />
              </button>
            );
          })}
        </div>
      </section>

      <p className="px-1 text-[11.5px] leading-5 text-[var(--foreground-faint)]">
        简历输出负责表达取舍，网申输出负责补充字段；两者仍沿用现有同步与覆写规则。
      </p>
    </div>
  );
}
