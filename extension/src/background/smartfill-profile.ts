export interface SmartFillProfileNormalized {
  profileVersion: string;
  basic: {
    fullName: string;
    phone: string;
    email: string;
    city: string;
    targetRole: string;
    website: string;
    github: string;
    linkedin?: string;
    summary: string;
  };
  resumeArchive: {
    personalSummary: string;
    education: unknown[];
    workExperiences: unknown[];
    internshipExperiences: unknown[];
    projects: unknown[];
    skills: unknown[];
    certificates: unknown[];
    awards: unknown[];
    personalExperiences: unknown[];
  };
  applicationArchive: {
    shared: Record<string, unknown>;
    identityContact: Record<string, unknown>;
    jobPreference: Record<string, unknown>;
    campusFields: Record<string, unknown>;
    relationshipCompliance: Record<string, unknown>;
    sourceReferral: Record<string, unknown>;
    attachments: Record<string, unknown>;
  };
  syncSettings: Record<string, unknown>;
  sections: unknown[];
}

const CRITICAL_EDUCATION_KEYS = new Set([
  "schoolName",
  "school",
  "university",
  "college",
  "major",
  "degree",
  "educationLevel",
  "startDate",
  "endDate",
  "graduationDate",
]);

export function selectCriticalSmartFillProfile(
  profile: SmartFillProfileNormalized,
): SmartFillProfileNormalized {
  const education = profile.resumeArchive.education.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    return Object.fromEntries(
      Object.entries(item as Record<string, unknown>)
        .filter(([key]) => CRITICAL_EDUCATION_KEYS.has(key)),
    );
  });
  return {
    profileVersion: profile.profileVersion,
    basic: {
      fullName: profile.basic.fullName,
      phone: profile.basic.phone,
      email: profile.basic.email,
      city: profile.basic.city,
      targetRole: "",
      website: profile.basic.website,
      github: profile.basic.github,
      linkedin: profile.basic.linkedin || "",
      summary: "",
    },
    resumeArchive: {
      personalSummary: "",
      education,
      workExperiences: [],
      internshipExperiences: [],
      projects: [],
      skills: [],
      certificates: [],
      awards: [],
      personalExperiences: [],
    },
    applicationArchive: {
      shared: {},
      identityContact: {},
      jobPreference: {},
      campusFields: {},
      relationshipCompliance: {},
      sourceReferral: {},
      attachments: {},
    },
    syncSettings: {},
    sections: [],
  };
}

export type SmartFillProfileValueType =
  | "text"
  | "long-text"
  | "date"
  | "date-range"
  | "email"
  | "phone"
  | "url"
  | "id-number"
  | "number"
  | "choice"
  | "multi-choice"
  | "boolean";

export interface SmartFillProfileFieldValue {
  key: string;
  path?: string;
  label: string;
  value: string;
  category?: string;
  categoryKey?: string;
  categoryLabel?: string;
  sectionType?: string;
  subsection?: string;
  itemIndex?: number;
  valueType?: SmartFillProfileValueType;
  aliases?: string[];
  sourceRef?: string;
  signature?: string;
}

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" ? (input as Record<string, unknown>) : {};
}

function asString(input: unknown): string {
  return typeof input === "string" ? input.trim() : String(input ?? "").trim();
}

function isPlainObject(input: unknown): input is Record<string, unknown> {
  return Boolean(input && typeof input === "object" && !Array.isArray(input));
}

function asArray(input: unknown): unknown[] {
  return Array.isArray(input) ? input : [];
}

function asArrayLoose(input: unknown): unknown[] {
  if (Array.isArray(input)) return input;
  if (typeof input === "string") {
    const text = input.trim();
    return text ? [text] : [];
  }
  if (input && typeof input === "object") return [input];
  return [];
}

function pickFirstArray(record: Record<string, unknown>, keys: string[]): unknown[] {
  for (const key of keys) {
    const value = asArrayLoose(record[key]);
    if (value.length > 0) return value;
  }
  return [];
}

