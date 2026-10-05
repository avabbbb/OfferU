import copy

import pytest

from app.services.proposal_plan_builder import PlanValidationError, build_plan, canonical_digest, revise_plan, verify_plan_snapshot


def resume_plan():
    intents = [{"id": str(index), "operation": "update_resume_section",
                "args": {"resume_id": 7, "section_id": index + 1, "update_data": {"visible": True}},
                "display": {"before": "old", "after": "new"}}
               for index in range(18)]
    groups = [{"id": str(group), "title": title, "rationale": "Verified role evidence",
               "node_ids": [str(index) for index in range(group * 6, (group + 1) * 6)]}
              for group, title in enumerate(["Structure", "Work experience", "Projects"])]
    return build_plan(intents, run_id="run_" + "a" * 16, title="Tailor resume", groups=groups)


def test_explicit_semantics_seal_eighteen_resume_operations_in_three_groups():
    plan = resume_plan()
    assert len(plan["groups"]) == 3
    assert sum(len(group["nodes"]) for group in plan["groups"]) == 18
    verify_plan_snapshot(plan)
    plan["groups"][0]["status"] = "approved"
    plan["groups"][0]["nodes"][0]["status"] = "completed"
    verify_plan_snapshot(plan)


def test_clean_reset_cannot_be_grouped_with_another_mutation():
    with pytest.raises(PlanValidationError, match="dedicated single-operation"):
        build_plan([
            {"id": "reset", "operation": "reset_local_business_data", "args": {}},
            {"id": "write", "operation": "update_profile", "args": {"profile_id": 1, "name": "Unreviewed"}},
        ], run_id="run_" + "a" * 16, title="Reset mixed with profile rewrite")


@pytest.mark.parametrize("field,value", [("args", {"resume_id": 9}), ("display", {"after": "forged"}), ("schema_digest", "forged"), ("source_versions", {"job:1": "changed"}), ("dependency_node_ids", ["missing"])])
def test_changed_authorization_material_is_rejected(field, value):
    plan = resume_plan()
    plan["groups"][0]["nodes"][0][field] = value
    with pytest.raises(PlanValidationError):
        verify_plan_snapshot(plan)


def test_non_json_and_nonfinite_digests_are_rejected():
    for value in (float("nan"), float("inf"), {1: "not a JSON key"}, {"set": {1, 2}}):
        with pytest.raises(PlanValidationError):
            canonical_digest(value)


def test_revision_preserves_history_and_rejects_execution():
    old = resume_plan()
    intent = {"operation": "update_resume_section", "args": {"resume_id": 7, "section_id": 1, "update_data": {"visible": False}}}
    revised = revise_plan(old, [intent], title="Revised")
    assert revised["parent_plan_id"] == old["id"]
    assert revised["revision"] == 2
    assert revised["id"] != old["id"]
    old["groups"][0]["nodes"][0]["status"] = "executing"
    with pytest.raises(PlanValidationError):
        revise_plan(old, [intent], title="Hide execution")


def test_dependency_cycle_fails_before_any_operation_executes():
    intents = [{"id": str(i), "operation": "get_job", "args": {"job_id": i + 1}} for i in range(2)]
    groups = [{"id": str(i), "title": str(i), "node_ids": [str(i)], "dependency_group_ids": [str(1 - i)]} for i in range(2)]
    with pytest.raises(PlanValidationError, match="cycle"):
        build_plan(intents, run_id="run_" + "a" * 16, title="Cycle", groups=groups)
