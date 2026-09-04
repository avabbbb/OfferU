"use client";

import { forwardRef, memo, useMemo } from "react";
import { ResumeSwissSingle } from "./templates/ResumeSwissSingle";
import { ResumeSwissTwoColumn } from "./templates/ResumeSwissTwoColumn";
import { ResumeModernSingle } from "./templates/ResumeModernSingle";
import { ResumeModernTwoColumn } from "./templates/ResumeModernTwoColumn";
import { ResumeReference } from "./templates/ResumeReference";
import {
  normalizeTemplateSettings,
  settingsToCssVars,
  type NormalizedResumeData,
  type NormalizedResumeItem,
  type NormalizedResumeSection,
} from "./templates/templateSettings";
import { dateRange, textFromHtml } from "./templates/shared";
import { visibleBullets } from "@/lib/resumeText";
import { resolveApiBase } from "@/lib/apiBase";

interface Section {
  id: number;
  section_type: string;
  title: string;
  visible: boolean;
  content_json: any[];
  sort_order: number;
}

interface ResumePreviewProps {
  userName: string;
  title?: string;
  photoUrl: string;
  summary: string;
  contactJson: Record<string, string>;
  sections: Section[];
  styleConfig: Record<string, string>;
  highlightKeywords?: string[];
}

function normalizeSkillEntry(item: any, index: number): NormalizedResumeItem {
  const isCertificate =
    item?._entryType === "certificate" || item?.name || item?.issuer || item?.scoreOrLevel || item?.date;
  if (isCertificate) {
    return {
      id: `skill-cert-${index}`,
      title: item.name || `Certificate ${index + 1}`,
      subtitle: [item.scoreOrLevel, item.issuer].filter(Boolean).join(" / "),
      date: item.date || "",
      url: item.url || "",
      bullets: [],
    };
  }
  const PROFICIENCY_RE = /^(熟悉|精通|了解|掌握|熟练|一般|入门|高级|中级|初级|专家|资深|进阶|基础|专业|应用)/;
  const rawTags = Array.isArray(item.items)
    ? item.items.map((value: unknown) => String(value)).filter(Boolean)
    : String(item.items || "")
        .split(/[,，、]/)
        .map((value) => value.trim())
        .filter(Boolean);
  const category = item.category || "";
  const displayTags = PROFICIENCY_RE.test(category) && rawTags.length > 0
    ? rawTags.map((t: string) => `${category} ${t}`)
    : rawTags;
  return {
    id: `skill-${index}`,
    title: PROFICIENCY_RE.test(category) && rawTags.length > 0 ? "" : category || `Skill Group ${index + 1}`,
    tags: displayTags,
    bullets: [],
  };
}

function normalizeSectionItem(sectionType: string, item: any, index: number): NormalizedResumeItem {
  if (sectionType === "education") {
    return {
      id: `education-${index}`,
      title: item.school || `Education ${index + 1}`,
      subtitle: [item.degree, item.major, item.gpa ? `GPA ${item.gpa}` : ""].filter(Boolean).join(" / "),
      date: dateRange(item.startDate, item.endDate),
      descriptionHtml: item.description || "",
      bullets: visibleBullets(item.description || "", item.hidden_bullet_indexes),
    };
  }
  if (sectionType === "experience" || sectionType === "workExperiences") {
    return {
      id: `experience-${index}`,
      title: item.position || item.company || `Experience ${index + 1}`,
      organization: item.company || "",
      location: item.location || "",
      date: dateRange(item.startDate, item.endDate),
      descriptionHtml: item.description || "",
      bullets: visibleBullets(item.description || "", item.hidden_bullet_indexes),
    };
  }
  if (sectionType === "internshipExperiences") {
    return {
      id: `internship-${index}`,
      title: item.position || item.company || `Internship ${index + 1}`,
      organization: item.company || "",
      location: item.location || "",
      date: dateRange(item.startDate, item.endDate),
      descriptionHtml: item.description || "",
      bullets: visibleBullets(item.description || "", item.hidden_bullet_indexes),
    };
  }
  if (sectionType === "project" || sectionType === "projects") {
    return {
      id: `project-${index}`,
      title: item.name || `Project ${index + 1}`,
      subtitle: item.role || "",
      date: dateRange(item.startDate, item.endDate),
      url: item.url || "",
      descriptionHtml: item.description || "",
      bullets: visibleBullets(item.description || "", item.hidden_bullet_indexes),
    };
  }
  if (sectionType === "skill" || sectionType === "skills") {
    return normalizeSkillEntry(item, index);
  }
  if (sectionType === "certificate" || sectionType === "certificates") {
    return {
      id: `certificate-${index}`,
      title: item.name || `Certificate ${index + 1}`,
      subtitle: [item.scoreOrLevel, item.issuer].filter(Boolean).join(" / "),
      date: item.date || "",
      url: item.url || "",
      bullets: [],
    };
  }
  if (sectionType === "awards") {
    return {
      id: `award-${index}`,
      title: item.awardName || item.name || `Award ${index + 1}`,
      subtitle: item.issuer || "",
      date: item.awardedAt || item.date || "",
      descriptionHtml: item.description || "",
      bullets: visibleBullets(item.description || "", item.hidden_bullet_indexes),
    };
  }
  if (sectionType === "personalExperiences" || sectionType === "custom") {
    return {
      id: `personal-${index}`,
      title: item.experienceTitle || item.subtitle || item.title || `Experience ${index + 1}`,
      date: dateRange(item.startDate, item.endDate),
      descriptionHtml: item.description || "",
      bullets: visibleBullets(item.description || "", item.hidden_bullet_indexes),
    };
  }
  return {
    id: `${sectionType}-${index}`,
    title: item.subtitle || item.title || `Item ${index + 1}`,
    subtitle: item.organization || "",
    date: dateRange(item.startDate, item.endDate),
    url: item.url || "",
    descriptionHtml: item.description || item.content || "",
    bullets: visibleBullets(item.description || item.content || "", item.hidden_bullet_indexes),
  };
}

