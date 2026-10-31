// doc.resume 的前端镜像：字段和 backend/app/core/resume_model.py（normalize）一致。
// 左侧表单只改这棵树；预览把整棵树交给 POST /api/resume/render，保存时传 data.resume，body 由后端派生。

export const SECTION_TYPES = ["education", "work", "internship", "project", "campus", "skills", "awards", "summary", "custom"] as const;
export type SectionType = (typeof SECTION_TYPES)[number];

export const SECTION_LABEL: Record<SectionType, string> = {
  education: "教育经历", work: "工作经历", internship: "实习经历", project: "项目经历", campus: "校园经历",
  skills: "技能证书", awards: "荣誉奖项", summary: "个人总结", custom: "自定义模块",
};

// 每类模块的条目表单怎么叫这几个字段（超级简历式：公司名称 / 职位名称 / 城市 / 时间）。
export const ITEM_FIELDS: Record<SectionType, { title: string; subtitle: string; location: string; date: string } | null> = {
  education: { title: "学校", subtitle: "专业 · 学历", location: "城市", date: "时间" },
  work: { title: "公司名称", subtitle: "职位名称", location: "所在城市", date: "工作时间" },
  internship: { title: "公司名称", subtitle: "职位名称", location: "所在城市", date: "实习时间" },
  project: { title: "项目名称", subtitle: "担任角色", location: "", date: "项目时间" },
  campus: { title: "组织 / 活动", subtitle: "担任角色", location: "", date: "时间" },
  awards: { title: "奖项名称", subtitle: "级别", location: "", date: "获奖时间" },
  skills: null,
  summary: null,
  custom: { title: "标题", subtitle: "副标题", location: "", date: "时间" },
};

export type ResumeItem = { id: string; title: string; subtitle: string; date: string; location: string; bullets: string[]; text: string };
export type ResumeSection = { id: string; type: SectionType; title: string; hidden: boolean; items: ResumeItem[] };
export type ResumeBasics = { name: string; target: string; contacts: string[] };
export type Resume = { version: 1; basics: ResumeBasics; sections: ResumeSection[] };

export const newId = () => Math.random().toString(16).slice(2, 10).padEnd(8, "0");

export const emptyItem = (): ResumeItem => ({ id: newId(), title: "", subtitle: "", date: "", location: "", bullets: [], text: "" });

export const emptySection = (type: SectionType): ResumeSection => ({
  id: newId(), type, title: SECTION_LABEL[type], hidden: false, items: [emptyItem()],
});

export const emptyResume = (): Resume => ({
  version: 1,
  basics: { name: "", target: "", contacts: [] },
  sections: (["education", "internship", "project", "skills"] as SectionType[]).map(emptySection),
});

const text = (v: unknown) => (v === null || v === undefined ? "" : String(v));

/** 后端给的 resume 补齐缺的字段（老数据、agent 写的都可能缺）。 */
export function normalizeResume(raw: unknown): Resume {
  if (!raw || typeof raw !== "object") return emptyResume();
  const r = raw as Partial<Resume>;
  const b = (r.basics ?? {}) as Partial<ResumeBasics>;
  return {
    version: 1,
    basics: { name: text(b.name), target: text(b.target), contacts: Array.isArray(b.contacts) ? b.contacts.map(text) : [] },
    sections: (Array.isArray(r.sections) ? r.sections : []).map((s) => ({
      id: s.id || newId(),
      type: (SECTION_TYPES as readonly string[]).includes(s.type) ? s.type : "custom",
      title: text(s.title),
      hidden: Boolean(s.hidden),
      items: (Array.isArray(s.items) ? s.items : []).map((it) => ({
        id: it.id || newId(),
        title: text(it.title), subtitle: text(it.subtitle), date: text(it.date), location: text(it.location),
        bullets: Array.isArray(it.bullets) ? it.bullets.map(text) : [],
        text: text(it.text),
      })),
    })),
  };
}

/** 把数组里第 from 个挪到 to（越界不动）。模块、条目、要点排序共用。 */
export function move<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list;
  const next = list.slice();
  const [picked] = next.splice(from, 1);
  next.splice(to, 0, picked);
  return next;
}

export const updateSection = (resume: Resume, id: string, patch: (s: ResumeSection) => ResumeSection): Resume => ({
  ...resume, sections: resume.sections.map((s) => (s.id === id ? patch(s) : s)),
});

export const updateItem = (resume: Resume, sectionId: string, itemId: string, patch: Partial<ResumeItem>): Resume =>
  updateSection(resume, sectionId, (s) => ({ ...s, items: s.items.map((it) => (it.id === itemId ? { ...it, ...patch } : it)) }));

/** 预览里点到的 data-path（如 sections.1.items.0.bullets.2）→ 左边要展开、滚到的模块 / 条目 id。 */
export function locatePath(resume: Resume, path: string): { sectionId?: string; itemId?: string; basics?: boolean } {
  const parts = path.split(".");
  if (parts[0] === "basics") return { basics: true };
  if (parts[0] !== "sections") return {};
  const section = resume.sections[Number(parts[1])];
  if (!section) return {};
  const item = parts[2] === "items" ? section.items[Number(parts[3])] : undefined;
  return { sectionId: section.id, itemId: item?.id };
}
