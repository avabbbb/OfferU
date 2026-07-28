// Profile normalization - converts background SmartFillProfileNormalized to ProfileEntry[]
import type { NormalizedProfile, ProfileEntry, ProfileValueType } from "./types.js";
import { inferValueType } from "./catalog.js";
import { normalizeText } from "../shared/text-utils.js";

// English field keys → Chinese labels (critical for matching)
// Backend returns English keys like "schoolName", "startDate", "fullName"
// These must be mapped to Chinese labels to match form fields
const FIELD_KEY_TO_LABEL: Record<string, string> = {
  // Basic
  fullName: "姓名", name: "姓名", surname: "姓", givenName: "名", englishName: "英文名",
  phone: "手机号", mobile: "手机号", telephone: "电话", phoneNumber: "手机号",
  email: "邮箱", mail: "邮箱", emailAddress: "邮箱",
  gender: "性别", sex: "性别",
  birthDate: "出生日期", birthday: "出生日期", dateOfBirth: "出生日期",
  idNumber: "身份证号", idType: "证件类型", identityCard: "身份证",
  nationality: "国籍", ethnicity: "民族", nation: "民族",
  nativePlace: "籍贯", household: "户籍", householdRegistration: "户口所在地",
  politicalStatus: "政治面貌", maritalStatus: "婚姻状况",
  currentCity: "所在城市", city: "城市", address: "地址",
  height: "身高", weight: "体重", bloodType: "血型",
  hobby: "兴趣爱好", hobbies: "兴趣爱好",
  website: "个人网站", github: "GitHub", linkedin: "LinkedIn",
  qq: "QQ", wechat: "微信", wechatId: "微信号",
  targetRole: "目标岗位", expectedPosition: "期望职位",
  summary: "个人简介", selfEvaluation: "自我评价", personalSummary: "个人简介",
  photo: "照片",
  // Education
  schoolName: "学校名称", school: "学校名称", university: "毕业院校", college: "学院",
  major: "专业", specialty: "专业", majorName: "专业名称",
  degree: "学位", degreeName: "学位名称", educationLevel: "学历", highestEducation: "最高学历",
  gpa: "GPA", gpaScore: "绩点", gpaScale: "绩点满分",
  startDate: "开始时间", endDate: "结束时间", graduationDate: "毕业时间",
  educationType: "教育类型", studyMode: "学习形式", studyLength: "学制",
  departmentName: "院系", supervisor: "导师",
  classRank: "专业排名", studentId: "学号",
  relatedCourses: "相关课程", courses: "相关课程",
  // Work
  companyName: "公司名称", company: "公司", employer: "工作单位",
  jobTitle: "职位名称", position: "职位", positionName: "职位名称", role: "担任职务",
  workStartDate: "工作开始时间", workEndDate: "工作结束时间",
  industry: "行业", workCity: "工作城市", workLocation: "工作地点",
  department: "部门", department1: "部门", salary: "薪资", workDescription: "工作内容",
  leavingReason: "离职原因",
  // Internship
  internshipCompany: "实习公司", internshipPosition: "实习职位",
  internshipStartDate: "实习开始时间", internshipEndDate: "实习结束时间",
  // Project
  projectName: "项目名称", projectRole: "项目角色", projectLink: "项目链接", projectDate: "项目时间",
  projectDescription: "项目描述", projectContent: "项目内容",
  descriptions: "描述列表",
  // Awards/Certs/Languages
  awardName: "奖项名称", awardedAt: "获奖时间", awardDate: "获奖时间", awardIssuer: "颁奖单位",
  certificateName: "证书名称", certificateNumber: "证书编号", certificateDate: "证书获得时间",
  scoreOrLevel: "证书成绩/等级", acquiredAt: "获得时间", issuer: "颁发机构",
  languageName: "语言种类", languageType: "外语种类", proficiency: "掌握程度",
  score: "成绩", score1: "分数",
  // Skills / experiences / attachments
  skillName: "技能名称", experienceTitle: "经历名称", fileName: "附件名称",
  // Application archive
  chineseName: "中文姓名", englishOrPinyinName: "英文/拼音姓名", nationalityOrRegion: "国籍/地区",
  expectedCities: "期望城市", expectedSalary: "期望薪资",
  employmentType: "工作类型", availableStartDate: "到岗时间", currentJobSearchStatus: "求职状态",
  acceptAdjustment: "是否接受调剂", acceptBusinessTravel: "是否接受出差", acceptAssignment: "是否接受外派",
  acceptShiftWork: "是否接受倒班", isFreshGraduate: "是否应届生", studentOrigin: "生源地",
  studentStatus: "学生状态", majorRank: "专业排名", thesis: "论文题目", patent: "专利",
  researchExperiences: "科研经历", relation: "关系", contact: "联系电话",
  hasRelativeInTargetCompany: "是否有亲属在目标公司",
  emergencyContactName: "紧急联系人姓名", emergencyContactRelation: "紧急联系人关系",
  emergencyContactPhone: "紧急联系人电话", backgroundCheckAuthorization: "背调授权",
  hasNonCompete: "是否有竞业限制", healthDeclaration: "健康声明",
  sourceChannel: "来源渠道", referralCode: "内推码", referralName: "内推人姓名",
  referralEmployeeId: "内推人工号", referralContact: "内推人联系方式",
  recommenderInfo: "推荐信息", notes: "备注",
  // Family
  familyName: "家属姓名", familyRelation: "与本人关系", familyPhone: "家属电话",
  familyCompany: "家属工作单位", familyPosition: "家属职位",
  emergencyContact: "紧急联系人", emergencyPhone: "紧急联系人电话",
  // Other
  description: "描述", content: "内容", remark: "备注",
  attachmentName: "附件名称", resumeName: "简历名称",
};

