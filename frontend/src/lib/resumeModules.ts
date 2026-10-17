/**
 * 简历可添加的预设模块。用户只能从这里选（不能凭空建新类型），
 * 这样纸模板知道每种模块怎么排、AI 改写也认得它们。
 */
export const RESUME_MODULE_PRESETS = [
  ["education", "教育背景"],
  ["internshipExperiences", "实习经历"],
  ["workExperiences", "工作经历"],
  ["projects", "项目经历"],
  ["campusExperiences", "校园经历"],
  ["skills", "专业技能"],
  ["languages", "语言能力"],
  ["certificates", "证书"],
  ["awards", "荣誉奖项"],
  ["portfolio", "作品集"],
  ["personalExperiences", "个人经历"],
  ["interests", "兴趣爱好"],
] as const;

/** 历史数据里的别名 → 预设类型，用来判断「这个模块已经有了」。 */
export function moduleType(type: string): string {
  return ({
    experience: "workExperiences",
    project: "projects",
    skill: "skills",
    certificate: "certificates",
    custom: "personalExperiences",
  } as Record<string, string>)[type] || type;
}

export function missingModules(sections: Array<{ section_type: string }>) {
  const present = new Set(sections.map((section) => moduleType(section.section_type)));
  return RESUME_MODULE_PRESETS.filter(([type]) => !present.has(type));
}
