// =============================================
// Resume ↔ Puck 双向迁移转换器
// =============================================
// 用途：把后端 ResumeDetail (sections + content_json) 与
//      Puck InitialData (扁平 content 数组) 互相转换。
// 后端 schema 不动；Puck 编辑器加载时实时迁移，onPublish 反迁移汇总保存。
//
// 详见 docs/RESUME_PUCK_MIGRATION_PLAN.md
// =============================================

import type {
  ResumeDetail,
  ResumeSectionBlock,
  DraftResult,
} from "@/lib/hooks";

// Puck content 单元（与 puck-demo 当前 props 形状对齐到真实后端 schema）
export type PuckComponentType =
  | "Header"
  | "Summary"
  | "ExperienceEntry"
  | "EducationItem"
  | "ProjectItem"
  | "SkillGroup"
  | "CertificateItem"
  | "AwardItem"
  | "CustomItem";

export interface PuckContentUnit {
  type: PuckComponentType;
  props: Record<string, any> & { id: string };
}

export interface PuckResumeData {
  root: Record<string, never>;
  content: PuckContentUnit[];
  zones?: Record<string, PuckContentUnit[]>;
}

// section_type → Puck component 名
const SECTION_TYPE_TO_COMPONENT: Record<string, PuckComponentType> = {
  education: "EducationItem",
  workExperiences: "ExperienceEntry",
  internshipExperiences: "ExperienceEntry",
  experience: "ExperienceEntry",
  projects: "ProjectItem",
  project: "ProjectItem",
  skills: "SkillGroup",
  skill: "SkillGroup",
  certificates: "CertificateItem",
  certificate: "CertificateItem",
  awards: "AwardItem",
  award: "AwardItem",
  personalExperiences: "CustomItem",
  custom: "CustomItem",
};

// 反向：Puck component → 后端 section_type（Header/Summary 不映射）
const COMPONENT_TO_SECTION_TYPE: Record<PuckComponentType, string | null> = {
  Header: null,
  Summary: null,
  ExperienceEntry: "workExperiences",
  EducationItem: "education",
  ProjectItem: "projects",
  SkillGroup: "skills",
  CertificateItem: "certificates",
  AwardItem: "awards",
  CustomItem: "personalExperiences",
};

interface MigrationContext {
  // 保留旧 section block 索引，便于反迁移时复用 id
  sectionIndexById: Map<string, ResumeSectionBlock>;
  // continuation：internshipExperiences 与 workExperiences 在 Puck 端共用同一 component，反迁移需要回写其原 section_type
  componentTypeToOriginal: Map<PuckComponentType, string>;
}

// 把单个 content_json 条目按 section_type 映射到 Puck props
function itemToProps(sectionType: string, item: any): Record<string, any> {
  switch (sectionType) {
    case "education":
      return {
        school: item.school ?? "",
        degree: item.degree ?? "",
        major: item.major ?? "",
        startDate: item.startDate ?? "",
        endDate: item.endDate ?? "",
        gpa: item.gpa ?? "",
        description: item.description ?? "",
      };
    case "workExperiences":
    case "internshipExperiences":
    case "experience":
      return {
        company: item.company ?? "",
        position: item.position ?? "",
        location: item.location ?? "",
        startDate: item.startDate ?? "",
        endDate: item.endDate ?? "",
        description: item.description ?? "",
      };
    case "projects":
    case "project":
      return {
        name: item.name ?? "",
        role: item.role ?? "",
        url: item.url ?? "",
        startDate: item.startDate ?? "",
        endDate: item.endDate ?? "",
        description: item.description ?? "",
      };
    case "skills":
    case "skill": {
      // skills 条目可能是 {category, items[]} 或变体（scoreOrLevel + issuer 形如证书条目）
      if (item.scoreOrLevel || item.issuer) {
        // 实际是塞进 skills 段的证书条目，当作 SkillGroup 兜底
        return {
          category: item.name ?? item.category ?? "",
          items: [item.scoreOrLevel, item.issuer, item.date].filter(Boolean).join(" · "),
        };
      }
      const rawItems = Array.isArray(item.items)
        ? item.items.map((v: unknown) => String(v)).filter(Boolean)
        : String(item.items ?? "")
            .split(/[\n,，、]/)
            .map((s: string) => s.trim())
            .filter(Boolean);
      return {
        category: item.category ?? "",
        items: rawItems.join("\n"),
      };
    }
    case "certificates":
    case "certificate":
      return {
        name: item.name ?? "",
        scoreOrLevel: item.scoreOrLevel ?? "",
        issuer: item.issuer ?? "",
        date: item.date ?? "",
        url: item.url ?? "",
        description: item.description ?? "",
      };
    case "awards":
    case "award":
      return {
        awardName: item.awardName ?? item.name ?? "",
        issuer: item.issuer ?? "",
        awardedAt: item.awardedAt ?? item.date ?? "",
        description: item.description ?? "",
      };
    case "personalExperiences":
    case "custom":
      return {
        experienceTitle: item.experienceTitle ?? item.subtitle ?? item.title ?? "",
        startDate: item.startDate ?? "",
        endDate: item.endDate ?? "",
        description: item.description ?? item.content ?? "",
      };
    default:
      return {
        title: item.subtitle ?? item.title ?? "",
        organization: item.organization ?? "",
        url: item.url ?? "",
        startDate: item.startDate ?? "",
        endDate: item.endDate ?? "",
        description: item.description ?? item.content ?? "",
      };
  }
}

