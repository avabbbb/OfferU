import { describe, expect, it } from "vitest";
import { quickActionsForStage } from "./quickActions";

describe("quickActionsForStage (H-1)", () => {
  it("never shows campus actions to experienced users", () => {
    const labels = quickActionsForStage("experienced").map((item) => item.label);
    expect(labels).not.toContain("校招体检");
    expect(quickActionsForStage("experienced").some((item) => item.prompt.includes("校招"))).toBe(false);
  });

  it("asks for the stage first when it is unknown", () => {
    expect(quickActionsForStage("unknown")[0].skillId).toBe("profile_onboarding");
    expect(quickActionsForStage(undefined)[0].skillId).toBe("profile_onboarding");
  });

  it("does not re-ask the stage once it is known", () => {
    for (const stage of ["campus", "experienced"]) {
      expect(quickActionsForStage(stage).some((item) => item.skillId === "profile_onboarding")).toBe(false);
    }
  });
});
