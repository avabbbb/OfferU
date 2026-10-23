import { describe, expect, it } from "vitest";

import { type Memory } from "@/lib/core";
import { resumeFromProfile } from "@/lib/resumeDraft";

const m = (kind: Memory["kind"], title: string, body = "", start = "", end = "") =>
  ({ id: 1, type: "memory", job_id: null, created_at: "", updated_at: "", kind, title, body, start, end }) as Memory;

describe("resumeFromProfile", () => {
  it("turns the profile into the resume Markdown the templates style", () => {
    const md = resumeFromProfile({ name: "李四", phone: "138", email: "a@b.c", target: "后端开发" }, [
      m("experience", "字节跳动 | 后端实习生", "- 接口延迟 120ms → 40ms\n- 写了压测脚本", "2024.06", "2024.09"),
      m("skill", "语言", "Go、Python"),
    ]);
    expect(md).toContain("# 李四\n138 · a@b.c · 求职意向：后端开发");
    expect(md).toContain("### 字节跳动 | 后端实习生 | 2024.06 – 2024.09\n- 接口延迟 120ms → 40ms\n- 写了压测脚本");
    expect(md).toContain("## 技能\n- 语言：Go、Python");
  });
});

describe("tidy", () => {
  it("drops the empty paragraphs Enter leaves behind", async () => {
    const { tidy } = await import("@/components/core/ResumeEditor");
    expect(tidy("- a\n\n\n\n&nbsp;\n\n## 技能\n\n- Go\n\n")).toBe("- a\n\n## 技能\n\n- Go\n");
  });
});
