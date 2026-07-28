"use client";

import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  AlertCircle,
  Briefcase,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FolderGit2,
  GraduationCap,
  Trash2,
  User,
  Users,
  Wrench,
} from "lucide-react";
import { Button, Card, CardBody, CardHeader, Chip, Tooltip } from "@nextui-org/react";
import type { ProfileData, ProfileSection } from "@/lib/hooks";
import { profileApi } from "@/lib/api";

type Topic = "education" | "internship" | "project" | "activity" | "skill";

interface ProfilePreviewProps {
  profile: ProfileData;
  currentTopic: Topic;
  onRefresh: () => void;
}

const TOPIC_ICONS: Record<string, React.ElementType> = {
  education: GraduationCap,
  internship: Briefcase,
  project: FolderGit2,
  activity: Users,
  skill: Wrench,
};

const TOPIC_ORDER = ["education", "internship", "project", "activity", "skill"];

const TOPIC_LABELS: Record<string, string> = {
  education: "教育",
  internship: "实习",
  project: "项目",
  activity: "活动",
  skill: "技能",
};

const SOURCE_LABELS: Record<
  string,
  { label: string; color: "primary" | "success" | "warning" }
> = {
  manual: { label: "手动", color: "primary" },
  ai_chat: { label: "AI 对话", color: "success" },
  ai_import: { label: "AI 导入", color: "warning" },
};

