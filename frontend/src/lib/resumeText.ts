// 简历 → 纯文本（「分享 · 复制为纯文本」：贴进网申表单、聊天框、邮件正文）。隐藏的模块不带，格式标记去掉。
import { contactText, type Resume } from "@/lib/resumeModel";
import { parseLine, plainText } from "@/lib/richMarkup";

export function resumeToText(resume: Resume): string {
  const out: string[] = [];
  const { name, target, contacts } = resume.basics;
  if (name.trim()) out.push(name.trim());
  const line = contacts.filter((c) => c.value.trim()).map(contactText).join(" | ");
  if (line) out.push(line);
  if (target.trim()) out.push("求职意向：" + target.trim());
  for (const section of resume.sections) {
    if (section.hidden) continue;
    out.push("", "【" + (section.title.trim() || "未命名模块") + "】");
    for (const item of section.items) {
      const head = [item.title, item.subtitle, item.location, item.date].map((s) => s.trim()).filter(Boolean).join(" | ");
      if (head) out.push(head);
      for (const raw of item.text.split("\n")) {
        const l = parseLine(raw);
        const text = plainText(l.text).trim();
        if (text) out.push("  ".repeat(l.indent) + (l.list ? "· " : "") + text);
      }
      for (const b of item.bullets) if (b.trim()) out.push("· " + plainText(b).trim());
    }
  }
  return out.join("\n").trim() + "\n";
}
