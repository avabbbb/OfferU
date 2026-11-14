// 左栏「我的模块 / 更多模块」的纯逻辑（参考 offershow 简历编辑器）：只改 doc.resume.sections 的顺序、hidden 和增删，
// 不加新字段——「我的模块」= 已有的模块（hidden 的开关是关的），「更多模块」= 还没加过的常用模块，开关一开就加进来。
import { emptySection, type Resume, type ResumeSection, SECTION_LABEL, type SectionType } from "@/lib/resumeModel";

/** 「更多模块」里的一项：内置类型，或一个带名字的自定义模块（如「作品集」）。 */
export type ModulePreset = { key: string; type: SectionType; title: string };

const BUILTIN: SectionType[] = ["education", "internship", "work", "project", "campus", "skills", "awards", "summary"];
const CUSTOM_PRESETS = ["作品集", "科研经历"];

export const MODULE_PRESETS: ModulePreset[] = [
  ...BUILTIN.map((type) => ({ key: type, type, title: SECTION_LABEL[type] })),
  ...CUSTOM_PRESETS.map((title) => ({ key: "custom:" + title, type: "custom" as const, title })),
];

const has = (resume: Resume, preset: ModulePreset) =>
  resume.sections.some((s) => (preset.type === "custom" ? s.type === "custom" && s.title.trim() === preset.title : s.type === preset.type));

/** 还没加进简历的常用模块，顺序固定。 */
export const morePresets = (resume: Resume): ModulePreset[] => MODULE_PRESETS.filter((p) => !has(resume, p));

/** 加一个模块到末尾（显示状态），返回新简历和新模块，调用方据此切到这个模块。 */
export function addModule(resume: Resume, preset: Pick<ModulePreset, "type" | "title">): { resume: Resume; section: ResumeSection } {
  const section = { ...emptySection(preset.type), title: preset.title };
  return { resume: { ...resume, sections: [...resume.sections, section] }, section };
}

/** 新的自定义模块：名字不和已有模块重复（自定义模块、自定义模块 2…）。 */
export function addCustomModule(resume: Resume): { resume: Resume; section: ResumeSection } {
  const base = SECTION_LABEL.custom;
  const titles = new Set(resume.sections.map((s) => s.title.trim()));
  let title = base;
  for (let n = 2; titles.has(title); n += 1) title = base + " " + n;
  return addModule(resume, { type: "custom", title });
}

export const setHidden = (resume: Resume, id: string, hidden: boolean): Resume => ({
  ...resume, sections: resume.sections.map((s) => (s.id === id ? { ...s, hidden } : s)),
});

export const removeModule = (resume: Resume, id: string): Resume => ({ ...resume, sections: resume.sections.filter((s) => s.id !== id) });

/** 拖拽排序：把 activeId 挪到 overId 的位置（dnd-kit 的 arrayMove 语义）。 */
export function reorderModules(resume: Resume, activeId: string, overId: string): Resume {
  const from = resume.sections.findIndex((s) => s.id === activeId);
  const to = resume.sections.findIndex((s) => s.id === overId);
  if (from < 0 || to < 0 || from === to) return resume;
  const sections = resume.sections.slice();
  const [picked] = sections.splice(from, 1);
  sections.splice(to, 0, picked);
  return { ...resume, sections };
}
