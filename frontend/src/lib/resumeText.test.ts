import { describe, expect, it } from "vitest";

import { normalizeResume } from "@/lib/resumeModel";
import { resumeToText } from "@/lib/resumeText";

describe("resumeToText", () => {
  it("去掉格式标记、跳过隐藏模块", () => {
    const resume = normalizeResume({
      basics: { name: "欧非秀", target: "数据分析", contacts: [{ label: "电话", value: "138" }, { label: "邮箱", value: "" }] },
      sections: [
        { title: "教育经历", type: "education", items: [{ title: "清华大学", subtitle: "公共卫生 · 硕士", date: "2021.09 – 2024.06", text: "**GPA** 3.87\n- ++核心++课程" }] },
        { title: "志愿服务", type: "campus", hidden: true, items: [{ title: "冬奥会" }] },
        { title: "实习经历", type: "internship", items: [{ title: "某公司", bullets: ["做了 *A*"] }] },
      ],
    });
    expect(resumeToText(resume)).toBe([
      "欧非秀", "电话：138", "求职意向：数据分析", "",
      "【教育经历】", "清华大学 | 公共卫生 · 硕士 | 2021.09 – 2024.06", "GPA 3.87", "· 核心课程", "",
      "【实习经历】", "某公司", "· 做了 A", "",
    ].join("\n"));
  });
});
