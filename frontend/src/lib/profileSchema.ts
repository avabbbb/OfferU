export type BuiltinProfileCategoryKey =
  | "education"
  | "experience"
  | "project"
  | "skill"
  | "certificate";

export type ProfileCategoryKey = BuiltinProfileCategoryKey | string;

export const PROFILE_SECTION_SCHEMA_VERSION = "profile.section.v1";
export const PROFILE_BASE_SCHEMA_VERSION = "profile.base.v1";

export const PROFILE_BASE_FIELD_IDS = {
  name: "base.full_name",
  phone: "base.phone",
  email: "base.email",
  linkedin: "base.linkedin_url",
  github: "base.github_url",
  website: "base.website_url",
  summary: "base.summary",
} as const;

export const PROFILE_CATEGORY_DEFINITIONS = {
  education: {
    label: "教育经历",
    resumeSectionType: "education",
    fieldIds: {
      school: "education.school_name",
      degree: "education.degree",
      major: "education.major",
      startDate: "education.start_date",
      endDate: "education.end_date",
      gpa: "education.gpa",
      description: "education.description",
    },
  },
  experience: {
    label: "工作经历",
    resumeSectionType: "workExperiences",
    fieldIds: {
      company: "experience.company_name",
      position: "experience.position_title",
      startDate: "experience.start_date",
      endDate: "experience.end_date",
      description: "experience.description",
    },
  },
  project: {
    label: "项目经历",
    resumeSectionType: "projects",
    fieldIds: {
      name: "project.name",
      role: "project.role",
      url: "project.url",
      startDate: "project.start_date",
      endDate: "project.end_date",
      description: "project.description",
    },
  },
  skill: {
    label: "技能清单",
    resumeSectionType: "skills",
    fieldIds: {
      category: "skill.category",
      items: "skill.items",
    },
  },
  certificate: {
    label: "证书资质",
    resumeSectionType: "certificates",
    fieldIds: {
      name: "certificate.name",
      scoreOrLevel: "certificate.score_or_level",
      issuer: "certificate.issuer",
      date: "certificate.date",
      url: "certificate.url",
    },
  },
} as const;

export const PROFILE_BUILTIN_CATEGORY_ORDER: BuiltinProfileCategoryKey[] = [
  "education",
  "experience",
  "project",
  "skill",
  "certificate",
];

export interface ProfileSectionLike {
  id: number;
  section_type: string;
  title: string;
  category_key?: string;
  category_label?: string;
  content_json: Record<string, any>;
  updated_at?: string;
}

export interface ProfileCategoryOption {
  key: string;
  label: string;
  isCustom: boolean;
}

export type ProfileSectionDraft =
  | {
      school: string;
      degree: string;
      major: string;
      startDate: string;
      endDate: string;
      gpa: string;
      description: string;
    }
  | {
      company: string;
      position: string;
      startDate: string;
      endDate: string;
      description: string;
    }
  | {
      name: string;
      role: string;
      url: string;
      startDate: string;
      endDate: string;
      description: string;
    }
  | {
      category: string;
      itemsText: string;
    }
  | {
      name: string;
      scoreOrLevel: string;
      issuer: string;
      date: string;
      url: string;
    }
  | {
      subtitle: string;
      description: string;
      highlightsText: string;
    };

function asString(value: unknown): string {
  if (value == null) return "";
  return String(value).trim();
}

function asStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => asString(item)).filter(Boolean);
  }
  const text = asString(value);
  if (!text) return [];
  return text
    .split(/[，,、\n]/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

function getFieldValues(contentJson: Record<string, any> | null | undefined): Record<string, any> {
  const maybe = contentJson?.field_values;
  return maybe && typeof maybe === "object" && !Array.isArray(maybe) ? maybe : {};
}

function getNormalized(contentJson: Record<string, any> | null | undefined): Record<string, any> {
  const maybe = contentJson?.normalized;
  return maybe && typeof maybe === "object" && !Array.isArray(maybe) ? maybe : {};
}

function readFromAliases(contentJson: Record<string, any>, aliases: string[]): unknown {
  const normalized = getNormalized(contentJson);
  for (const key of aliases) {
    if (normalized[key] != null) return normalized[key];
  }
  for (const key of aliases) {
    if (contentJson[key] != null) return contentJson[key];
  }
  return undefined;
}

function readField(
  contentJson: Record<string, any>,
  fieldId: string,
  aliases: string[],
  listMode = false
): string | string[] {
  const fieldValues = getFieldValues(contentJson);
  const raw = fieldValues[fieldId] ?? readFromAliases(contentJson, aliases);
  return listMode ? asStringList(raw) : asString(raw);
}

function customFieldId(categoryKey: string, leaf: string): string {
  const safe = categoryKey.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "custom";
  return `${safe}.${leaf}`;
}

export function normalizeProfileCategoryKey(raw: string): string {
  const key = asString(raw).toLowerCase();
  if (!key) return "custom:c_generic";
  if (key in PROFILE_CATEGORY_DEFINITIONS) return key;
  if (key === "internship") return "experience";
  if (key === "honor" || key === "language") return "skill";
  if (key === "general" || key === "activity" || key === "competition") return "custom:c_legacy";
  if (isCustomCategoryKey(key)) return key;
  if (key === "custom") return "custom:c_generic";
  return "custom:c_legacy";
}

export function isCustomCategoryKey(key: string): boolean {
  return /^custom:[a-z0-9_]{6,64}$/.test(asString(key).toLowerCase());
}

export function buildCustomCategoryKey(label: string): string {
  const raw = asString(label);
  if (!raw) return "custom:c_generic";
  let hash = 0;
  for (let i = 0; i < raw.length; i += 1) {
    hash = (hash << 5) - hash + raw.charCodeAt(i);
    hash |= 0;
  }
  const token = Math.abs(hash).toString(36).padEnd(8, "0").slice(0, 8);
  return `custom:c_${token}`;
}

export function resolveProfileCategoryLabel(categoryKey: string, fromSection?: string): string {
  const normalizedKey = normalizeProfileCategoryKey(categoryKey);
  const specialCustomLabels: Record<string, string> = {
    "custom:c_personal": "个人经历",
    "custom:c_awards": "获奖经历",
    "custom:c_internship": "实习经历",
  };
  if (specialCustomLabels[normalizedKey]) {
    return specialCustomLabels[normalizedKey];
  }
  if (normalizedKey in PROFILE_CATEGORY_DEFINITIONS) {
    return PROFILE_CATEGORY_DEFINITIONS[normalizedKey as BuiltinProfileCategoryKey].label;
  }
  return asString(fromSection) || "个人经历";
}

export function getBuiltinCategoryOptions(): ProfileCategoryOption[] {
  return PROFILE_BUILTIN_CATEGORY_ORDER.map((key) => ({
    key,
    label: PROFILE_CATEGORY_DEFINITIONS[key].label,
    isCustom: false,
  }));
}

export function normalizeBaseInfoPayload(rawBaseInfo: Record<string, any> | null | undefined): Record<string, any> {
  const raw = rawBaseInfo && typeof rawBaseInfo === "object" ? rawBaseInfo : {};
  const fieldValues = raw.field_values && typeof raw.field_values === "object" ? raw.field_values : {};

  const normalized = {
    name: asString(raw.name ?? fieldValues[PROFILE_BASE_FIELD_IDS.name]),
    phone: asString(raw.phone ?? fieldValues[PROFILE_BASE_FIELD_IDS.phone]),
    email: asString(raw.email ?? fieldValues[PROFILE_BASE_FIELD_IDS.email]),
    linkedin: asString(raw.linkedin ?? fieldValues[PROFILE_BASE_FIELD_IDS.linkedin]),
    github: asString(raw.github ?? fieldValues[PROFILE_BASE_FIELD_IDS.github]),
    website: asString(raw.website ?? fieldValues[PROFILE_BASE_FIELD_IDS.website]),
    summary: asString(raw.summary ?? fieldValues[PROFILE_BASE_FIELD_IDS.summary]),
  };

  return {
    ...raw,
    ...normalized,
    schema_version: PROFILE_BASE_SCHEMA_VERSION,
    field_values: {
      [PROFILE_BASE_FIELD_IDS.name]: normalized.name,
      [PROFILE_BASE_FIELD_IDS.phone]: normalized.phone,
      [PROFILE_BASE_FIELD_IDS.email]: normalized.email,
      [PROFILE_BASE_FIELD_IDS.linkedin]: normalized.linkedin,
      [PROFILE_BASE_FIELD_IDS.github]: normalized.github,
      [PROFILE_BASE_FIELD_IDS.website]: normalized.website,
      [PROFILE_BASE_FIELD_IDS.summary]: normalized.summary,
    },
  };
}

export function buildProfileSectionContent(
  categoryKey: string,
  title: string,
  draft: ProfileSectionDraft,
  categoryLabel?: string
): Record<string, any> {
  const key = normalizeProfileCategoryKey(categoryKey);
  const label = resolveProfileCategoryLabel(key, categoryLabel);

  if (key === "education") {
    const d = draft as Extract<ProfileSectionDraft, { school: string }>;
    const fieldIds = PROFILE_CATEGORY_DEFINITIONS.education.fieldIds;
    const normalized = {
      school: asString(d.school),
      degree: asString(d.degree),
      major: asString(d.major),
      start_date: asString(d.startDate),
      end_date: asString(d.endDate),
      gpa: asString(d.gpa),
      description: asString(d.description),
    };
    return {
      schema_version: PROFILE_SECTION_SCHEMA_VERSION,
      category_key: key,
      category_label: label,
      title: asString(title),
      normalized,
      field_values: {
        [fieldIds.school]: normalized.school,
        [fieldIds.degree]: normalized.degree,
        [fieldIds.major]: normalized.major,
        [fieldIds.startDate]: normalized.start_date,
        [fieldIds.endDate]: normalized.end_date,
        [fieldIds.gpa]: normalized.gpa,
        [fieldIds.description]: normalized.description,
      },
      bullet: [
        normalized.school,
        normalized.degree,
        normalized.major,
        [normalized.start_date, normalized.end_date].filter(Boolean).join("-"),
        normalized.description,
      ]
        .filter(Boolean)
        .join(" | "),
    };
  }

  if (key === "experience") {
    const d = draft as Extract<ProfileSectionDraft, { company: string }>;
    const fieldIds = PROFILE_CATEGORY_DEFINITIONS.experience.fieldIds;
    const normalized = {
      company: asString(d.company),
      position: asString(d.position),
      start_date: asString(d.startDate),
      end_date: asString(d.endDate),
      description: asString(d.description),
    };
    return {
      schema_version: PROFILE_SECTION_SCHEMA_VERSION,
      category_key: key,
      category_label: label,
      title: asString(title),
      normalized,
      field_values: {
        [fieldIds.company]: normalized.company,
        [fieldIds.position]: normalized.position,
        [fieldIds.startDate]: normalized.start_date,
        [fieldIds.endDate]: normalized.end_date,
        [fieldIds.description]: normalized.description,
      },
      bullet: [
        normalized.company,
        normalized.position,
        [normalized.start_date, normalized.end_date].filter(Boolean).join("-"),
        normalized.description,
      ]
        .filter(Boolean)
        .join(" | "),
    };
  }

  if (key === "project") {
    const d = draft as Extract<ProfileSectionDraft, { role: string; url: string }>;
    const fieldIds = PROFILE_CATEGORY_DEFINITIONS.project.fieldIds;
    const normalized = {
      name: asString(d.name),
      role: asString(d.role),
      url: asString(d.url),
      start_date: asString(d.startDate),
      end_date: asString(d.endDate),
      description: asString(d.description),
    };
    return {
      schema_version: PROFILE_SECTION_SCHEMA_VERSION,
      category_key: key,
      category_label: label,
      title: asString(title),
      normalized,
      field_values: {
        [fieldIds.name]: normalized.name,
        [fieldIds.role]: normalized.role,
        [fieldIds.url]: normalized.url,
        [fieldIds.startDate]: normalized.start_date,
        [fieldIds.endDate]: normalized.end_date,
        [fieldIds.description]: normalized.description,
      },
      bullet: [
        normalized.name,
        normalized.role,
        [normalized.start_date, normalized.end_date].filter(Boolean).join("-"),
        normalized.description,
      ]
        .filter(Boolean)
        .join(" | "),
    };
  }

  if (key === "skill") {
    const d = draft as Extract<ProfileSectionDraft, { itemsText: string }>;
    const fieldIds = PROFILE_CATEGORY_DEFINITIONS.skill.fieldIds;
    const items = asStringList(d.itemsText);
    const normalized = {
      category: asString(d.category),
      items,
    };
    return {
      schema_version: PROFILE_SECTION_SCHEMA_VERSION,
      category_key: key,
      category_label: label,
      title: asString(title),
      normalized,
      field_values: {
        [fieldIds.category]: normalized.category,
        [fieldIds.items]: normalized.items,
      },
      bullet: normalized.items.join("、"),
    };
  }

  if (key === "certificate") {
    const d = draft as Extract<ProfileSectionDraft, { issuer: string; date: string; scoreOrLevel: string }>;
    const fieldIds = PROFILE_CATEGORY_DEFINITIONS.certificate.fieldIds;
    const normalized = {
      name: asString(d.name),
      score_or_level: asString(d.scoreOrLevel),
      issuer: asString(d.issuer),
      date: asString(d.date),
      url: asString(d.url),
    };
    return {
      schema_version: PROFILE_SECTION_SCHEMA_VERSION,
      category_key: key,
      category_label: label,
      title: asString(title),
      normalized,
      field_values: {
        [fieldIds.name]: normalized.name,
        [fieldIds.scoreOrLevel]: normalized.score_or_level,
        [fieldIds.issuer]: normalized.issuer,
        [fieldIds.date]: normalized.date,
        [fieldIds.url]: normalized.url,
      },
      bullet: [normalized.name, normalized.score_or_level, normalized.issuer, normalized.date].filter(Boolean).join(" | "),
    };
  }

  const d = draft as Extract<ProfileSectionDraft, { subtitle: string; highlightsText: string }>;
  const normalized = {
    subtitle: asString(d.subtitle),
    description: asString(d.description),
    highlights: asStringList(d.highlightsText),
  };
  return {
    schema_version: PROFILE_SECTION_SCHEMA_VERSION,
    category_key: key,
    category_label: label,
    title: asString(title),
    normalized,
    field_values: {
      [customFieldId(key, "subtitle")]: normalized.subtitle,
      [customFieldId(key, "description")]: normalized.description,
      [customFieldId(key, "highlights")]: normalized.highlights,
    },
    bullet: [normalized.subtitle, normalized.description].filter(Boolean).join(" | "),
  };
}

export function getProfileBulletText(section: ProfileSectionLike): string {
  const content = section.content_json || {};
  const bullet = asString(content.bullet);
  if (bullet) return bullet;

  const normalized = getNormalized(content);
  const fallback = [
    asString(normalized.description),
    asString(normalized.school),
    asString(normalized.company),
    asString(normalized.name),
    asString(normalized.position),
    asString(normalized.role),
    Array.isArray(normalized.items) ? normalized.items.join("、") : "",
  ]
    .map((item) => asString(item))
    .filter(Boolean)
    .join(" | ");

  if (fallback) return fallback;

  try {
    return JSON.stringify(content);
  } catch {
    return "";
  }
}

export function parseProfileSectionDraft(section: ProfileSectionLike): ProfileSectionDraft {
  const key = normalizeProfileCategoryKey(section.category_key || section.section_type);
  const content = section.content_json || {};

  if (key === "education") {
    const fieldIds = PROFILE_CATEGORY_DEFINITIONS.education.fieldIds;
    return {
      school: readField(content, fieldIds.school, ["school", "school_name", "schoolName"]) as string,
      degree: readField(content, fieldIds.degree, ["degree"]) as string,
      major: readField(content, fieldIds.major, ["major"]) as string,
      startDate: readField(content, fieldIds.startDate, ["start_date", "startDate"]) as string,
      endDate: readField(content, fieldIds.endDate, ["end_date", "endDate"]) as string,
      gpa: readField(content, fieldIds.gpa, ["gpa"]) as string,
      description: readField(content, fieldIds.description, ["description", "desc"]) as string,
    };
  }

  if (key === "experience") {
    const fieldIds = PROFILE_CATEGORY_DEFINITIONS.experience.fieldIds;
    return {
      company: readField(content, fieldIds.company, ["company", "company_name", "companyName"]) as string,
      position: readField(content, fieldIds.position, ["position", "job_title", "positionTitle"]) as string,
      startDate: readField(content, fieldIds.startDate, ["start_date", "startDate"]) as string,
      endDate: readField(content, fieldIds.endDate, ["end_date", "endDate"]) as string,
      description: readField(content, fieldIds.description, ["description", "desc"]) as string,
    };
  }

  if (key === "project") {
    const fieldIds = PROFILE_CATEGORY_DEFINITIONS.project.fieldIds;
    return {
      name: readField(content, fieldIds.name, ["name", "project_name", "projectName"]) as string,
      role: readField(content, fieldIds.role, ["role"]) as string,
      url: readField(content, fieldIds.url, ["url", "link"]) as string,
      startDate: readField(content, fieldIds.startDate, ["start_date", "startDate"]) as string,
      endDate: readField(content, fieldIds.endDate, ["end_date", "endDate"]) as string,
      description: readField(content, fieldIds.description, ["description", "desc"]) as string,
    };
  }

  if (key === "skill") {
    const fieldIds = PROFILE_CATEGORY_DEFINITIONS.skill.fieldIds;
    return {
      category: readField(content, fieldIds.category, ["category"]) as string,
      itemsText: (readField(content, fieldIds.items, ["items", "skill_items", "skillItems"], true) as string[]).join("、"),
    };
  }

  if (key === "certificate") {
    const fieldIds = PROFILE_CATEGORY_DEFINITIONS.certificate.fieldIds;
    return {
      name: readField(content, fieldIds.name, ["name", "certificate_name", "certificateName"]) as string,
      scoreOrLevel: readField(content, fieldIds.scoreOrLevel, ["score_or_level", "scoreOrLevel", "score", "level"]) as string,
      issuer: readField(content, fieldIds.issuer, ["issuer", "organization"]) as string,
      date: readField(content, fieldIds.date, ["date", "issued_date", "issuedDate"]) as string,
      url: readField(content, fieldIds.url, ["url", "link"]) as string,
    };
  }

  const subtitleId = customFieldId(key, "subtitle");
  const descriptionId = customFieldId(key, "description");
  const highlightsId = customFieldId(key, "highlights");
  return {
    subtitle: readField(content, subtitleId, ["subtitle", "sub_title"]) as string,
    description: readField(content, descriptionId, ["description", "desc"]) as string,
    highlightsText: (readField(content, highlightsId, ["highlights", "items"], true) as string[]).join("、"),
  };
}

export function mapProfileSectionToResumeType(sectionType: string):
  | "education"
  | "workExperiences"
  | "internshipExperiences"
  | "projects"
  | "skills"
  | "certificates"
  | "awards"
  | "personalExperiences" {
  const key = normalizeProfileCategoryKey(sectionType);
  if (key === "custom:c_internship") return "internshipExperiences";
  if (key === "custom:c_awards") return "awards";
  if (key === "custom:c_personal") return "personalExperiences";
  if (key in PROFILE_CATEGORY_DEFINITIONS) {
    return PROFILE_CATEGORY_DEFINITIONS[key as BuiltinProfileCategoryKey].resumeSectionType as
      | "education"
      | "workExperiences"
      | "projects"
      | "skills"
      | "certificates";
  }
  return "personalExperiences";
}

export function mapProfileSectionToResumeItem(section: ProfileSectionLike): Record<string, any> {
  const key = normalizeProfileCategoryKey(section.category_key || section.section_type);
  const draft = parseProfileSectionDraft(section);
  const normalized = getNormalized(section.content_json || {});
  const sourceMeta = {
    _source_profile_section_id: section.id,
    _source_profile_updated_at: asString(section.updated_at),
    _source_profile_category_key: key,
  };

  if (key === "education") {
    const d = draft as Extract<ProfileSectionDraft, { school: string }>;
    return {
      school: asString(d.school || section.title),
      degree: asString(d.degree),
      major: asString(d.major),
      gpa: asString(d.gpa),
      startDate: asString(d.startDate),
      endDate: asString(d.endDate),
      description: asString(d.description),
      ...sourceMeta,
    };
  }

  if (key === "experience") {
    const d = draft as Extract<ProfileSectionDraft, { company: string }>;
    return {
      company: asString(d.company || section.title),
      position: asString(d.position),
      startDate: asString(d.startDate),
      endDate: asString(d.endDate),
      description: asString(d.description),
      ...sourceMeta,
    };
  }

  if (key === "custom:c_internship") {
    return {
      company: asString(normalized.company || section.title),
      position: asString(normalized.position),
      startDate: asString(normalized.start_date || normalized.startDate),
      endDate: asString(normalized.end_date || normalized.endDate),
      description: asString(normalized.description),
      ...sourceMeta,
    };
  }

  if (key === "project") {
    const d = draft as Extract<ProfileSectionDraft, { role: string; url: string }>;
    return {
      name: asString(d.name || section.title),
      role: asString(d.role),
      url: asString(d.url),
      startDate: asString(d.startDate),
      endDate: asString(d.endDate),
      description: asString(d.description),
      ...sourceMeta,
    };
  }

  if (key === "skill") {
    const d = draft as Extract<ProfileSectionDraft, { itemsText: string }>;
    return {
      category: asString(d.category || section.title || "技能"),
      items: asStringList(d.itemsText),
      remark: asString(normalized.description || normalized.remark),
      ...sourceMeta,
    };
  }

  if (key === "certificate") {
    const d = draft as Extract<ProfileSectionDraft, { issuer: string; date: string; scoreOrLevel: string }>;
    return {
      name: asString(d.name || section.title),
      scoreOrLevel: asString(d.scoreOrLevel),
      issuer: asString(d.issuer),
      date: asString(d.date),
      url: asString(d.url),
      ...sourceMeta,
    };
  }

  if (key === "custom:c_awards") {
    return {
      awardName: asString(section.title || normalized.name || normalized.subtitle),
      issuer: asString(normalized.issuer),
      awardedAt: asString(normalized.date || normalized.awardedAt),
      description: asString(normalized.description),
      ...sourceMeta,
    };
  }

  const d = draft as Extract<ProfileSectionDraft, { subtitle: string; description: string }>;
  return {
    experienceTitle: asString(d.subtitle || section.title),
    startDate: asString(normalized.start_date || normalized.startDate),
    endDate: asString(normalized.end_date || normalized.endDate),
    description: asString(d.description || normalized.description),
    ...sourceMeta,
  };
}

export function mapProfileCandidateToResumeItem(section: ProfileSectionLike): Record<string, any> {
  const item = mapProfileSectionToResumeItem(section);
  const bullet = asString(section.content_json?.bullet);
  const resumeType = mapProfileSectionToResumeType(section.section_type);
  if (bullet && resumeType === "skills") {
    item.items = asStringList(bullet);
  } else if (bullet && resumeType === "certificates") {
    item.name = bullet;
  } else if (bullet) {
    item.description = bullet;
  }
  delete item._source_profile_section_id;
  delete item._source_profile_updated_at;
  delete item._source_profile_category_key;
  return item;
}

export interface ResumeCandidateGroup {
  sectionType: ReturnType<typeof mapProfileSectionToResumeType>;
  title: string;
  sortOrder: number;
  items: Record<string, any>[];
}

export function groupProfileCandidatesForResume(
  candidates: ProfileSectionLike[]
): ResumeCandidateGroup[] {
  const titles: Record<ResumeCandidateGroup["sectionType"], string> = {
    education: "教育经历",
    workExperiences: "工作经历",
    internshipExperiences: "实习经历",
    projects: "项目经历",
    skills: "技能",
    certificates: "证书",
    awards: "获奖经历",
    personalExperiences: "个人经历",
  };
  const groups = new Map<ResumeCandidateGroup["sectionType"], ResumeCandidateGroup>();
  const sortOrders: Record<ResumeCandidateGroup["sectionType"], number> = {
    education: 0,
    workExperiences: 1,
    internshipExperiences: 2,
    projects: 3,
    skills: 4,
    certificates: 5,
    awards: 6,
    personalExperiences: 7,
  };
  for (const candidate of candidates) {
    const sectionType = mapProfileSectionToResumeType(candidate.section_type);
    const group = groups.get(sectionType) || {
      sectionType,
      title: titles[sectionType],
      sortOrder: sortOrders[sectionType],
      items: [],
    };
    group.items.push(mapProfileCandidateToResumeItem(candidate));
    groups.set(sectionType, group);
  }
  return [...groups.values()];
}

export function getProfileSectionEndDate(section: ProfileSectionLike): string {
  const key = normalizeProfileCategoryKey(section.category_key || section.section_type);
  const content = section.content_json || {};

  if (key === "education") {
    const fieldIds = PROFILE_CATEGORY_DEFINITIONS.education.fieldIds;
    return asString(readField(content, fieldIds.endDate, ["end_date", "endDate"]));
  }
  if (key === "experience") {
    const fieldIds = PROFILE_CATEGORY_DEFINITIONS.experience.fieldIds;
    return asString(readField(content, fieldIds.endDate, ["end_date", "endDate"]));
  }
  if (key === "project") {
    const fieldIds = PROFILE_CATEGORY_DEFINITIONS.project.fieldIds;
    return asString(readField(content, fieldIds.endDate, ["end_date", "endDate"]));
  }
  if (key === "certificate") {
    const fieldIds = PROFILE_CATEGORY_DEFINITIONS.certificate.fieldIds;
    return asString(readField(content, fieldIds.date, ["date", "issued_date", "issuedDate"]));
  }
  return asString(section.updated_at);
}