// Known Chinese labels and their expansion aliases
const LABEL_ALIASES: Record<string, string[]> = {
  "姓名": ["真实姓名", "名字", "fullName", "候选人姓名"],
  "手机号": ["手机号码", "手机", "联系电话", "联系方式", "电话号码", "移动电话"],
  "邮箱": ["电子邮箱", "邮件", "email", "e-mail", "电子邮件"],
  "所在城市": ["城市", "现居住城市", "工作城市", "所在地区"],
  "目标岗位": ["期望职位", "应聘职位", "期望岗位", "求职意向"],
  "个人简介": ["自我评价", "个人介绍", "简介", "摘要", "summary"],
  "教育经历": ["教育背景", "学习经历"],
  "学校名称": ["学校全称", "毕业院校", "学校", "院校", "就读学校", "毕业学校", "所在院校"],
  "专业": ["专业名称", "所学专业", "就读专业"],
  "学历": ["最高学历", "学历层次", "教育程度", "文化程度"],
  "学位": ["学位名称", "授予学位"],
  "工作经历": ["工作经验", "工作背景", "从业经历"],
  "实习经历": ["实习经验", "实习背景"],
  "项目经历": ["项目经验", "项目背景"],
  "技能": ["技能特长", "专业技能", "技能水平"],
  "证书": ["资格证书", "认证", "执业资格"],
  "获奖经历": ["荣誉奖项", "获奖情况", "获奖"],
  "个人经历": ["校园经历", "社团经历", "社会实践"],
  "投递档案-共享简历": ["共享简历", "通用简历"],
  "投递档案-身份联系": ["身份信息", "联系方式"],
  "投递档案-求职偏好": ["求职偏好", "工作偏好"],
  "投递档案-校招专项": ["校招专项", "校园招聘"],
  "投递档案-关系与合规": ["关系合规", "亲属关系"],
  "投递档案-来源与推荐": ["内推", "推荐来源"],
  "投递档案-附件": ["附件", "简历附件"],
};

type SmartFillProfileNormalized = {
  basic: Record<string, string>;
  resumeArchive: Record<string, unknown>;
  applicationArchive: Record<string, Record<string, unknown>>;
};

function coerceString(v: unknown): string {
  if (typeof v === "string") return v.trim();
  if (typeof v === "number") return String(v);
  return "";
}

function compactText(v: unknown): string {
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    return v.map((item) => compactText(item))
      .filter((s) => s && !isJsonLikeString(s)).join("; ");
  }
  if (v && typeof v === "object") {
    return Object.values(v as Record<string, unknown>)
      .map((item) => compactText(item))
      .filter((s) => s && !isJsonLikeString(s)).join("; ");
  }
  return "";
}