function normalizeAwardItem(input: unknown): Record<string, unknown> | null {
  if (typeof input === "string") {
    const text = input.trim();
    if (!text) return null;
    return {
      awardName: text,
      descriptions: [text],
    };
  }

  if (!input || typeof input !== "object") return null;
  const row = input as Record<string, unknown>;
  const awardName = asString(
    row.awardName
    || row.awardExperience
    || row.name
    || row.title
    || row["获奖经历"]
    || row["奖项名称"],
  );
  const issuer = asString(
    row.issuer
    || row.organization
    || row.awardingOrganization
    || row.grantor
    || row["颁发机构"],
  );
  const awardedAt = asString(
    row.awardedAt
    || row.awardDate
    || row.date
    || row.grantedAt
    || row.acquiredDate
    || row["获奖时间"],
  );
  const description = asString(
    row.description
    || row.remark
    || row.details
    || row.content
    || row["描述"],
  );
  const descriptions = asArray(row.descriptions)
    .map((item) => asString(item))
    .filter(Boolean);

  if (!awardName && !issuer && !awardedAt && !description && descriptions.length === 0) {
    return null;
  }

  return {
    ...row,
    awardName,
    issuer,
    awardedAt,
    descriptions: descriptions.length > 0 ? descriptions : (description ? [description] : []),
  };
}

function normalizeAwards(input: unknown): unknown[] {
  return asArrayLoose(input)
    .map((item) => normalizeAwardItem(item))
    .filter((item): item is Record<string, unknown> => Boolean(item));
}

function extractAwardsFromSections(rawSections: unknown): unknown[] {
  const sections = asArray(rawSections);
  const awards: unknown[] = [];
  for (const item of sections) {
    if (!item || typeof item !== "object") continue;
    const section = item as Record<string, unknown>;
    const typeHint = `${asString(section.section_type)} ${asString(section.category_key)} ${asString(section.category_label)} ${asString(section.title)}`.toLowerCase();
    if (!/award|honor|honour|获奖|荣誉|奖励/.test(typeHint)) continue;

    const content = asRecord(section.content_json);
    const normalized = asRecord(content.normalized);
    const fromSection = normalizeAwardItem({
      awardName: normalized.awardName || normalized.name || section.title || normalized.subtitle,
      issuer: normalized.issuer || normalized.organization || normalized.awardingOrganization,
      awardedAt: normalized.awardedAt || normalized.awardDate || normalized.date,
      descriptions: [
        normalized.description,
        content.bullet,
      ].map((value) => asString(value)).filter(Boolean),
    });
    if (fromSection) awards.push(fromSection);
  }
  return awards;
}


function compactText(input: unknown): string {
  if (typeof input === "string") return input.trim();
  if (typeof input === "number" || typeof input === "boolean") return String(input);
  if (Array.isArray(input)) {
    const lines = input.map((item) => compactText(item)).filter(Boolean);
    return lines.join(" | ");
  }
  if (input && typeof input === "object") {
    const values = Object.values(input as Record<string, unknown>)
      .map((item) => compactText(item))
      .filter(Boolean);
    return values.join(" | ");
  }
  return "";
}

const SMART_FILL_FIELD_LABELS: Record<string, string> = {
  schoolName: "学校名称",
  school: "学校",
  university: "毕业院校",
  college: "学院",
  major: "专业",
  degree: "学位",
  educationLevel: "学历",
  relatedCourses: "相关课程",
  courses: "相关课程",
  startDate: "开始时间",
  endDate: "结束时间",
  graduationDate: "毕业时间",
  companyName: "公司名称",
  company: "公司",
  employer: "工作单位",
  jobTitle: "职位名称",
  position: "职位",
  role: "担任职务",
  description: "描述",
  workDescription: "工作内容",
  projectName: "项目名称",
  projectRole: "项目角色",
  projectDescription: "项目描述",
  internshipCompany: "实习公司",
  internshipPosition: "实习职位",
  descriptions: "描述列表",
};

function labelForProfileKey(key: string): string {
  if (SMART_FILL_FIELD_LABELS[key]) return SMART_FILL_FIELD_LABELS[key];
  const tail = key.split(/[._-]/).filter(Boolean).pop() || key;
  return SMART_FILL_FIELD_LABELS[tail] || tail;
}

function inferSectionType(category: string, baseKey = ""): string {
  const text = `${category} ${baseKey}`;
  if (/教育|school|education/i.test(text)) return "education";
  if (/实习|intern/i.test(text)) return "internship";
  if (/工作|work|experience/i.test(text)) return "work";
  if (/项目|project/i.test(text)) return "project";
  if (/证书|certificate|语言|language/i.test(text)) return "certificate";
  if (/奖|荣誉|award|honou?r/i.test(text)) return "award";
  if (/技能|skill/i.test(text)) return "skill";
  if (/身份|基本|联系|basic|identity/i.test(text)) return "basic";
  return "general";
}

