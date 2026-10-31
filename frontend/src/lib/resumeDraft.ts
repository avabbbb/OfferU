import { type Memory, type Profile } from "@/lib/core";
import { emptyItem, emptySection, type Resume, type ResumeItem, type SectionType } from "@/lib/resumeModel";

const SECTIONS: Array<[Memory["kind"], SectionType]> = [
  ["education", "education"], ["experience", "internship"], ["project", "project"], ["award", "awards"], ["skill", "skills"],
];

const points = (body?: string) => (body ?? "").split(/\n+/).map((x) => x.replace(/^[-•·\s]+/, "").trim()).filter(Boolean);

// 一条档案经历 → 简历条目：标题里的「公司 | 职位」拆成标题和副标题，正文按行变要点。
function itemOf(m: Memory): ResumeItem {
  const [title = "", subtitle = ""] = (m.title ?? "").split(/\s{0,}\|\s{0,}/);
  return { ...emptyItem(), title, subtitle, date: [m.start, m.end].filter(Boolean).join(" – "), bullets: points(m.body) };
}

/** 从档案拼出第一版结构化简历，不调用 AI：之后用户自己改，或者让 Agent 按岗位改。 */
export function resumeFromProfile(profile: Profile, memories: Memory[]): Resume {
  const sections = [];
  if (profile.school && !memories.some((m) => m.kind === "education")) {
    sections.push({
      ...emptySection("education"),
      items: [{ ...emptyItem(), title: profile.school, subtitle: [profile.major, profile.degree].filter(Boolean).join(" · "), date: profile.grad_year ? profile.grad_year + " 届" : "" }],
    });
  }
  for (const [kind, type] of SECTIONS) {
    const found = memories.filter((m) => m.kind === kind);
    if (!found.length) continue;
    const items = type === "skills"
      ? [{ ...emptyItem(), bullets: found.map((m) => [m.title, m.body].filter(Boolean).join("：")) }]
      : found.map(itemOf);
    sections.push({ ...emptySection(type), items });
  }
  return {
    version: 1,
    basics: { name: profile.name ?? "", target: profile.target ?? "", contacts: [profile.phone, profile.email, profile.city].filter((c): c is string => Boolean(c)) },
    sections,
  };
}
