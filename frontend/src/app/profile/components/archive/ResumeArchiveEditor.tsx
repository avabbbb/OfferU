"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Button, Card, CardBody, Input, Textarea } from "@nextui-org/react";
import { ArrowDown, ArrowUp, ChevronDown, ChevronUp, Plus, Save, Trash2 } from "lucide-react";
import RichTextEditor from "@/app/resume/components/RichTextEditor";
import {
  type ResumeArchive,
  type ResumeAwardItem,
  type ResumeCertificateItem,
  type ResumeEducationItem,
  type ResumeInternshipItem,
  type ResumePersonalExperienceItem,
  type ResumeProjectItem,
  type ResumeSkillItem,
  type ResumeWorkItem,
  personalArchiveFactories,
} from "@/lib/personalArchive";

interface ResumeArchiveEditorProps {
  value: ResumeArchive;
  focusSection?: string;
  missingSections?: string[];
  saving?: boolean;
  onChange: (next: ResumeArchive, changedPaths: string[]) => void;
  onSaveItem?: () => void | Promise<void>;
}

function cloneResume(value: ResumeArchive): ResumeArchive {
  return JSON.parse(JSON.stringify(value)) as ResumeArchive;
}

function normalizeFocusSectionKey(focusSection: string | undefined): string | undefined {
  if (!focusSection) return undefined;
  if (focusSection.startsWith("basicInfo")) return "basicInfo";
  return focusSection;
}

function isInvalidRequired(enabled: boolean, value: string): boolean {
  return enabled && !value.trim();
}

function useSectionState(focusSection: string | undefined) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const focusKey = normalizeFocusSectionKey(focusSection);

  useEffect(() => {
    if (!focusKey) return;
    setCollapsed((prev) => ({ ...prev, [focusKey]: false }));
  }, [focusKey]);

  return {
    isCollapsed: (key: string) => Boolean(collsapsedOrDefault(collapsed[key])),
    toggle: (key: string) =>
      setCollapsed((prev) => ({
        ...prev,
        [key]: !collsapsedOrDefault(prev[key]),
      })),
    expand: (key: string) =>
      setCollapsed((prev) => ({
        ...prev,
        [key]: false,
      })),
  };
}

function collsapsedOrDefault(value: boolean | undefined): boolean {
  return value ?? false;
}


