import { describe, expect, it } from "vitest";

import { type Memory } from "@/lib/core";
import { resumeFromProfile } from "@/lib/resumeDraft";

const m = (kind: Memory["kind"], title: string, body = "", start = "", end = "") =>
  ({ id: 1, type: "memory", job_id: null, created_at: "", updated_at: "", kind, title, body, start, end }) as Memory;

describe("resumeFromProfile", () => {
  it("turns the profile into a structured resume", () => {
    const r = resumeFromProfile({ name: "李四", phone: "138", email: "a@b.c", target: "后端开发", school: "浙江大学" }, [
      m("experience", "字节跳动 | 后端实习生", "- 接口延迟 120ms → 40ms\n- 写了压测脚本", "2024.06", "2024.09"),
      m("skill", "语言", "Go、Python"),
    ]);
    expect(r.basics).toEqual({ name: "李四", target: "后端开发", contacts: ["138", "a@b.c"] });
    expect(r.sections.map((s) => s.type)).toEqual(["education", "internship", "skills"]);
    expect(r.sections[0].items[0].title).toBe("浙江大学");
    expect(r.sections[1].items[0]).toMatchObject({
      title: "字节跳动", subtitle: "后端实习生", date: "2024.06 – 2024.09", bullets: ["接口延迟 120ms → 40ms", "写了压测脚本"],
    });
    expect(r.sections[2].items[0].bullets).toEqual(["语言：Go、Python"]);
  });
});
