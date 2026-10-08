from __future__ import annotations

import asyncio
from unittest.mock import patch

from app.services.agentic_interaction_policy import assess_group, project_current_sources, run_interaction_state


def _group(**overrides):
    value = {
        "id": "group_1",
        "status": "pending",
        "risk": "protected",
        "scope": "career_truth",
        "rationale": "Keep the proposal tied to verified evidence.",
        "source_versions": {"resume:1": "v1"},
        "display": {
            "before": {"summary": "Old"},
            "after": {"summary": "New"},
            "why": "The role prioritizes this verified experience.",
            "evidence_refs": ["resume:1/section:4"],
        },
        "nodes": [{"operation": "update_resume_section", "status": "pending", "source_versions": {"resume:1": "v1"}}],
    }
    value.update(overrides)
    return value


def test_complete_packet_is_user_review_and_external_effect_keeps_authorization_floor():
    review = assess_group(_group())
    authorize = assess_group(_group(risk="external", display={
        **_group()["display"], "interaction_outcome": "AUTO",
    }))

    assert review["reviewability"] == {
        "status": "ready", "reason_codes": [], "counts_as_user_decision": True,
    }
    assert review["interaction_state"] == "needs_user_review"
    assert authorize["interaction_state"] == "needs_user_authorization"
    assert authorize["reviewability"]["counts_as_user_decision"] is True


def test_incomplete_packet_is_warning_but_unknown_execution_still_blocks():
    incomplete = assess_group(_group(display={"before": "Old", "after": "New"}))
    uncertain = assess_group(_group(nodes=[{"operation": "update_resume_section", "status": "uncertain"}]))

    assert incomplete["reviewability"]["status"] == "ready"
    assert incomplete["reviewability"]["counts_as_user_decision"] is True
    assert {"missing_why", "missing_evidence"}.issubset(incomplete["reviewability"]["reason_codes"])
    assert incomplete["interaction_state"] == "needs_user_review"
    assert uncertain["reviewability"]["status"] == "needs_reconciliation"
    assert uncertain["interaction_state"] == "system_recovering"


def test_prepare_and_unbound_ask_always_have_a_user_exit():
    preparation = assess_group(_group(risk="prepare"))
    ask = assess_group(_group(display={**_group()["display"], "interaction_outcome": "ASK"}))
    explicit_auto = assess_group(_group(display={**_group()["display"], "interaction_outcome": "AUTO"}))

    assert preparation["reviewability"]["status"] == "ready"
    assert preparation["reviewability"]["counts_as_user_decision"] is True
    assert preparation["interaction_state"] == "needs_user_review"
    assert ask["interaction_state"] == "needs_user_review"
    assert ask["reviewability"]["counts_as_user_decision"] is True
    assert "input_request_not_bound_to_group" in ask["reviewability"]["reason_codes"]
    assert explicit_auto["interaction_state"] == "needs_user_review"
    assert "auto_fallback_requires_confirmation" in explicit_auto["reviewability"]["reason_codes"]



def test_missing_source_metadata_warns_but_captured_stale_source_still_blocks():
    missing = _group(source_versions={}, nodes=[{"operation": "update_resume_section", "status": "pending"}])
    advisory = assess_group(missing)
    stale = assess_group(_group(), source_current=False)

    assert advisory["reviewability"]["status"] == "ready"
    assert advisory["reviewability"]["counts_as_user_decision"] is True
    assert "missing_current_source" in advisory["reviewability"]["reason_codes"]
    assert stale["reviewability"]["status"] == "needs_preparation"
    assert stale["reviewability"]["counts_as_user_decision"] is False
    assert stale["reviewability"]["reason_codes"] == ["source_changed_or_unavailable"]


def test_destructive_operation_keeps_explicit_authorization_and_scope_floor():
    group = _group(
        risk="prepare",
        scope="",
        display={"before": "all local data", "after": "empty workspace"},
        nodes=[{"operation": "reset_local_business_data", "status": "pending"}],
    )
    blocked = assess_group(group)
    group["scope"] = "local_business_data"
    authorized = assess_group(group)

    assert blocked["interaction_state"] == "system_blocked"
    assert blocked["reviewability"]["reason_codes"] == ["missing_scope"]
    assert authorized["interaction_state"] == "needs_user_authorization"
    assert authorized["reviewability"]["counts_as_user_decision"] is True


def test_verified_empty_resume_section_list_is_an_explicit_before_value():
    group = _group(display={
        "before": {"resume_id": 1, "sections": []},
        "after": {"title": "New section"},
        "rationale": "Add the agreed section to the current resume.",
        "evidence_refs": ["resume:1"],
    })
    result = assess_group(group)

    assert result["reviewability"]["status"] == "ready"


def test_stale_canonical_source_is_downgraded_before_it_reaches_inbox():
    async def exercise():
        plan = {"groups": [_group()]}
        with patch("app.services.proposal_plan_sources.validate_source_versions", side_effect=ValueError("stale")):
            projected = await project_current_sources(plan)
        group = projected["groups"][0]
        assert group["reviewability"]["status"] == "needs_preparation"
        assert group["interaction_state"] == "system_recovering"
        assert group["reviewability"]["counts_as_user_decision"] is False
        assert projected["interaction_state"] == "system_recovering"

    asyncio.run(exercise())


def test_run_projects_only_genuine_user_decisions_ahead_of_technical_repair():
    state = run_interaction_state({"status": "waiting_confirmation", "proposal_plans": [
        {"groups": [
            {"interaction_state": "system_recovering"},
            {"interaction_state": "needs_user_authorization"},
        ]},
    ]})
    assert state == "needs_user_authorization"


def test_pending_review_endpoint_excludes_system_repair_and_auto_groups(monkeypatch):
    from app.routes import main_agent
    from app.services import proposal_plan_continuation, proposal_plan_store

    async def plans(*, pending_only=False):
        assert pending_only is True
        return [{"id": "plan-visible"}, {"id": "plan-technical-only"}]

    async def reviewed(plan):
        if plan["id"] == "plan-visible":
            return {
                "plan_id": plan["id"], "interaction_state": "needs_user_review",
                "groups": [
                    {"group_id": "review", "interaction_state": "needs_user_review",
                     "reviewability": {"status": "ready", "counts_as_user_decision": True}},
                    {"group_id": "repair", "interaction_state": "system_recovering",
                     "reviewability": {"status": "needs_preparation", "counts_as_user_decision": False}},
                    {"group_id": "auto", "interaction_state": "system_recovering",
                     "reviewability": {"status": "ready", "counts_as_user_decision": False}},
                ],
            }
        return {"plan_id": plan["id"], "groups": [{
            "group_id": "repair", "interaction_state": "system_recovering",
            "reviewability": {"status": "needs_preparation", "counts_as_user_decision": False},
        }]}

    monkeypatch.setattr(proposal_plan_store, "list_plans", plans)
    monkeypatch.setattr(proposal_plan_continuation, "reviewed_plan_view", reviewed)
    result = asyncio.run(main_agent.pending_decision_plans())

    assert [item["plan_id"] for item in result["plans"]] == ["plan-visible"]
    assert [group["group_id"] for group in result["plans"][0]["groups"]] == ["review"]