function isJsonLikeString(s: string): boolean {
  const t = s.trim();
  return (t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"));
}

function buildEntryPath(parts: Array<string | number | undefined>): string {
  return parts
    .filter((part) => part !== undefined && part !== null && part !== "")
    .map((part) => String(part))
    .join(".");
}

function entryValueType(label: string, path: string, value: string): ProfileValueType {
  return inferValueType(label, path, value);
}

// Translate English field keys to Chinese labels using the mapping table
function translateLabel(key: string): string {
  // Direct match
  if (FIELD_KEY_TO_LABEL[key]) return FIELD_KEY_TO_LABEL[key];
  // Try lowercase
  const lower = key.toLowerCase();
  if (FIELD_KEY_TO_LABEL[lower]) return FIELD_KEY_TO_LABEL[lower];
  // Try camelCase to snake_case conversion and match
  const snake = lower.replace(/([A-Z])/g, "_$1").toLowerCase().replace(/^_/, "");
  if (FIELD_KEY_TO_LABEL[snake]) return FIELD_KEY_TO_LABEL[snake];
  // Return original key as-is (might already be Chinese)
  return key;
}

function buildAliases(label: string): string[] {
  const normalized = normalizeText(label);
  const found = LABEL_ALIASES[normalized] || [];
  const result = new Set<string>();
  result.add(normalized);
  result.add(normalized.replace(/\s+/g, ""));
  for (const alias of found) {
    result.add(normalizeText(alias));
    result.add(normalizeText(alias).replace(/\s+/g, ""));
  }
  return Array.from(result);
}

export function normalizeProfile(raw: unknown): NormalizedProfile {
  const entries: ProfileEntry[] = [];
  if (!raw || typeof raw !== "object") {
    return { profileVersion: "v1", entries, availableCount: 0 };
  }

  const obj = raw as Record<string, unknown>;
  let index = 0;

  // --- basic fields ---
  const basic = (obj.basic as Record<string, string>) || {};
  const basicFields: Array<[string, string]> = [
    ["fullName", "姓名"], ["phone", "手机号"], ["email", "邮箱"],
    ["city", "所在城市"], ["targetRole", "目标岗位"], ["website", "个人网站"],
    ["github", "GitHub"], ["linkedin", "LinkedIn"], ["summary", "个人简介"],
  ];
  for (const [key, label] of basicFields) {
    const value = coerceString(basic[key]);
    if (value) {
      const path = buildEntryPath(["basic", key]);
      entries.push({
        key: path,
        path,
        label,
        value,
        category: "基本信息",
        subsection: "",
        aliases: buildAliases(label),
        index: index++,
        valueType: entryValueType(label, path, value),
        sectionType: "basic",
        sourceRef: `基本信息/${label}`,
      });
    }
  }

  // --- resume archive ---
  const ra = (obj.resumeArchive as Record<string, unknown>) || {};
  if (ra.personalSummary) {
    const value = coerceString(ra.personalSummary);
    if (value && value !== coerceString(basic.summary)) {
      const path = "resumeArchive.personalSummary";
      entries.push({
        key: path,
        path,
        label: "个人简介",
        value,
        category: "其他信息",
        subsection: "",
        aliases: buildAliases("个人简介"),
        index: index++,
        valueType: entryValueType("个人简介", path, value),
        sectionType: "summary",
        sourceRef: "其他信息/个人简介",
      });
    }
  }

  // Context-aware label overrides for ambiguous field keys like "name", "description"
  const CATEGORY_KEY_OVERRIDES: Record<string, Record<string, string>> = {
    education: { name: "学校名称", description: "教育描述" },
    workExperiences: { name: "公司名称", description: "工作描述" },
    internshipExperiences: { name: "公司名称", description: "实习描述" },
    projects: { name: "项目名称", description: "项目描述" },
  };

  // Array sections with individual fields
  const raArrays: Array<[string, string]> = [
    ["education", "教育经历"],
    ["workExperiences", "工作经历"],
    ["internshipExperiences", "实习经历"],
    ["projects", "项目经历"],
  ];

  for (const [key, category] of raArrays) {
    const overrides = CATEGORY_KEY_OVERRIDES[key] || {};
    const arr = Array.isArray(ra[key]) ? ra[key] as Record<string, unknown>[] : [];
    for (let arrIdx = 0; arrIdx < arr.length; arrIdx++) {
      const item = arr[arrIdx];
      if (!item || typeof item !== "object") continue;
      // Extract individual key-value pairs, translating English keys to Chinese
      for (const [itemKey, itemVal] of Object.entries(item)) {
        const v = Array.isArray(itemVal) ? compactText(itemVal) : coerceString(itemVal);
        if (v && (typeof itemVal !== "object" || Array.isArray(itemVal))) {
          const label = overrides[itemKey] || translateLabel(itemKey);
          const path = buildEntryPath(["resumeArchive", key, arrIdx, itemKey]);
          entries.push({
            key: path,
            path,
            label, value: v, category,
            subsection: `第${arrIdx + 1}条`, aliases: buildAliases(label), index: index++, itemIndex: arrIdx + 1,
            valueType: entryValueType(label, path, v),
            sectionType: key,
            sourceRef: `${category}/第${arrIdx + 1}条/${label}`,
          });
        }
      }
    }
  }

  // Simple arrays
  const simpleArrays: Array<[string, string]> = [
    ["skills", "技能"], ["certificates", "证书"], ["awards", "获奖经历"], ["personalExperiences", "个人经历"],
  ];
  for (const [key, label] of simpleArrays) {
    const arr = Array.isArray(ra[key]) ? ra[key] as unknown[] : [];
    for (let arrIdx = 0; arrIdx < arr.length; arrIdx += 1) {
      const item = arr[arrIdx];
      if (typeof item === "string") {
        const v = item.trim();
          if (v) {
            const path = buildEntryPath(["resumeArchive", key, arrIdx]);
            entries.push({
              key: path,
              path,
              label,
              value: v,
              category: label,
              subsection: "",
              aliases: buildAliases(label),
              index: index++,
              itemIndex: arrIdx + 1,
              valueType: entryValueType(label, path, v),
              sectionType: key,
              sourceRef: `${label}/第${arrIdx + 1}条`,
            });
          }
      } else if (item && typeof item === "object") {
        for (const [itemKey, itemVal] of Object.entries(item as Record<string, unknown>)) {
          const v = Array.isArray(itemVal) ? compactText(itemVal) : coerceString(itemVal);
          if (v && (typeof itemVal !== "object" || Array.isArray(itemVal))) {
            const tl = translateLabel(itemKey);
            const path = buildEntryPath(["resumeArchive", key, arrIdx, itemKey]);
            entries.push({
              key: path,
              path,
              label: tl,
              value: v,
              category: label,
              subsection: `第${arrIdx + 1}条`,
              aliases: buildAliases(tl),
              index: index++,
              itemIndex: arrIdx + 1,
              valueType: entryValueType(tl, path, v),
              sectionType: key,
              sourceRef: `${label}/第${arrIdx + 1}条/${tl}`,
            });
          }
        }
      }
    }
  }

  // --- application archive ---
  const aa = (obj.applicationArchive as Record<string, Record<string, unknown>>) || {};
  const aaCategories: Record<string, string> = {
    shared: "共享信息", identityContact: "身份联系", jobPreference: "求职偏好",
    campusFields: "校招专项", relationshipCompliance: "关系合规",
    sourceReferral: "来源推荐", attachments: "附件",
  };
  for (const [key, cat] of Object.entries(aaCategories)) {
    const section = aa[key] || {};
    for (const [itemKey, itemVal] of Object.entries(section)) {
      const v = coerceString(itemVal);
      if (v) {
        const tl = translateLabel(itemKey);
        const path = buildEntryPath(["applicationArchive", key, itemKey]);
        entries.push({
          key: path,
          path,
          label: tl,
          value: v,
          category: cat,
          subsection: "",
          aliases: buildAliases(tl),
          index: index++,
          valueType: entryValueType(tl, path, v),
          sectionType: key,
          sourceRef: `${cat}/${tl}`,
        });
      }
    }
  }

  // --- sections data (from profile_schema.py standardized definitions) ---
  // Build dedup index to avoid duplicating entries already extracted from resumeArchive
  const existingKeys = new Set<string>();
  for (const e of entries) {
    existingKeys.add(`${e.category}::${e.label}`);
  }

  const sections = Array.isArray(obj.sections) ? (obj.sections as Record<string, unknown>[]) : [];
  for (const section of sections) {
    if (!section || typeof section !== "object") continue;
    const categoryLabel = asString(section.category_label || section.title || "");
    if (!categoryLabel) continue;

    const content = asRecord(section.content_json);
    const normalized = asRecord(content.normalized);

    // Skip empty normalized data
    if (Object.keys(normalized).length === 0) continue;

    // Extract each field, handling nested objects recursively
    flattenNormalizedFields(normalized, categoryLabel, "", 0);
  }

  function flattenNormalizedFields(
    obj: Record<string, unknown>,
    category: string,
    prefix: string,
    itemIndex: number,
  ): void {
    for (const [key, val] of Object.entries(obj)) {
      if (Array.isArray(val)) {
        val.forEach((item, arrayIndex) => {
          const nextIndex = arrayIndex + 1;
          const arrayPrefix = prefix ? `${prefix}_${key}` : key;
          if (item && typeof item === "object") {
            flattenNormalizedFields(item as Record<string, unknown>, category, arrayPrefix, nextIndex);
            return;
          }
          const v = coerceString(item);
          if (!v) return;
          const label = translateLabel(arrayPrefix);
          pushSectionEntry(category, label, v, nextIndex);
        });
        continue;
      }
      if (val && typeof val === "object" && !Array.isArray(val)) {
        // Recursively flatten nested objects (e.g., address: {province: "广东", city: "深圳"})
        const nestedPrefix = prefix ? `${prefix}_${key}` : key;
        flattenNormalizedFields(val as Record<string, unknown>, category, nestedPrefix, itemIndex);
        continue;
      }
      const v = coerceString(val);
      if (!v) continue;
      const rawLabel = prefix ? `${prefix}_${key}` : key;
      const label = translateLabel(rawLabel);
      pushSectionEntry(category, label, v, itemIndex);
    }
  }

  function pushSectionEntry(
    category: string,
    label: string,
    value: string,
    itemIndex: number,
  ): void {
    const dedupKey = `${category}::${itemIndex || 0}::${label}::${value}`;
    if (existingKeys.has(dedupKey)) return;
    existingKeys.add(dedupKey);
    entries.push({
      key: buildEntryPath(["sections", category, itemIndex || 0, label]),
      path: buildEntryPath(["sections", category, itemIndex || 0, label]),
      label,
      value,
      category,
      subsection: itemIndex > 0 ? `第${itemIndex}条` : "",
      aliases: buildAliases(label),
      index: index++,
      itemIndex: itemIndex || undefined,
      valueType: entryValueType(label, buildEntryPath(["sections", category, itemIndex || 0, label]), value),
      sectionType: category,
      sourceRef: `${category}${itemIndex > 0 ? `/第${itemIndex}条` : ""}/${label}`,
    });
  }

  return {
    profileVersion: obj.profileVersion as string || "v1",
    entries,
    availableCount: entries.length,
  };
}

function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

export function countAvailableFields(profile: NormalizedProfile): number {
  return profile.entries.filter((e) => e.value.length > 0).length;
}

export function buildFlatFieldEntries(
  profile: NormalizedProfile,
): Array<{ intent: string; value: string; index: number; key?: string; path?: string; category: string; subsection: string; itemIndex?: number; aliases: string[]; valueType?: ProfileValueType }> {
  return profile.entries.map((e) => ({
    intent: e.label,
    value: e.value,
    index: e.index,
    key: e.key,
    path: e.path,
    category: e.category,
    subsection: e.subsection,
    itemIndex: e.itemIndex,
    aliases: e.aliases,
    valueType: e.valueType,
  }));
}

export function buildProfileSignature(profile: NormalizedProfile): string {
  return profile.entries
    .map((e) => `${e.category}:${e.label}=${e.value.slice(0, 20)}`)
    .sort()
    .join("|")
    .slice(0, 200);
}
