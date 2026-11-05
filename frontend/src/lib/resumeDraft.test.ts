import { describe, expect, it } from "vitest";

import { type Memory } from "@/lib/core";
import { resumeFromProfile } from "@/lib/resumeDraft";

describe("resumeFromProfile", () => {
  it("全职进工作经历，实习和没标性质的进实习经历，教育带上全日制", () => {
    const memories = [
      { id: 1, kind: "experience", title: "中国电信 | 产品推广经理", mode: "全职" },
      { id: 2, kind: "experience", title: "字节跳动 | 产品实习生", mode: "实习" },
      { id: 3, kind: "experience", title: "某公司 | 助理" },
      { id: 4, kind: "education", title: "华南师范大学 | 软件工程", mode: "全日制" },
    ] as unknown as Memory[];
    const resume = resumeFromProfile({}, memories);
    const titles = (type: string) => resume.sections.find((s) => s.type === type)?.items.map((i) => i.title);
    expect(titles("work")).toEqual(["中国电信"]);
    expect(titles("internship")).toEqual(["字节跳动", "某公司"]);
    expect(resume.sections.find((s) => s.type === "education")?.items[0].subtitle).toBe("软件工程 · 全日制");
  });
});
