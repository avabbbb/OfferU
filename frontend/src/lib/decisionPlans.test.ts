import { describe, expect, it } from "vitest";

import {
  groupAdvisoryHints,
  isGroupActionable,
  isGroupRejectable,
  normalizeDecisionGroup,
} from "./decisionPlans";

const raw = (updates: Record<string, unknown> = {}) => ({
  group_id: "group_1",
  plan_id: "plan_1",
  title: "Keep role",
  status: "pending",
  interaction_state: "needs_user_review",
  reviewability: {
    status: "ready",
    reason_codes: [],
    advisory_codes: ["missing_evidence", "outside_skill_scope"],
    counts_as_user_decision: true,
  },
  nodes: [],
  ...updates,
});

describe("decision group gating", () => {
  it("treats a pending ready group as actionable and keeps advisories as hints", () => {
    const group = normalizeDecisionGroup(raw(), 0);
    expect(isGroupActionable(group)).toBe(true);
    expect(group.reviewability.advisory_codes).toEqual(["missing_evidence", "outside_skill_scope"]);
    expect(groupAdvisoryHints(group)).toEqual(["未附来源证据", "超出当前技能的常规范围"]);
  });

  it("does not hide a ready group because of its interaction projection", () => {
    const group = normalizeDecisionGroup(
      raw({ interaction_state: "system_recovering", reviewability: { status: "ready", reason_codes: [], counts_as_user_decision: false } }),
      0,
    );
    expect(isGroupActionable(group)).toBe(true);
    expect(groupAdvisoryHints(group)).toEqual([]);
  });

  it("keeps not-ready groups unapprovable but rejectable", () => {
    const group = normalizeDecisionGroup(
      raw({ reviewability: { status: "needs_preparation", reason_codes: ["source_changed_or_unavailable"] } }),
      0,
    );
    expect(isGroupActionable(group)).toBe(false);
    expect(isGroupRejectable(group)).toBe(true);
    expect(isGroupRejectable(normalizeDecisionGroup(raw({ status: "completed" }), 0))).toBe(false);
  });
});
