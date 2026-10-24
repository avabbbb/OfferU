import { type Memory, type Profile } from "@/lib/core";

const SECTIONS: Array<[Memory["kind"], string]> = [
  ["education", "教育经历"], ["experience", "实习经历"], ["project", "项目经历"], ["award", "获奖"], ["skill", "技能"],
];

const span = (m: Memory) => [m.start, m.end].filter(Boolean).join(" – ");

/** 从档案拼出第一版简历，不调用 AI：之后用户自己改，或者让 Agent 按岗位改。 */
export function resumeFromProfile(profile: Profile, memories: Memory[]): string {
  const contact = [profile.phone, profile.email, profile.city, profile.target && `求职意向：${profile.target}`].filter(Boolean).join(" · ");
  const lines = [`# ${profile.name || "你的名字"}`, contact || "电话 · 邮箱 · 城市", ""];
  if (profile.school && !memories.some((m) => m.kind === "education")) {
    lines.push("## 教育经历", `### ${[profile.school, [profile.major, profile.degree].filter(Boolean).join(" "), profile.grad_year && `${profile.grad_year} 届`].filter(Boolean).join(" | ")}`, "");
  }
  for (const [kind, heading] of SECTIONS) {
    const items = memories.filter((m) => m.kind === kind);
    if (!items.length) continue;
    lines.push(`## ${heading}`);
    for (const m of items) {
      if (kind === "skill" || kind === "award") {
        lines.push(`- ${[m.title, m.body].filter(Boolean).join("：")}`);
        continue;
      }
      lines.push(`### ${[m.title, span(m)].filter(Boolean).join(" | ")}`);
      for (const point of (m.body ?? "").split(/\n+/).map((x) => x.replace(/^[-•·\s]+/, "").trim()).filter(Boolean)) lines.push(`- ${point}`);
    }
    lines.push("");
  }
  return lines.join("\n").trim() + "\n";
}