export function ProfilePreview({
  profile,
  currentTopic,
  onRefresh,
}: ProfilePreviewProps) {
  const baseInfo = profile.base_info_json || {};
  const [expandedTopics, setExpandedTopics] = useState<Set<string>>(
    new Set([currentTopic])
  );

  const grouped = useMemo(() => {
    const map: Record<string, ProfileSection[]> = {};
    for (const topic of TOPIC_ORDER) map[topic] = [];
    for (const section of profile.sections ?? []) {
      if (!map[section.section_type]) map[section.section_type] = [];
      map[section.section_type].push(section);
    }
    return map;
  }, [profile.sections]);

  const toggleTopic = (topic: string) => {
    setExpandedTopics((prev) => {
      const next = new Set(prev);
      next.has(topic) ? next.delete(topic) : next.add(topic);
      return next;
    });
  };

  const handleDelete = async (sectionId: number) => {
    try {
      await profileApi.deleteSection(sectionId);
      onRefresh();
    } catch {
      // ignore
    }
  };

  const itemCount = (profile.sections ?? []).length;

  return (
    <Card className="h-full rounded-none border border-[var(--border)] bg-[var(--surface)] ">
      <CardHeader className="flex items-center gap-3 border-b border-[var(--border)] pb-3">
        <User size={20} className="text-[var(--primary-blue)]" />
        <div className="flex-1">
          <h3 className="text-lg font-semibold text-[var(--foreground)]">
            {profile.name || "未命名"}
          </h3>
          <p className="text-xs text-[var(--foreground-muted)]">
            {String(baseInfo.school || "")}
            {baseInfo.school && baseInfo.major ? " · " : ""}
            {String(baseInfo.major || "")}
            {baseInfo.gpa ? ` · GPA ${String(baseInfo.gpa)}` : ""}
          </p>
        </div>
        <Chip
          size="sm"
          variant="flat"
          color="default"
          className="border border-[var(--border)] bg-[var(--surface-muted)] text-[10px] text-[var(--foreground)]"
        >
          {itemCount} 条
        </Chip>
      </CardHeader>

      <CardBody className="overflow-auto p-0">
        {profile.headline && (
          <div className="border-b border-[var(--border)] px-4 py-3">
            <p className="text-sm italic text-[var(--foreground-muted)]">“{profile.headline}”</p>
          </div>
        )}

        {TOPIC_ORDER.map((topic) => {
          const Icon = TOPIC_ICONS[topic] || Wrench;
          const sections = grouped[topic] || [];
          const isExpanded = expandedTopics.has(topic);
          const isActive = topic === currentTopic;

          return (
            <div
              key={topic}
              className={`border-b border-[var(--border)] ${isActive ? "bg-[var(--surface-muted)]/60" : ""}`}
            >
              <button
                type="button"
                onClick={() => toggleTopic(topic)}
                className="flex w-full items-center gap-2 px-4 py-3 text-left transition-colors hover:bg-[var(--surface-muted)]/70"
              >
                <Icon size={16} className={isActive ? "text-[var(--primary-blue)]" : "text-[var(--foreground-muted)]"} />
                <span
                  className={`flex-1 text-sm ${
                    isActive ? "font-semibold text-[var(--foreground)]" : "font-medium text-[var(--foreground-soft)]"
                  }`}
                >
                  {TOPIC_LABELS[topic] || topic}
                </span>
                <span className="text-xs text-[var(--foreground-muted)]">{sections.length} 条</span>
                {isExpanded ? (
                  <ChevronDown size={14} className="text-[var(--foreground-muted)]" />
                ) : (
                  <ChevronRight size={14} className="text-[var(--foreground-muted)]" />
                )}
              </button>

              <AnimatePresence>
                {isExpanded && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ type: "spring", stiffness: 320, damping: 34 }}
                    className="overflow-hidden"
                  >
                    {sections.length === 0 ? (
                      <p className="px-6 py-2 text-xs text-[var(--foreground-muted)]">暂无条目，请在右侧引导中添加。</p>
                    ) : (
                      sections.map((section) => (
                        <BulletItem
                          key={section.id}
                          section={section}
                          onDelete={() => handleDelete(section.id)}
                        />
                      ))
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        })}
      </CardBody>
    </Card>
  );
}

function BulletItem({
  section,
  onDelete,
}: {
  section: ProfileSection;
  onDelete: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const src = SOURCE_LABELS[section.source] || SOURCE_LABELS.manual;
  const content = (section.content_json || {}) as Record<string, any>;
  const norm = (content.normalized || {}) as Record<string, any>;
  const fieldValues = (content.field_values || {}) as Record<string, any>;

  const organization = String(
    norm.company ||
      norm.school ||
      norm.issuer ||
      content.organization ||
      content.company ||
      content.school ||
      ""
  ).trim();

  const dateRange = String(
    content.date_range ||
      [norm.start_date || content.startDate || content.start_date, norm.end_date || content.endDate || content.end_date]
        .filter(Boolean)
        .join(" - ")
  ).trim();

  const richDesc = (() => {
    const description = String(norm.description || "").trim();
    if (description) return description;

    for (const key of Object.keys(fieldValues)) {
      if (key.endsWith(".description") && fieldValues[key]) {
        return String(fieldValues[key]).trim();
      }
    }

    if (norm.items && Array.isArray(norm.items)) {
      return norm.items.join("、");
    }

    return "";
  })();

  const description = richDesc || String(content.bullet || "").trim() || section.title || "";
  const isConfirmed = Number(section.confidence || 0) >= 0.8;

  return (
    <motion.div
      initial={{ opacity: 0, x: -10 }}
      animate={{ opacity: 1, x: 0 }}
      className="group border-t border-[var(--border)] px-6 py-2 transition-colors hover:bg-[var(--surface-muted)]/60"
    >
      <div className="flex items-start gap-2">
        {isConfirmed ? (
          <CheckCircle2 size={14} className="mt-0.5 flex-shrink-0 text-emerald-600" />
        ) : (
          <Tooltip content={`置信度 ${Math.round(Number(section.confidence || 0) * 100)}%`}>
            <AlertCircle
              size={14}
              className={`mt-0.5 flex-shrink-0 ${
                Number(section.confidence || 0) > 0.7
                  ? "text-amber-600"
                  : "text-orange-500"
              }`}
            />
          </Tooltip>
        )}

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setExpanded((prev) => !prev)}
              className="truncate text-left text-sm font-medium text-[var(--foreground-soft)] hover:text-[var(--foreground)]"
            >
              {section.title || "未命名条目"}
            </button>
            <Chip size="sm" variant="flat" color={src.color} className="h-4 text-[10px]">
              {src.label}
            </Chip>
          </div>

          {(organization || dateRange) && (
            <p className="mt-0.5 text-xs text-[var(--foreground-muted)]">
              {organization}
              {organization && dateRange ? " · " : ""}
              {dateRange}
            </p>
          )}

          <AnimatePresence>
            {expanded && description && (
              <motion.p
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                className="mt-1 overflow-hidden text-xs text-[var(--foreground-muted)]"
              >
                {description}
              </motion.p>
            )}
          </AnimatePresence>
        </div>

        <div className="flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          <Tooltip content="删除">
            <Button
              isIconOnly
              size="sm"
              variant="light"
              onPress={onDelete}
              className="h-6 min-w-6 text-[var(--foreground-muted)] hover:bg-[var(--status-blush)] hover:text-[var(--primary-red)]"
            >
              <Trash2 size={12} />
            </Button>
          </Tooltip>
        </div>
      </div>
    </motion.div>
  );
}
