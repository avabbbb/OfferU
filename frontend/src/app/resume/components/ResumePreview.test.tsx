import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import ResumePreview from "./ResumePreview";

describe("resume preview fidelity", () => {
  it("retains local images, rich text, date columns and content-only sections", () => {
    const { container } = render(<ResumePreview userName="测试" photoUrl="/uploads/photos/photo.png" summary="" contactJson={{ schoolLogoUrl: "/uploads/logos/logo.png" }} styleConfig={{ template: "reference", accentColorHex: "#7c3aed" }} sections={[
      { id: 1, section_type: "workExperiences", title: "工作经历", visible: true, sort_order: 0, content_json: [{ company: "公司", position: "产品经理", startDate: "2024年", endDate: "至今", description: "<p><strong>成果</strong></p><ul><li>保留列表</li></ul>" }] },
      { id: 2, section_type: "custom", title: "总结", visible: true, sort_order: 1, content_json: [{ experienceTitle: "", description: "<p><strong>保留正文</strong></p>" }] },
    ]} />);
    expect(Array.from(container.querySelectorAll("img"), (img) => img.src)).toEqual(["http://127.0.0.1:8766/uploads/photos/photo.png", "http://127.0.0.1:8766/uploads/logos/logo.png"]);
    expect(container.querySelector(".reference-date")?.textContent).toBe("2024年 - 至今");
    expect(container.querySelectorAll(".reference-rich strong")).toHaveLength(2);
    expect(container.querySelectorAll(".reference-rich li")).toHaveLength(1);
    expect(container.querySelectorAll(".reference-item-row")).toHaveLength(1);
    expect(container.querySelector<HTMLElement>(".resume-body")?.style.getPropertyValue("--resume-accent-primary")).toBe("#7c3aed");
  });
});