function resolveAssetUrl(url?: string) {
  if (!url) return "";
  return url.startsWith("/")
    ? `${resolveApiBase()}${url}`
    : url;
}

function normalizeContactJson(contactJson: Record<string, string> = {}) {
  const contact = { ...contactJson };
  for (const key of ["schoolLogoUrl", "universityLogoUrl", "logoUrl", "school_logo_url"]) {
    if (contact[key]) {
      contact[key] = resolveAssetUrl(contact[key]);
    }
  }
  return contact;
}

function normalizeResumeData(props: ResumePreviewProps): NormalizedResumeData {
  const normalizedSections: NormalizedResumeSection[] = [...(props.sections || [])]
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))
    .map((section) => ({
      id: section.id,
      key: section.section_type,
      title: section.title || section.section_type,
      visible: section.visible !== false,
      sortOrder: section.sort_order || 0,
      items: (section.content_json || [])
        .map((item, index) => normalizeSectionItem(section.section_type, item, index))
        .filter((item) => item.title || item.bullets.length || item.tags?.length),
    }));

  return {
    userName: props.userName,
    title: props.title || props.contactJson?.headline || props.contactJson?.title || "",
    photoUrl: props.photoUrl,
    summary: textFromHtml(props.summary),
    summaryHtml: props.summary || "",
    contact: normalizeContactJson(props.contactJson || {}),
    sections: normalizedSections,
  };
}

const ResumePreview = forwardRef<HTMLDivElement, ResumePreviewProps>(function ResumePreview(props, ref) {
  const settings = useMemo(() => normalizeTemplateSettings(props.styleConfig), [props.styleConfig]);
  const cssVars = useMemo(() => settingsToCssVars(settings), [settings]);
  const data = useMemo(
    () => normalizeResumeData(props),
    [props.userName, props.title, props.photoUrl, props.summary, props.contactJson, props.sections, props.styleConfig],
  );
  const highlightKeywords = useMemo(() => props.highlightKeywords || [], [props.highlightKeywords]);

  const template = (() => {
    if (
      settings.template === "reference" ||
      settings.template === "reference-compact"
    ) {
      return <ResumeReference data={data} highlightKeywords={highlightKeywords} template={settings.template} />;
    }
    if (settings.template === "swiss-two-column") {
      return <ResumeSwissTwoColumn data={data} highlightKeywords={highlightKeywords} />;
    }
    if (settings.template === "modern") {
      return <ResumeModernSingle data={data} highlightKeywords={highlightKeywords} />;
    }
    if (settings.template === "modern-two-column") {
      return <ResumeModernTwoColumn data={data} highlightKeywords={highlightKeywords} />;
    }
    return <ResumeSwissSingle data={data} highlightKeywords={highlightKeywords} />;
  })();

  return (
    <div className="inline-block swiss-resume">
      <div
        ref={ref}
        className={`resume-body ${settings.template}`}
        data-template={settings.template}
        style={cssVars}
      >
        {template}
      </div>
    </div>
  );
});

export default memo(ResumePreview);