function DescriptionArrayEditor(props: {
  label: string;
  values: string[];
  onChange: (next: string[]) => void;
}) {
  const values = props.values.length > 0 ? props.values : [""];

  return (
    <div className="space-y-2">
      <div className="text-xs font-semibold text-[var(--foreground-muted)]">{props.label}</div>
      {values.map((item, index) => (
        <div key={`${props.label}-${index}`} className="flex items-center gap-2">
          <Textarea
            value={item}
            minRows={2}
            variant="bordered"
            className="flex-1"
            classNames={{
              inputWrapper: "border border-[var(--border-strong)]/15 bg-[var(--surface)] shadow-[1px_1px_0_0_rgba(18,18,18,0.08)]",
            }}
            onValueChange={(nextValue) => {
              const next = values.slice();
              next[index] = nextValue;
              props.onChange(next);
            }}
          />
          <div className="flex shrink-0 items-center gap-1 self-center">
            <Button
              size="sm"
              isIconOnly
              aria-label="新增描述"
              className="bauhaus-button bauhaus-button-outline !h-8 !min-w-8 !w-8 !px-0 !py-0"
              onPress={() => {
                const next = values.slice();
                next.splice(index + 1, 0, "");
                props.onChange(next);
              }}
            >
              <Plus size={14} />
            </Button>
            <Button
              size="sm"
              isIconOnly
              aria-label="上移描述"
              className="bauhaus-button bauhaus-button-outline !h-8 !min-w-8 !w-8 !px-0 !py-0"
              isDisabled={index === 0}
              onPress={() => {
                if (index === 0) return;
                const next = values.slice();
                const current = next[index];
                next[index] = next[index - 1];
                next[index - 1] = current;
                props.onChange(next);
              }}
            >
              <ArrowUp size={14} />
            </Button>
            <Button
              size="sm"
              isIconOnly
              aria-label="下移描述"
              className="bauhaus-button bauhaus-button-outline !h-8 !min-w-8 !w-8 !px-0 !py-0"
              isDisabled={index >= values.length - 1}
              onPress={() => {
                if (index >= values.length - 1) return;
                const next = values.slice();
                const current = next[index];
                next[index] = next[index + 1];
                next[index + 1] = current;
                props.onChange(next);
              }}
            >
              <ArrowDown size={14} />
            </Button>
            <Button
              size="sm"
              isIconOnly
              aria-label="删除描述"
              className="bauhaus-button bauhaus-button-red !h-8 !min-w-8 !w-8 !px-0 !py-0"
              onPress={() => {
                if (values.length <= 1) {
                  props.onChange([""]);
                  return;
                }
                const next = values.slice();
                next.splice(index, 1);
                props.onChange(next);
              }}
            >
              <Trash2 size={14} />
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}

function SingleDescriptionEditor(props: {
  label: string;
  values: string[];
  onChange: (next: string[]) => void;
}) {
  const value = props.values.filter((item) => item.trim()).join("\n");

  return (
    <Textarea
      label={props.label}
      value={value}
      minRows={5}
      variant="bordered"
      classNames={{
        inputWrapper: "border border-[var(--border-strong)]/15 bg-[var(--surface)] shadow-[1px_1px_0_0_rgba(18,18,18,0.08)]",
      }}
      onValueChange={(nextValue) => {
        props.onChange([nextValue]);
      }}
    />
  );
}


function SectionFrame(props: {
  sectionKey: string;
  title: string;
  description: string;
  count?: number;
  focused?: boolean;
  missing?: boolean;
  collapsed: boolean;
  onToggleCollapse: () => void;
  children: ReactNode;
}) {
  const borderClass = props.missing
    ? "border-[var(--primary-red)] shadow-[0_0_0_1px_rgba(201,85,72,0.22)]"
    : props.focused
      ? "ring-2 ring-[color:color-mix(in_srgb,var(--auxiliary-blue)_45%,#ffffff_55%)]"
      : "";
  const titleClass = props.missing ? "text-[var(--primary-red)]" : "text-[var(--foreground)]";
  const descClass = props.missing ? "text-[color:color-mix(in_srgb,var(--primary-red)_80%,#3a2f2a_20%)]" : "text-[var(--foreground-muted)]";

  return (
    <Card className={`bauhaus-panel overflow-hidden bg-[var(--surface)] ${borderClass}`} data-section={props.sectionKey}>
      <CardBody className="space-y-4 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <div className={`text-lg font-semibold ${titleClass}`}>{props.title}</div>
            <div className={`text-sm ${descClass}`}>{props.description}</div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {typeof props.count === "number" && (
              <span className="bauhaus-chip bg-[var(--surface-muted)] text-[var(--foreground)]">{props.count} 条</span>
            )}
            {props.missing && (
              <span className="bauhaus-chip border-[var(--primary-red)] bg-[color:color-mix(in_srgb,var(--primary-red)_10%,#ffffff_90%)] text-[var(--primary-red)]">
                待补齐              </span>
            )}
            <Button
              size="sm"
              className="bauhaus-button bauhaus-button-outline !h-8 !px-3 !py-2 !text-[11px]"
              onPress={props.onToggleCollapse}
            >
              {props.collapsed ? "展开" : "折叠"}
            </Button>
          </div>
        </div>
        {!props.collapsed && props.children}
      </CardBody>
    </Card>
  );
}

function ItemShell(props: {
  title: string;
  fallbackTitle: string;
  onDelete: () => void;
  onSave?: () => void;
  saving?: boolean;
  children: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="bauhaus-panel-sm space-y-3 bg-[var(--surface)] p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1 text-base font-semibold text-[var(--foreground)]">
          <span className="line-clamp-2 break-words">{props.title || props.fallbackTitle}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            size="sm"
            startContent={<Save size={13} />}
            className="bauhaus-button bauhaus-button-blue !h-8 !px-3 !py-2 !text-[11px]"
            onPress={props.onSave}
            isLoading={props.saving}
            isDisabled={props.saving}
          >
            {props.saving ? "保存中..." : "保存"}
          </Button>
          <Button
            size="sm"
            className="bauhaus-button bauhaus-button-outline !h-8 !px-3 !py-2 !text-[11px]"
            onPress={() => setCollapsed((prev) => !prev)}
          >
            {collapsed ? (
              <span className="inline-flex items-center gap-1"><ChevronDown size={13} />展开</span>
            ) : (
              <span className="inline-flex items-center gap-1"><ChevronUp size={13} />折叠</span>
            )}
          </Button>
          <Button
            size="sm"
            startContent={<Trash2 size={14} />}
            className="bauhaus-button bauhaus-button-red !h-8 !px-3 !py-2 !text-[11px] text-white"
            onPress={props.onDelete}
          >
            删除
          </Button>
        </div>
      </div>
      {!collapsed && props.children}
    </div>
  );
}

function EducationItemEditor(props: {
  item: ResumeEducationItem;
  missing: boolean;
  onChange: (next: ResumeEducationItem) => void;
  onDelete: () => void;
  onSave?: () => void;
  saving?: boolean;
}) {
  const { item } = props;
  return (
    <ItemShell title={item.schoolName} fallbackTitle="未命名教育经历" onDelete={props.onDelete} onSave={props.onSave} saving={props.saving}>
      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
        <Input
          label="学校名称"
          value={item.schoolName}
          isInvalid={isInvalidRequired(props.missing, item.schoolName)}
          onValueChange={(v) => props.onChange({ ...item, schoolName: v })}
          variant="bordered"
        />
        <Input label="学历" value={item.educationLevel} onValueChange={(v) => props.onChange({ ...item, educationLevel: v })} variant="bordered" />
        <Input label="学位" value={item.degree} onValueChange={(v) => props.onChange({ ...item, degree: v })} variant="bordered" />
        <Input label="专业" value={item.major} onValueChange={(v) => props.onChange({ ...item, major: v })} variant="bordered" />
        <Input label="开始时间" value={item.startDate} onValueChange={(v) => props.onChange({ ...item, startDate: v })} variant="bordered" />
        <Input label="结束时间" value={item.endDate} onValueChange={(v) => props.onChange({ ...item, endDate: v })} variant="bordered" />
      </div>
      <Input label="GPA" value={item.gpa} onValueChange={(v) => props.onChange({ ...item, gpa: v })} variant="bordered" />
      <Textarea
        label="相关课程（逗号或换行分隔）"
        minRows={2}
        value={item.relatedCourses.join("\n")}
        onValueChange={(v) =>
          props.onChange({
            ...item,
            relatedCourses: v
              .split(/[,\n，、；;]/g)
              .map((x) => x.trim())
              .filter(Boolean),
          })
        }
        variant="bordered"
      />
      <div>
        <label className="mb-1 block text-xs font-semibold tracking-[0.06em] text-[var(--foreground-muted)]">描述</label>
        <RichTextEditor content={item.description} onChange={(v) => props.onChange({ ...item, description: v })} minHeight={80} placeholder="补充说明（可选）" />
      </div>
    </ItemShell>
  );
}

function WorkItemEditor(props: {
  item: ResumeWorkItem;
  missing: boolean;
  onChange: (next: ResumeWorkItem) => void;
  onDelete: () => void;
  onSave?: () => void;
  saving?: boolean;
}) {
  const { item } = props;
  return (
    <ItemShell title={item.companyName} fallbackTitle="未命名工作经历" onDelete={props.onDelete} onSave={props.onSave} saving={props.saving}>
      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
        <Input
          label="公司名称"
          value={item.companyName}
          isInvalid={isInvalidRequired(props.missing, item.companyName)}
          onValueChange={(v) => props.onChange({ ...item, companyName: v })}
          variant="bordered"
        />
        <Input label="部门" value={item.department} onValueChange={(v) => props.onChange({ ...item, department: v })} variant="bordered" />
        <Input label="职位名称" value={item.positionName} onValueChange={(v) => props.onChange({ ...item, positionName: v })} variant="bordered" />
        <Input label="开始时间" value={item.startDate} onValueChange={(v) => props.onChange({ ...item, startDate: v })} variant="bordered" />
        <Input label="结束时间" value={item.endDate} onValueChange={(v) => props.onChange({ ...item, endDate: v })} variant="bordered" />
      </div>
      <div>
        <label className="mb-1 block text-xs font-semibold tracking-[0.06em] text-[var(--foreground-muted)]">工作描述</label>
        <RichTextEditor content={item.description} onChange={(v) => props.onChange({ ...item, description: v })} placeholder="描述你的工作职责和成果..." />
      </div>
    </ItemShell>
  );
}

function InternshipItemEditor(props: {
  item: ResumeInternshipItem;
  missing: boolean;
  onChange: (next: ResumeInternshipItem) => void;
  onDelete: () => void;
  onSave?: () => void;
  saving?: boolean;
}) {
  const { item } = props;
  return (
    <ItemShell title={item.companyName} fallbackTitle="未命名实习经历" onDelete={props.onDelete} onSave={props.onSave} saving={props.saving}>
      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
        <Input
          label="公司名称"
          value={item.companyName}
          isInvalid={isInvalidRequired(props.missing, item.companyName)}
          onValueChange={(v) => props.onChange({ ...item, companyName: v })}
          variant="bordered"
        />
        <Input label="职位名称" value={item.positionName} onValueChange={(v) => props.onChange({ ...item, positionName: v })} variant="bordered" />
        <Input label="开始时间" value={item.startDate} onValueChange={(v) => props.onChange({ ...item, startDate: v })} variant="bordered" />
        <Input label="结束时间" value={item.endDate} onValueChange={(v) => props.onChange({ ...item, endDate: v })} variant="bordered" />
      </div>
      <div>
        <label className="mb-1 block text-xs font-semibold tracking-[0.06em] text-[var(--foreground-muted)]">实习描述</label>
        <RichTextEditor content={item.description} onChange={(v) => props.onChange({ ...item, description: v })} placeholder="描述实习职责和成果..." />
      </div>
    </ItemShell>
  );
}

function ProjectItemEditor(props: {
  item: ResumeProjectItem;
  missing: boolean;
  onChange: (next: ResumeProjectItem) => void;
  onDelete: () => void;
  onSave?: () => void;
  saving?: boolean;
}) {
  const { item } = props;
  return (
    <ItemShell title={item.projectName} fallbackTitle="未命名项目经历" onDelete={props.onDelete} onSave={props.onSave} saving={props.saving}>
      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
        <Input
          label="项目名称"
          value={item.projectName}
          isInvalid={isInvalidRequired(props.missing, item.projectName)}
          onValueChange={(v) => props.onChange({ ...item, projectName: v })}
          variant="bordered"
        />
        <Input label="项目角色" value={item.projectRole} onValueChange={(v) => props.onChange({ ...item, projectRole: v })} variant="bordered" />
        <Input label="项目链接" value={item.projectLink} onValueChange={(v) => props.onChange({ ...item, projectLink: v })} variant="bordered" />
        <Input label="开始时间" value={item.startDate} onValueChange={(v) => props.onChange({ ...item, startDate: v })} variant="bordered" />
        <Input label="结束时间" value={item.endDate} onValueChange={(v) => props.onChange({ ...item, endDate: v })} variant="bordered" />
      </div>
      <div>
        <label className="mb-1 block text-xs font-semibold tracking-[0.06em] text-[var(--foreground-muted)]">项目描述</label>
        <RichTextEditor content={item.description} onChange={(v) => props.onChange({ ...item, description: v })} placeholder="描述项目亮点和你的贡献..." />
      </div>
    </ItemShell>
  );
}

function SkillItemEditor(props: {
  item: ResumeSkillItem;
  missing: boolean;
  onChange: (next: ResumeSkillItem) => void;
  onDelete: () => void;
  onSave?: () => void;
  saving?: boolean;
}) {
  const { item } = props;
  return (
    <ItemShell title={item.skillName} fallbackTitle="未命名技能条目" onDelete={props.onDelete} onSave={props.onSave} saving={props.saving}>
      <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
        <Input
          label="技能名称" value={item.skillName}
          isInvalid={isInvalidRequired(props.missing, item.skillName)}
          onValueChange={(v) => props.onChange({ ...item, skillName: v })}
          variant="bordered"
        />
        <Input label="熟练度" value={item.proficiency} onValueChange={(v) => props.onChange({ ...item, proficiency: v })} variant="bordered" />
        <Input label="备注" value={item.remark} onValueChange={(v) => props.onChange({ ...item, remark: v })} variant="bordered" />
      </div>
    </ItemShell>
  );
}

function CertificateItemEditor(props: {
  item: ResumeCertificateItem;
  missing: boolean;
  onChange: (next: ResumeCertificateItem) => void;
  onDelete: () => void;
  onSave?: () => void;
  saving?: boolean;
}) {
  const { item } = props;
  return (
    <ItemShell title={item.certificateName} fallbackTitle="未命名证书" onDelete={props.onDelete} onSave={props.onSave} saving={props.saving}>
      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
        <Input
          label="证书名称"
          value={item.certificateName}
          isInvalid={isInvalidRequired(props.missing, item.certificateName)}
          onValueChange={(v) => props.onChange({ ...item, certificateName: v })}
          variant="bordered"
        />
        <Input label="等级/分数" value={item.scoreOrLevel} onValueChange={(v) => props.onChange({ ...item, scoreOrLevel: v })} variant="bordered" />
        <Input label="获得时间" value={item.acquiredAt} onValueChange={(v) => props.onChange({ ...item, acquiredAt: v })} variant="bordered" />
        <Input label="颁发机构" value={item.issuer} onValueChange={(v) => props.onChange({ ...item, issuer: v })} variant="bordered" />
      </div>
    </ItemShell>
  );
}

function AwardItemEditor(props: {
  item: ResumeAwardItem;
  missing: boolean;
  onChange: (next: ResumeAwardItem) => void;
  onDelete: () => void;
  onSave?: () => void;
  saving?: boolean;
}) {
  const { item } = props;
  return (
    <ItemShell title={item.awardName} fallbackTitle="未命名获奖经历" onDelete={props.onDelete} onSave={props.onSave} saving={props.saving}>
      <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
        <Input
          label="奖项名称"
          value={item.awardName}
          isInvalid={isInvalidRequired(props.missing, item.awardName)}
          onValueChange={(v) => props.onChange({ ...item, awardName: v })}
          variant="bordered"
        />
        <Input label="颁发机构" value={item.issuer} onValueChange={(v) => props.onChange({ ...item, issuer: v })} variant="bordered" />
        <Input label="获奖时间" value={item.awardedAt} onValueChange={(v) => props.onChange({ ...item, awardedAt: v })} variant="bordered" />
      </div>
      <div>
        <label className="mb-1 block text-xs font-semibold tracking-[0.06em] text-[var(--foreground-muted)]">获奖描述</label>
        <RichTextEditor content={item.description} onChange={(v) => props.onChange({ ...item, description: v })} placeholder="补充奖项背景与成果..." />
      </div>
    </ItemShell>
  );
}

function PersonalExperienceItemEditor(props: {
  item: ResumePersonalExperienceItem;
  missing: boolean;
  onChange: (next: ResumePersonalExperienceItem) => void;
  onDelete: () => void;
  onSave?: () => void;
  saving?: boolean;
}) {
  const { item } = props;
  return (
    <ItemShell title={item.experienceTitle} fallbackTitle="未命名个人经历" onDelete={props.onDelete} onSave={props.onSave} saving={props.saving}>
      <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
        <Input
          label="经历标题"
          value={item.experienceTitle}
          isInvalid={isInvalidRequired(props.missing, item.experienceTitle)}
          onValueChange={(v) => props.onChange({ ...item, experienceTitle: v })}
          variant="bordered"
        />
        <Input label="开始时间" value={item.startDate} onValueChange={(v) => props.onChange({ ...item, startDate: v })} variant="bordered" />
        <Input label="结束时间" value={item.endDate} onValueChange={(v) => props.onChange({ ...item, endDate: v })} variant="bordered" />
      </div>
      <div>
        <label className="mb-1 block text-xs font-semibold tracking-[0.06em] text-[var(--foreground-muted)]">经历描述</label>
        <RichTextEditor content={item.description} onChange={(v) => props.onChange({ ...item, description: v })} placeholder="输入个人经历内容..." />
      </div>
    </ItemShell>
  );
}

function ListSection(props: {
  sectionKey: string;
  title: string;
  description: string;
  count: number;
  focused?: boolean;
  missing?: boolean;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onAdd: () => void;
  children: ReactNode;
}) {
  return (
    <SectionFrame
      sectionKey={props.sectionKey}
      title={props.title}
      description={props.description}
      count={props.count}
      focused={props.focused}
      missing={props.missing}
      collapsed={props.collapsed}
      onToggleCollapse={props.onToggleCollapse}
    >
      <div className="space-y-3">{props.children}</div>
      <Button
        size="sm"
        startContent={<Plus size={14} />}
        className="bauhaus-button bauhaus-button-outline !px-4 !py-2 !text-[11px]"
        onPress={props.onAdd}
      >
        新增条目
      </Button>
    </SectionFrame>
  );
}

export default function ResumeArchiveEditor(props: ResumeArchiveEditorProps) {
  const { value } = props;
  const sectionState = useSectionState(props.focusSection);
  const missingSet = useMemo(() => new Set(props.missingSections || []), [props.missingSections]);

  const commit = (mutator: (draft: ResumeArchive) => void, changedPaths: string[]) => {
    const next = cloneResume(value);
    mutator(next);
    props.onChange(next, changedPaths);
  };

  const saveItem = () => {
    if (props.saving) return;
    void props.onSaveItem?.();
  };

  return (
    <div className="space-y-5">
      <SectionFrame
        sectionKey="basicInfo"
        title="基础信息"
        description="用于简历展示的核心信息。" focused={normalizeFocusSectionKey(props.focusSection) === "basicInfo"}
        missing={missingSet.has("basicInfo")}
        collapsed={sectionState.isCollapsed("basicInfo")}
        onToggleCollapse={() => sectionState.toggle("basicInfo")}
      >
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
          <Input
            label="姓名"
            value={value.basicInfo.name}
            isInvalid={isInvalidRequired(missingSet.has("basicInfo"), value.basicInfo.name)}
            onValueChange={(v) => commit((draft) => { draft.basicInfo.name = v; }, ["basicInfo.name"])}
            variant="bordered"
          />
          <Input label="手机号" value={value.basicInfo.phone} onValueChange={(v) => commit((draft) => { draft.basicInfo.phone = v; }, ["basicInfo.phone"])} variant="bordered" />
          <Input label="邮箱" value={value.basicInfo.email} onValueChange={(v) => commit((draft) => { draft.basicInfo.email = v; }, ["basicInfo.email"])} variant="bordered" />
          <Input label="当前城市" value={value.basicInfo.currentCity} onValueChange={(v) => commit((draft) => { draft.basicInfo.currentCity = v; }, ["basicInfo.currentCity"])} variant="bordered" />
          <Input label="求职意向" value={value.basicInfo.jobIntention} onValueChange={(v) => commit((draft) => { draft.basicInfo.jobIntention = v; }, ["basicInfo.jobIntention"])} variant="bordered" />
          <Input label="个人网站" value={value.basicInfo.website} onValueChange={(v) => commit((draft) => { draft.basicInfo.website = v; }, ["basicInfo.website"])} variant="bordered" />
          <Input label="GitHub" value={value.basicInfo.github} onValueChange={(v) => commit((draft) => { draft.basicInfo.github = v; }, ["basicInfo.github"])} variant="bordered" />
        </div>
      </SectionFrame>

      <SectionFrame
        sectionKey="personalSummary"
        title="个人简介" description="简历页和个人档案页使用同一字段" focused={normalizeFocusSectionKey(props.focusSection) === "personalSummary"}
        missing={missingSet.has("personalSummary")}
        collapsed={sectionState.isCollapsed("personalSummary")}
        onToggleCollapse={() => sectionState.toggle("personalSummary")}
      >
        <Textarea
          minRows={4}
          label="个人简介" value={value.personalSummary}
          isInvalid={isInvalidRequired(missingSet.has("personalSummary"), value.personalSummary)}
          variant="bordered"
          onValueChange={(v) => commit((draft) => { draft.personalSummary = v; }, ["personalSummary"])}
        />
      </SectionFrame>

      <ListSection
        sectionKey="education"
        title="教育经历"
        description="支持多条描述并保持顺序。" count={value.education.length}
        focused={normalizeFocusSectionKey(props.focusSection) === "education"}
        missing={missingSet.has("education")}
        collapsed={sectionState.isCollapsed("education")}
        onToggleCollapse={() => sectionState.toggle("education")}
        onAdd={() => commit((draft) => { draft.education.push(personalArchiveFactories.createEmptyEducation()); }, ["education"])}
      >
        {value.education.map((item, index) => (
          <EducationItemEditor
            key={item.id}
            item={item}
            missing={missingSet.has("education")}
            onSave={saveItem}
            saving={props.saving}
            onChange={(nextItem) => commit((draft) => { draft.education[index] = nextItem; }, ["education"])}
            onDelete={() => commit((draft) => { draft.education.splice(index, 1); }, ["education"])}
          />
        ))}
      </ListSection>

      <ListSection
        sectionKey="workExperiences"
        title="工作经历"
        description="一个工作经历对应一个完整描述框。" count={value.workExperiences.length}
        focused={normalizeFocusSectionKey(props.focusSection) === "workExperiences"}
        missing={missingSet.has("workExperiences")}
        collapsed={sectionState.isCollapsed("workExperiences")}
        onToggleCollapse={() => sectionState.toggle("workExperiences")}
        onAdd={() => commit((draft) => { draft.workExperiences.push(personalArchiveFactories.createEmptyWork()); }, ["workExperiences"])}
      >
        {value.workExperiences.map((item, index) => (
          <WorkItemEditor
            key={item.id}
            item={item}
            missing={missingSet.has("workExperiences")}
            onSave={saveItem}
            saving={props.saving}
            onChange={(nextItem) => commit((draft) => { draft.workExperiences[index] = nextItem; }, ["workExperiences"])}
            onDelete={() => commit((draft) => { draft.workExperiences.splice(index, 1); }, ["workExperiences"])}
          />
        ))}
      </ListSection>

      <ListSection
        sectionKey="internshipExperiences"
        title="实习经历"
        description="一个实习经历对应一个完整描述框。" count={value.internshipExperiences.length}
        focused={normalizeFocusSectionKey(props.focusSection) === "internshipExperiences"}
        missing={missingSet.has("internshipExperiences")}
        collapsed={sectionState.isCollapsed("internshipExperiences")}
        onToggleCollapse={() => sectionState.toggle("internshipExperiences")}
        onAdd={() => commit((draft) => { draft.internshipExperiences.push(personalArchiveFactories.createEmptyInternship()); }, ["internshipExperiences"])}
      >
        {value.internshipExperiences.map((item, index) => (
          <InternshipItemEditor
            key={item.id}
            item={item}
            missing={missingSet.has("internshipExperiences")}
            onSave={saveItem}
            saving={props.saving}
            onChange={(nextItem) => commit((draft) => { draft.internshipExperiences[index] = nextItem; }, ["internshipExperiences"])}
            onDelete={() => commit((draft) => { draft.internshipExperiences.splice(index, 1); }, ["internshipExperiences"])}
          />
        ))}
      </ListSection>

      <ListSection
        sectionKey="projects"
        title="项目经历"
        description="一个项目经历对应一个完整描述框。" count={value.projects.length}
        focused={normalizeFocusSectionKey(props.focusSection) === "projects"}
        missing={missingSet.has("projects")}
        collapsed={sectionState.isCollapsed("projects")}
        onToggleCollapse={() => sectionState.toggle("projects")}
        onAdd={() => commit((draft) => { draft.projects.push(personalArchiveFactories.createEmptyProject()); }, ["projects"])}
      >
        {value.projects.map((item, index) => (
          <ProjectItemEditor
            key={item.id}
            item={item}
            missing={missingSet.has("projects")}
            onSave={saveItem}
            saving={props.saving}
            onChange={(nextItem) => commit((draft) => { draft.projects[index] = nextItem; }, ["projects"])}
            onDelete={() => commit((draft) => { draft.projects.splice(index, 1); }, ["projects"])}
          />
        ))}
      </ListSection>

      <SectionFrame
        sectionKey="skills"
        title="技能与证书"
        description="技能条目与证书条目合并管理" count={value.skills.length + value.certificates.length}
        focused={normalizeFocusSectionKey(props.focusSection) === "skills" || normalizeFocusSectionKey(props.focusSection) === "certificates"}
        missing={missingSet.has("skills")}
        collapsed={sectionState.isCollapsed("skills")}
        onToggleCollapse={() => sectionState.toggle("skills")}
      >
        <div className="space-y-5">
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-sm font-semibold text-[var(--foreground)]">技能条目</div>
              <Button
                size="sm"
                startContent={<Plus size={14} />}
                className="bauhaus-button bauhaus-button-outline !px-3 !py-2 !text-[11px]"
                onPress={() => commit((draft) => { draft.skills.push(personalArchiveFactories.createEmptySkill()); }, ["skills"])}
              >
                新增技能              </Button>
            </div>
            {value.skills.map((item, index) => (
              <SkillItemEditor
                key={item.id}
                item={item}
                missing={missingSet.has("skills")}
                onSave={saveItem}
            saving={props.saving}
                onChange={(nextItem) => commit((draft) => { draft.skills[index] = nextItem; }, ["skills"])}
                onDelete={() => commit((draft) => { draft.skills.splice(index, 1); }, ["skills"])}
              />
            ))}
          </div>

          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-sm font-semibold text-[var(--foreground)]">证书条目</div>
              <Button
                size="sm"
                startContent={<Plus size={14} />}
                className="bauhaus-button bauhaus-button-outline !px-3 !py-2 !text-[11px]"
                onPress={() => commit((draft) => { draft.certificates.push(personalArchiveFactories.createEmptyCertificate()); }, ["certificates"])}
              >
                新增证书
              </Button>
            </div>
            {value.certificates.map((item, index) => (
              <CertificateItemEditor
                key={item.id}
                item={item}
                missing={missingSet.has("skills")}
                onSave={saveItem}
            saving={props.saving}
                onChange={(nextItem) => commit((draft) => { draft.certificates[index] = nextItem; }, ["certificates"])}
                onDelete={() => commit((draft) => { draft.certificates.splice(index, 1); }, ["certificates"])}
              />
            ))}
          </div>
        </div>
      </SectionFrame>

      <ListSection
        sectionKey="awards"
        title="获奖经历"
        description="支持多条描述。" count={value.awards.length}
        focused={normalizeFocusSectionKey(props.focusSection) === "awards"}
        missing={missingSet.has("awards")}
        collapsed={sectionState.isCollapsed("awards")}
        onToggleCollapse={() => sectionState.toggle("awards")}
        onAdd={() => commit((draft) => { draft.awards.push(personalArchiveFactories.createEmptyAward()); }, ["awards"])}
      >
        {value.awards.map((item, index) => (
          <AwardItemEditor
            key={item.id}
            item={item}
            missing={missingSet.has("awards")}
            onSave={saveItem}
            saving={props.saving}
            onChange={(nextItem) => commit((draft) => { draft.awards[index] = nextItem; }, ["awards"])}
            onDelete={() => commit((draft) => { draft.awards.splice(index, 1); }, ["awards"])}
          />
        ))}
      </ListSection>

      <ListSection
        sectionKey="personalExperiences"
        title="个人经历"
        description="用于记录其他经历，简历展示时位于最下方。" count={value.personalExperiences.length}
        focused={normalizeFocusSectionKey(props.focusSection) === "personalExperiences"}
        missing={missingSet.has("personalExperiences")}
        collapsed={sectionState.isCollapsed("personalExperiences")}
        onToggleCollapse={() => sectionState.toggle("personalExperiences")}
        onAdd={() => commit((draft) => { draft.personalExperiences.push(personalArchiveFactories.createEmptyPersonalExperience()); }, ["personalExperiences"])}
      >
        {value.personalExperiences.map((item, index) => (
          <PersonalExperienceItemEditor
            key={item.id}
            item={item}
            missing={missingSet.has("personalExperiences")}
            onSave={saveItem}
            saving={props.saving}
            onChange={(nextItem) => commit((draft) => { draft.personalExperiences[index] = nextItem; }, ["personalExperiences"])}
            onDelete={() => commit((draft) => { draft.personalExperiences.splice(index, 1); }, ["personalExperiences"])}
          />
        ))}
      </ListSection>
    </div>
  );
}