export function migrateResumeToPuck(resume: ResumeDetail): PuckResumeData {
  const content: PuckContentUnit[] = [];

  // Header ← contact_json
  const c = resume.contact_json ?? {};
  content.push({
    type: "Header",
    props: {
      id: `resume-${resume.id}-header`,
      name: c.name ?? "",
      title: c.title ?? "",
      email: c.email ?? "",
      phone: c.phone ?? "",
      location: c.location ?? "",
      // 保留 photo/logo URL，供 Puck Header 组件呈现头像
      photoUrl: c.photoUrl ?? c.schoolLogoUrl ?? c.logoUrl ?? "",
    },
  });

  // Summary ← summary
  content.push({
    type: "Summary",
    props: { id: `resume-${resume.id}-summary`, text: resume.summary ?? "" },
  });

  // 按 sort_order 处理 sections
  const sortedSections = [...(resume.sections ?? [])].sort(
    (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)
  );
  for (const [sectionIndex, section] of sortedSections.entries()) {
    if (section.visible === false) continue;
    const componentType = SECTION_TYPE_TO_COMPONENT[section.section_type];
    if (!componentType) continue;
    for (const [itemIndex, item] of (section.content_json ?? []).entries()) {
      content.push({
        type: componentType,
        props: {
          id: `resume-${resume.id}-section-${section.id || sectionIndex}-${itemIndex}`,
          ...itemToProps(section.section_type, item),
        },
      });
    }
  }

  return { root: {}, content };
}

// 反向：Puck content → Resume update payload
// 复用 base.sections 的 id（同 section_type 保持 id 不变），新增 section 走 id=0 占位由后端生成
export interface ResumeUpdatePayload {
  summary: string;
  contact_json: Record<string, any>;
  style_config: Record<string, any>;
  sections: Array<{
    id: number;
    section_type: string;
    sort_order: number;
    title: string;
    visible: boolean;
    content_json: any[];
  }>;
}

export function unMigratePuckToResume(
  puck: PuckResumeData,
  base: ResumeDetail
): ResumeUpdatePayload {
  const sectionsByType = new Map<string, any[]>();
  let summary = "";
  const contact: Record<string, any> = { ...(base.contact_json ?? {}) };

  for (const unit of puck.content ?? []) {
    switch (unit.type) {
      case "Header": {
        const p = unit.props;
        contact.name = p.name ?? "";
        contact.title = p.title ?? "";
        contact.email = p.email ?? "";
        contact.phone = p.phone ?? "";
        contact.location = p.location ?? "";
        if (p.photoUrl) {
          contact.photoUrl = p.photoUrl;
        } else {
          delete contact.photoUrl;
        }
        break;
      }
      case "Summary":
        summary = String(unit.props.text ?? "");
        break;
      default: {
        const sectionType = COMPONENT_TO_SECTION_TYPE[unit.type];
        if (!sectionType) continue;
        const list = sectionsByType.get(sectionType) ?? [];
        list.push(propsToItem(sectionType, unit.props));
        sectionsByType.set(sectionType, list);
        break;
      }
    }
  }

  // 按 base.sections 顺序组装，追加未在 base 中出现的新 section_type
  const usedTypes = new Set<string>();
  const sections: ResumeUpdatePayload["sections"] = [];

  for (const baseSection of base.sections ?? []) {
    const items = sectionsByType.get(baseSection.section_type) ?? [];
    sections.push({
      id: baseSection.id,
      section_type: baseSection.section_type,
      sort_order: sections.length,
      title: baseSection.title,
      visible: true,
      content_json: items,
    });
    usedTypes.add(baseSection.section_type);
  }

  for (const [sectionType, items] of sectionsByType) {
    if (usedTypes.has(sectionType)) continue;
    sections.push({
      id: 0,
      section_type: sectionType,
      sort_order: sections.length,
      title: defaultSectionTitle(sectionType),
      visible: true,
      content_json: items,
    });
  }

  return {
    summary,
    contact_json: contact,
    style_config: base.style_config ?? {},
    sections,
  };
}