function inferValueType(label: string, key: string, value: string): SmartFillProfileValueType {
  const text = `${label} ${key}`.toLowerCase();
  if (/email|邮箱|邮件/.test(text)) return "email";
  if (/phone|mobile|tel|手机|电话|联系方式/.test(text)) return "phone";
  if (/url|link|github|linkedin|website|链接|网址|主页|作品|论文/.test(text)) return "url";
  if (/idnumber|identity|身份证|证件号|证件号码/.test(text)) return "id-number";
  if (/date|time|日期|时间|开始|结束|出生|毕业|入学|到岗/.test(text)) {
    return isDateRangeValue(value) ? "date-range" : "date";
  }
  if (/gender|sex|性别|学历|学位|政治面貌|婚姻|是否|状态|类型/.test(text)) return "choice";
  if (/课程|技能|skills|items|relatedcourses/.test(text)) return "multi-choice";
  if (/gpa|score|rank|height|weight|薪资|分数|成绩|排名/.test(text) && /\d/.test(value)) return "number";
  if (value.length > 120 || /description|summary|content|描述|简介|评价|职责|内容/.test(text)) return "long-text";
  return "text";
}

function isDateRangeValue(value: string): boolean {
  const text = String(value || "").trim();
  if (!text) return false;
  const dateToken = String.raw`(?:19|20)\d{2}(?:[-/.年]\s?\d{1,2})?(?:[-/.月]\s?\d{1,2})?`;
  return new RegExp(`${dateToken}\\s*(?:至|到|~|—|–|\\s-\\s)\\s*${dateToken}`).test(text);
}

