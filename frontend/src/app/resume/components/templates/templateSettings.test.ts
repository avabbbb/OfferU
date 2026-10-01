import { describe, expect, it } from "vitest";
import { normalizeTemplateSettings, settingsToCssVars, styleConfigFromSettings } from "./templateSettings";

describe("precise resume design settings", () => {
  it("preserves the editor's custom color and fractional values despite older stored levels", () => {
    const settings = normalizeTemplateSettings({
      template: "reference", accentColorHex: "#7c3aed", accentColorName: "blue",
      bodySize: "10.5", fontSize: "5", lineHeight: "1.17", lineHeightLevel: "5",
      sectionGap: "5.5", sectionSpacing: "5", photoWidth: "24", logoWidth: "51",
    });
    expect(settingsToCssVars(settings)).toMatchObject({
      "--resume-accent-primary": "#7c3aed", "--font-size-base": "10.5pt",
      "--line-height": 1.17, "--section-gap": "5.5pt", "--photo-width": "24mm", "--logo-width": "51mm",
    });
    expect(normalizeTemplateSettings(styleConfigFromSettings(settings)).exact).toEqual(settings.exact);
  });

  it("converts legacy margins, supports Letter and rejects CSS injection", () => {
    const settings = normalizeTemplateSettings({ template: "modern", pageSize: "LETTER", pageMargin: "1cm", accentColorHex: "red; background: url(https://example.com)" });
    expect(settings.margins.left).toBe(10);
    expect(settingsToCssVars(settings)).toMatchObject({ "--page-width": "215.9mm", "--page-height": "279.4mm", "--resume-accent-primary": "#1D4ED8" });
  });
});
