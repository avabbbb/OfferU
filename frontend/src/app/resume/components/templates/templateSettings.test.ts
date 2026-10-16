import { describe, expect, it } from "vitest";
import { normalizeTemplateSettings, settingsToCssVars } from "./templateSettings";

describe("纸模板排版数值", () => {
  it("keeps the user's exact values and turns them into CSS variables", () => {
    const settings = normalizeTemplateSettings({ accentColorHex: "#7c3aed", bodySize: "10.5", lineHeight: "1.17", sectionGap: "5.5", marginTop: "9" });
    expect(settingsToCssVars(settings)).toMatchObject({
      "--resume-accent-primary": "#7c3aed", "--font-size-base": "10.5pt", "--line-height": 1.17, "--section-gap": "5.5pt", "--margin-top": "9mm",
    });
  });

  it("supports Letter and rejects CSS injection", () => {
    const settings = normalizeTemplateSettings({ pageSize: "LETTER", accentColorHex: "red; background: url(https://example.com)" });
    expect(settingsToCssVars(settings)).toMatchObject({ "--page-width": "215.9mm", "--page-height": "279.4mm", "--resume-accent-primary": "#1B365D" });
  });
});