function buildSmartFillFieldSignature(input: {
  path: string;
  label: string;
  category: string;
  itemIndex?: number;
  valueType: SmartFillProfileValueType;
}): string {
  const text = [input.path, input.category, input.itemIndex || "", input.label, input.valueType].join("::");
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function enrichFieldValue(input: Omit<SmartFillProfileFieldValue, "path" | "categoryKey" | "categoryLabel" | "sectionType" | "valueType" | "sourceRef" | "signature"> & {
  path?: string;
  categoryKey?: string;
  categoryLabel?: string;
  sectionType?: string;
  valueType?: SmartFillProfileValueType;
  sourceRef?: string;
  signature?: string;
}): SmartFillProfileFieldValue {
  const path = input.path || input.key;
  const category = input.category || input.categoryLabel || "";
  const sectionType = input.sectionType || inferSectionType(category, path);
  const valueType = input.valueType || inferValueType(input.label, path, input.value);
  return {
    ...input,
    path,
    categoryKey: input.categoryKey || sectionType,
    categoryLabel: input.categoryLabel || category,
    sectionType,
    valueType,
    sourceRef: input.sourceRef || `${category}${input.subsection ? `/${input.subsection}` : ""}/${input.label}`,
    signature: input.signature || buildSmartFillFieldSignature({
      path,
      label: input.label,
      category,
      itemIndex: input.itemIndex,
      valueType,
    }),
  };
}

function pushArchiveItemValues(
  values: SmartFillProfileFieldValue[],
  baseKey: string,
  category: string,
  items: unknown[],
): void {
  items.forEach((item, itemOffset) => {
    const itemIndex = itemOffset + 1;
    if (!item || typeof item !== "object") {
      const value = compactText(item);
      if (value) {
        values.push(enrichFieldValue({
          key: `${baseKey}.${itemOffset}`,
          path: `${baseKey}.${itemOffset}`,
          label: category,
          value,
          category,
          subsection: `第${itemIndex}条`,
          itemIndex,
          aliases: [category],
        }));
      }
      return;
    }

    for (const [fieldKey, rawValue] of Object.entries(item as Record<string, unknown>)) {
      if (isPlainObject(rawValue)) continue;
      const value = Array.isArray(rawValue) ? compactText(rawValue) : asString(rawValue);
      if (!value) continue;
      const label = labelForProfileKey(fieldKey);
      values.push(enrichFieldValue({
        key: `${baseKey}.${itemOffset}.${fieldKey}`,
        path: `${baseKey}.${itemOffset}.${fieldKey}`,
        label,
        value,
        category,
        subsection: `第${itemIndex}条`,
        itemIndex,
        aliases: [label],
      }));
    }
  });
}

function pickArchiveFromProfile(rawProfile: unknown): {
  profileVersion: string;
  basicRaw: Record<string, unknown>;
  resumeArchiveRaw: Record<string, unknown>;
  applicationArchiveRaw: Record<string, unknown>;
  syncSettingsRaw: Record<string, unknown>;
  sectionsRaw: unknown[];
} {
  const profile = asRecord(rawProfile);

  const basicDirect = asRecord(profile.basic);
  const resumeDirect = asRecord(profile.resumeArchive);
  const appDirect = asRecord(profile.applicationArchive);
  const syncDirect = asRecord(profile.syncSettings);
  const hasDirect = Object.keys(basicDirect).length > 0
    || Object.keys(resumeDirect).length > 0
    || Object.keys(appDirect).length > 0;

  const baseInfo = asRecord(profile.base_info_json);
  const personalArchive = asRecord(baseInfo.personal_archive);
  const resumeArchiveLegacy = asRecord(personalArchive.resumeArchive);
  const applicationArchiveLegacy = asRecord(personalArchive.applicationArchive);
  const resumeBasic = asRecord(resumeArchiveLegacy.basicInfo);

  if (Object.keys(resumeArchiveLegacy).length > 0) {
    return {
      profileVersion: asString(personalArchive.schemaVersion || "legacy"),
      basicRaw: {
        fullName: resumeBasic.name || baseInfo.name || profile.name || "",
        phone: resumeBasic.phone || baseInfo.phone || profile.phone || "",
        email: resumeBasic.email || baseInfo.email || profile.email || "",
        city: resumeBasic.currentCity || baseInfo.current_city || "",
        targetRole: resumeBasic.jobIntention || baseInfo.job_intention || "",
        website: resumeBasic.website || baseInfo.website || "",
        github: resumeBasic.github || baseInfo.github || "",
        linkedin: resumeBasic.linkedin || baseInfo.linkedin || "",
        summary: resumeArchiveLegacy.personalSummary || baseInfo.personal_summary || baseInfo.summary || profile.headline || "",
      },
      resumeArchiveRaw: resumeArchiveLegacy,
      applicationArchiveRaw: applicationArchiveLegacy,
      syncSettingsRaw: asRecord(personalArchive.syncSettings),
      sectionsRaw: asArray(profile.sections),
    };
  }

  if (hasDirect) {
    return {
      profileVersion: asString(profile.profileVersion || "normalized"),
      basicRaw: basicDirect,
      resumeArchiveRaw: resumeDirect,
      applicationArchiveRaw: appDirect,
      syncSettingsRaw: syncDirect,
      sectionsRaw: asArray(profile.sections),
    };
  }

  return {
    profileVersion: asString(profile.profileVersion || personalArchive.schemaVersion || "legacy"),
    basicRaw: {
      fullName: asString(profile.name || baseInfo.name),
      phone: asString(profile.phone || baseInfo.phone),
      email: asString(profile.email || baseInfo.email),
      city: asString(profile.current_city || baseInfo.current_city),
      targetRole: asString(profile.job_intention || baseInfo.job_intention),
      website: asString(profile.website || baseInfo.website),
      github: asString(profile.github || baseInfo.github),
      linkedin: asString(profile.linkedin || baseInfo.linkedin),
      summary: asString(profile.personal_summary || baseInfo.personal_summary || profile.summary || profile.headline),
    },
    resumeArchiveRaw: {},
    applicationArchiveRaw: {},
    syncSettingsRaw: syncDirect,
    sectionsRaw: asArray(profile.sections),
  };
}

export function normalizeSmartFillProfile(rawProfile: unknown): SmartFillProfileNormalized {
  const resolved = pickArchiveFromProfile(rawProfile);
  const resumeArchive = asRecord(resolved.resumeArchiveRaw);
  const applicationArchive = asRecord(resolved.applicationArchiveRaw);
  const identity = asRecord(resolved.applicationArchiveRaw.identityContact);
  const jobPreference = asRecord(resolved.applicationArchiveRaw.jobPreference);
  const shared = asRecord(applicationArchive.shared);
  const campusFields = asRecord(applicationArchive.campusFields);
  const relationshipCompliance = asRecord(applicationArchive.relationshipCompliance);
  const sourceReferral = asRecord(applicationArchive.sourceReferral);
  const attachments = asRecord(applicationArchive.attachments);

  const basic = {
    fullName: asString(resolved.basicRaw.fullName || identity.chineseName),
    phone: asString(resolved.basicRaw.phone || identity.phone),
    email: asString(resolved.basicRaw.email || identity.email),
    city: asString(resolved.basicRaw.city || identity.currentCity),
    targetRole: asString(resolved.basicRaw.targetRole || jobPreference.expectedPosition),
    website: asString(resolved.basicRaw.website),
    github: asString(resolved.basicRaw.github),
    linkedin: asString(resolved.basicRaw.linkedin),
    summary: asString(resolved.basicRaw.summary || resolved.resumeArchiveRaw.personalSummary),
  };

  const archiveAwardCandidates = [
    "awards",
    "awardExperiences",
    "awardExperience",
    "honors",
    "honourAwards",
    "获奖经历",
  ];
  let normalizedAwards: unknown[] = [];
  const resumeAwardSource = pickFirstArray(resumeArchive, archiveAwardCandidates);
  const parsedResumeAwards = normalizeAwards(resumeAwardSource);
  if (parsedResumeAwards.length > 0) {
    normalizedAwards = parsedResumeAwards;
  }
  if (normalizedAwards.length === 0) {
    const sharedArchive = asRecord(applicationArchive.shared);
    const sharedAwardSource = pickFirstArray(sharedArchive, archiveAwardCandidates);
    const parsedSharedAwards = normalizeAwards(sharedAwardSource);
    if (parsedSharedAwards.length > 0) {
      normalizedAwards = parsedSharedAwards;
    }
  }
  if (normalizedAwards.length === 0) {
    normalizedAwards = extractAwardsFromSections(resolved.sectionsRaw);
  }

  return {
    profileVersion: resolved.profileVersion || "legacy",
    basic,
    resumeArchive: {
      personalSummary: asString(resumeArchive.personalSummary || basic.summary),
      education: asArray(resumeArchive.education),
      workExperiences: asArray(resumeArchive.workExperiences),
      internshipExperiences: asArray(resumeArchive.internshipExperiences),
      projects: asArray(resumeArchive.projects),
      skills: asArray(resumeArchive.skills),
      certificates: asArray(resumeArchive.certificates),
      awards: normalizedAwards,
      personalExperiences: asArray(resumeArchive.personalExperiences),
    },
    applicationArchive: {
      shared,
      identityContact: identity,
      jobPreference,
      campusFields,
      relationshipCompliance,
      sourceReferral,
      attachments,
    },
    syncSettings: resolved.syncSettingsRaw,
    sections: resolved.sectionsRaw,
  };
}

export function countSmartFillAvailableFields(profile: SmartFillProfileNormalized): number {
  let count = 0;
  const basicValues = [
    profile.basic.fullName,
    profile.basic.phone,
    profile.basic.email,
    profile.basic.city,
    profile.basic.targetRole,
    profile.basic.website,
    profile.basic.github,
    profile.basic.linkedin,
    profile.basic.summary,
  ];
  for (const value of basicValues) {
    if (String(value || "").trim()) count += 1;
  }

  if (profile.resumeArchive.personalSummary.trim()) count += 1;
  if (compactText(profile.resumeArchive.education).trim()) count += 1;
  if (compactText(profile.resumeArchive.workExperiences).trim()) count += 1;
  if (compactText(profile.resumeArchive.internshipExperiences).trim()) count += 1;
  if (compactText(profile.resumeArchive.projects).trim()) count += 1;
  if (compactText(profile.resumeArchive.skills).trim()) count += 1;
  if (compactText(profile.resumeArchive.certificates).trim()) count += 1;
  if (compactText(profile.resumeArchive.awards).trim()) count += 1;
  if (compactText(profile.resumeArchive.personalExperiences).trim()) count += 1;
  if (compactText(profile.applicationArchive.shared).trim()) count += 1;
  if (compactText(profile.applicationArchive.identityContact).trim()) count += 1;
  if (compactText(profile.applicationArchive.jobPreference).trim()) count += 1;
  if (compactText(profile.applicationArchive.campusFields).trim()) count += 1;
  if (compactText(profile.applicationArchive.relationshipCompliance).trim()) count += 1;
  if (compactText(profile.applicationArchive.sourceReferral).trim()) count += 1;
  if (compactText(profile.applicationArchive.attachments).trim()) count += 1;
  return count;
}

export function buildSmartFillProfileFieldValues(
  profile: SmartFillProfileNormalized,
): SmartFillProfileFieldValue[] {
  const values: SmartFillProfileFieldValue[] = [
    enrichFieldValue({ key: "basic.fullName", path: "basic.fullName", label: "姓名", value: profile.basic.fullName, category: "基本信息", aliases: ["姓名", "真实姓名"], valueType: "text" }),
    enrichFieldValue({ key: "basic.phone", path: "basic.phone", label: "手机号", value: profile.basic.phone, category: "基本信息", aliases: ["手机号", "手机号码", "联系电话"], valueType: "phone" }),
    enrichFieldValue({ key: "basic.email", path: "basic.email", label: "邮箱", value: profile.basic.email, category: "基本信息", aliases: ["邮箱", "电子邮箱"], valueType: "email" }),
    enrichFieldValue({ key: "basic.city", path: "basic.city", label: "所在城市", value: profile.basic.city, category: "基本信息", aliases: ["所在城市", "现居住城市"] }),
    enrichFieldValue({ key: "basic.website", path: "basic.website", label: "个人网站", value: profile.basic.website, category: "基本信息", aliases: ["个人网站", "主页"], valueType: "url" }),
    enrichFieldValue({ key: "basic.github", path: "basic.github", label: "GitHub", value: profile.basic.github, category: "基本信息", aliases: ["GitHub", "代码仓库"], valueType: "url" }),
    enrichFieldValue({ key: "basic.linkedin", path: "basic.linkedin", label: "LinkedIn", value: profile.basic.linkedin || "", category: "基本信息", aliases: ["LinkedIn", "领英"], valueType: "url" }),
    enrichFieldValue({ key: "basic.targetRole", path: "basic.targetRole", label: "目标岗位", value: profile.basic.targetRole, category: "求职意向", aliases: ["目标岗位", "期望职位"] }),
    enrichFieldValue({ key: "resumeArchive.personalSummary", path: "resumeArchive.personalSummary", label: "个人简介", value: profile.resumeArchive.personalSummary, category: "其他信息", aliases: ["个人简介", "自我评价"], valueType: "long-text" }),
    enrichFieldValue({
      key: "applicationArchive.shared",
      path: "applicationArchive.shared",
      label: "投递档案-共享简历",
      value: compactText(profile.applicationArchive.shared),
    }),
    enrichFieldValue({
      key: "applicationArchive.identityContact",
      path: "applicationArchive.identityContact",
      label: "投递档案-身份联系",
      value: compactText(profile.applicationArchive.identityContact),
    }),
    enrichFieldValue({
      key: "applicationArchive.jobPreference",
      path: "applicationArchive.jobPreference",
      label: "投递档案-求职偏好",
      value: compactText(profile.applicationArchive.jobPreference),
    }),
    enrichFieldValue({
      key: "applicationArchive.campusFields",
      path: "applicationArchive.campusFields",
      label: "投递档案-校招专项",
      value: compactText(profile.applicationArchive.campusFields),
    }),
    enrichFieldValue({
      key: "applicationArchive.relationshipCompliance",
      path: "applicationArchive.relationshipCompliance",
      label: "投递档案-关系与合规",
      value: compactText(profile.applicationArchive.relationshipCompliance),
    }),
    enrichFieldValue({
      key: "applicationArchive.sourceReferral",
      path: "applicationArchive.sourceReferral",
      label: "投递档案-来源与推荐",
      value: compactText(profile.applicationArchive.sourceReferral),
    }),
    enrichFieldValue({
      key: "applicationArchive.attachments",
      path: "applicationArchive.attachments",
      label: "投递档案-附件",
      value: compactText(profile.applicationArchive.attachments),
    }),
  ];

  pushArchiveItemValues(values, "resumeArchive.education", "教育经历", profile.resumeArchive.education);
  pushArchiveItemValues(values, "resumeArchive.workExperiences", "工作经历", profile.resumeArchive.workExperiences);
  pushArchiveItemValues(values, "resumeArchive.internshipExperiences", "实习经历", profile.resumeArchive.internshipExperiences);
  pushArchiveItemValues(values, "resumeArchive.projects", "项目经历", profile.resumeArchive.projects);
  pushArchiveItemValues(values, "resumeArchive.skills", "技能", profile.resumeArchive.skills);
  pushArchiveItemValues(values, "resumeArchive.certificates", "证书", profile.resumeArchive.certificates);
  pushArchiveItemValues(values, "resumeArchive.awards", "获奖经历", profile.resumeArchive.awards);
  pushArchiveItemValues(values, "resumeArchive.personalExperiences", "个人经历", profile.resumeArchive.personalExperiences);

  return values.filter((item) => item.value.trim().length > 0);
}
