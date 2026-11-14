import { describe, expect, it } from "vitest";

import { emptyResume } from "@/lib/resumeModel";
import { addCustomModule, addModule, morePresets, reorderModules, removeModule, setHidden } from "@/lib/resumeModules";

describe("左栏模块管理", () => {
  it("更多模块只列还没加过的，加进来后就不再出现", () => {
    const resume = emptyResume(); // 教育、实习、项目、技能
    const more = morePresets(resume).map((p) => p.title);
    expect(more).toEqual(["工作经历", "校园经历", "荣誉奖项", "个人总结", "作品集", "科研经历"]);
    const { resume: next, section } = addModule(resume, morePresets(resume).find((p) => p.title === "作品集")!);
    expect(section).toMatchObject({ type: "custom", title: "作品集", hidden: false });
    expect(next.sections.at(-1)?.id).toBe(section.id);
    expect(morePresets(next).map((p) => p.title)).not.toContain("作品集");
  });

  it("自定义模块的名字不重复", () => {
    let resume = emptyResume();
    resume = addCustomModule(resume).resume;
    resume = addCustomModule(resume).resume;
    expect(resume.sections.slice(-2).map((s) => s.title)).toEqual(["自定义模块", "自定义模块 2"]);
  });

  it("开关只改 hidden，内容留着；删除才去掉", () => {
    const resume = emptyResume();
    const id = resume.sections[1].id;
    const hidden = setHidden(resume, id, true);
    expect(hidden.sections[1]).toMatchObject({ id, hidden: true, items: resume.sections[1].items });
    expect(removeModule(hidden, id).sections.map((s) => s.id)).not.toContain(id);
  });

  it("拖拽排序按 dnd-kit 的落点挪动", () => {
    const resume = emptyResume();
    const [a, b, c, d] = resume.sections.map((s) => s.id);
    expect(reorderModules(resume, a, c).sections.map((s) => s.id)).toEqual([b, c, a, d]);
    expect(reorderModules(resume, d, a).sections.map((s) => s.id)).toEqual([d, a, b, c]);
    expect(reorderModules(resume, a, "nope")).toBe(resume);
  });
});