function defaultSectionTitle(sectionType: string): string {
  const map: Record<string, string> = {
    workExperiences: "工作经历",
    internshipExperiences: "实习经历",
    education: "教育经历",
    projects: "项目经历",
    skills: "技能",
    certificates: "证书",
    awards: "获奖经历",
    personalExperiences: "个人经历",
  };
  return map[sectionType] ?? "自定义";
}

// 把 M6 AI 生成初稿 (DraftResult) 转成 Puck content
// 保留传入的 headerUnit（当前 Header 组件，维护 photoUrl/name/title 等联系方式）
export function draftToPuckContent(
  draft: DraftResult,
  headerUnit?: PuckContentUnit
): PuckResumeData {
  const content: PuckContentUnit[] = [];
  if (headerUnit) content.push(headerUnit);
  content.push({
    type: "Summary",
    props: { id: "draft-summary", text: draft.summary ?? "" },
  });
  const sorted = [...(draft.sections ?? [])].sort(
    (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)
  );
  for (const [sectionIndex, section] of sorted.entries()) {
    if (section.visible === false) continue;
    const componentType = SECTION_TYPE_TO_COMPONENT[section.section_type];
    if (!componentType) continue;
    for (const [itemIndex, item] of (section.content_json ?? []).entries()) {
      content.push({
        type: componentType,
        props: {
          id: `draft-${section.section_type}-${sectionIndex}-${itemIndex}`,
          ...itemToProps(section.section_type, item),
        },
      });
    }
  }
  return { root: {}, content };
}

function propsToItem(sectionType: string, props: Record<string, any>): any {
  switch (sectionType) {
    case "education":
      return {
        school: props.school ?? "",
        degree: props.degree ?? "",
        major: props.major ?? "",
        startDate: props.startDate ?? "",
        endDate: props.endDate ?? "",
        gpa: props.gpa ?? "",
        description: props.description ?? "",
      };
    case "workExperiences":
    case "internshipExperiences":
      return {
        company: props.company ?? "",
        position: props.position ?? "",
        location: props.location ?? "",
        startDate: props.startDate ?? "",
        endDate: props.endDate ?? "",
        description: props.description ?? "",
      };
    case "projects":
      return {
        name: props.name ?? "",
        role: props.role ?? "",
        url: props.url ?? "",
        startDate: props.startDate ?? "",
        endDate: props.endDate ?? "",
        description: props.description ?? "",
      };
    case "skills":
      return {
        category: props.category ?? "",
        items: String(props.items ?? "")
          .split(/[\n,，、]/)
          .map((s) => s.trim())
          .filter(Boolean),
      };
    case "certificates":
      return {
        name: props.name ?? "",
        scoreOrLevel: props.scoreOrLevel ?? "",
        issuer: props.issuer ?? "",
        date: props.date ?? "",
        url: props.url ?? "",
        description: props.description ?? "",
      };
    case "awards":
      return {
        awardName: props.awardName ?? "",
        issuer: props.issuer ?? "",
        awardedAt: props.awardedAt ?? "",
        description: props.description ?? "",
      };
    case "personalExperiences":
      return {
        experienceTitle: props.experienceTitle ?? "",
        startDate: props.startDate ?? "",
        endDate: props.endDate ?? "",
        description: props.description ?? "",
      };
    default:
      return { ...props };
  }
}
