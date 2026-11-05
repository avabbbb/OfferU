import { type Memory, type Profile } from "@/lib/core";
import { emptyItem, emptySection, type Resume, type ResumeItem, type SectionType } from "@/lib/resumeModel";

// 全职/兼职进「工作经历」，实习和没标性质的进「实习经历」（没标的沿用旧行为）。
const isJob = (m: Memory) => m.kind === "experience" && (m.mode === "全职" || m.mode === "兼职");

const SECTIONS: Array<[SectionType, (m: Memory) => boolean]> = [
  ["education", (m) => m.kind === "education"],
  ["work", isJob],
  ["internship", (m) => m.kind === "experience" && !isJob(m)],
  ["project", (m) => m.kind === "project"],
  ["awards", (m) => m.kind === "award"],
  ["skills", (m) => m.kind === "skill"],
];

const points = (body?: string) => (body ?? "").split(/\n+/).map((x) => x.replace(/^[-•·\s]+/, "").trim()).filter(Boolean);

// 一条档案经历 → 简历条目：标题里的「公司 | 职位」拆成标题和副标题，正文按行变要点；教育的全日制/非全日制写进副标题。
function itemOf(m: Memory): ResumeItem {
  const [title = "", subtitle = ""] = (m.title ?? "").split(/\s{0,}\|\s{0,}/);
  const sub = m.kind === "education" && m.mode && !subtitle.includes(m.mode) ? [subtitle, m.mode].filter(Boolean).join(" · ") : subtitle;
  return { ...emptyItem(), title, subtitle: sub, date: [m.start, m.end].filter(Boolean).join(" – "), bullets: points(m.body) };
}

// 从档案拼出第一版结构化简历，不调用 AI：之后用户自己改，或者让 Agent 按岗位改。
export function resumeFromProfile(profile: Profile, memories: Memory[]): Resume {
  const sections = [];
  if (profile.school && !memories.some((m) => m.kind === "education")) {
    sections.push({
      ...emptySection("education"),
      items: [{ ...emptyItem(), title: profile.school, subtitle: [profile.major, profile.degree].filter(Boolean).join(" · "), date: profile.grad_year ? profile.grad_year + " 届" : "" }],
    });
  }
  for (const [type, match] of SECTIONS) {
    const found = memories.filter(match);
    if (!found.length) continue;
    const items = type === "skills"
      ? [{ ...emptyItem(), bullets: found.map((m) => [m.title, m.body].filter(Boolean).join("：")) }]
      : found.map(itemOf);
    sections.push({ ...emptySection(type), items });
  }
  return {
    version: 1,
    basics: { name: profile.name ?? "", target: profile.target ?? "", contacts: ([["电话", profile.phone], ["邮箱", profile.email], ["城市", profile.city]] as Array<[string, unknown]>)
      .filter(([, value]) => typeof value === "string" && value !== "").map(([label, value]) => ({ label, value: String(value) })) },
    sections,
  };
}
