from __future__ import annotations

import asyncio
import inspect

import pytest

from app.services.profile_agent_operations import (
    _accept_profile_agent_sections,
    _profile_agent_candidate_source,
    apply_profile_agent_patch,
)
from app.services.career_memory import record_profile_chat_evidence
from app.services.profile_operations import confirm_profile_bullet, save_profile_chat_turn


def test_profile_agent_candidate_source_is_stable_and_bounded() -> None:
    item = {
        "section_type": "experience",
        "title": "星河科技 产品经理",
        "content_json": {
            "bullet": "推动注册转化率提升 18%。",
            "normalized": {"company": "星河科技"},
        },
        "confidence": 0.86,
    }

    first = _profile_agent_candidate_source(12, 0, item)
    second = _profile_agent_candidate_source(12, 0, item)

    assert first == second
    external_id, title, content = first
    assert external_id.startswith("profile-agent:12:")
    assert title == "星河科技 产品经理"
    assert len(str(content["candidate_hash"])) == 64
    assert content["source_excerpt"] == "推动注册转化率提升 18%。"


def test_profile_agent_apply_has_no_direct_profile_section_write() -> None:
    source = inspect.getsource(apply_profile_agent_patch)

    assert "_accept_profile_agent_sections" in source
    assert "ProfileSection(" not in source


def test_profile_chat_confirm_has_no_direct_profile_section_write() -> None:
    source = inspect.getsource(confirm_profile_bullet)

    assert "record_profile_chat_evidence" not in source
    assert "没有来源观察提案" in source
    assert "ProfileSection(" not in source


def test_profile_chat_turn_persists_candidates_after_memory_evidence() -> None:
    source = inspect.getsource(save_profile_chat_turn)

    assert "record_profile_chat_evidence" in source
    assert '"memory_proposal_id"' in source
    assert '"memory_evidence"' in source


def test_profile_agent_sections_use_observation_proposal_review_gate(monkeypatch) -> None:
    calls: list[tuple[str, dict]] = []

    async def record_learning_observation(**kwargs):  # noqa: ANN003
        calls.append(("observation", kwargs))
        return {"id": 21, "duplicate": False}

    async def create_memory_proposal(**kwargs):  # noqa: ANN003
        calls.append(("proposal", kwargs))
        return {"id": 31, "status": "pending"}

    async def review_memory_proposal(**kwargs):  # noqa: ANN003
        calls.append(("review", kwargs))
        return {"id": 31, "status": "accepted", "applied_profile_section_id": 41}

    monkeypatch.setattr(
        "app.services.career_memory.record_learning_observation",
        record_learning_observation,
    )
    monkeypatch.setattr(
        "app.services.career_memory.create_memory_proposal",
        create_memory_proposal,
    )
    monkeypatch.setattr(
        "app.services.career_memory.review_memory_proposal",
        review_memory_proposal,
    )

    result = asyncio.run(
        _accept_profile_agent_sections(
            7,
            [
                {
                    "section_type": "project",
                    "title": "AI 视频工作流",
                    "content_json": {
                        "bullet": "把交付周期缩短 40%。",
                        "normalized": {"name": "AI 视频工作流"},
                    },
                    "confidence": 0.9,
                }
            ],
        )
    )

    assert [name for name, _ in calls] == ["observation", "proposal", "review"]
    assert calls[0][1]["source_type"] == "profile_agent"
    assert calls[0][1]["observation_type"] == "profile_fact_candidate"
    assert calls[0][1]["source_metadata"] == {"session_id": 7, "candidate_index": 0}
    assert calls[1][1]["target_tier"] == "verified_fact"
    assert calls[1][1]["observation_id"] == 21
    assert calls[2][1] == {
        "proposal_id": 31,
        "action": "accept",
        "note": "用户在 Profile Builder Agent 中确认候选",
    }
    assert result == [
        {
            "candidate_index": 0,
            "observation_id": 21,
            "proposal_id": 31,
            "profile_section_id": 41,
            "status": "accepted",
        }
    ]


def test_profile_chat_evidence_uses_original_user_message(monkeypatch) -> None:
    calls: list[tuple[str, dict]] = []

    async def record_learning_observation(**kwargs):  # noqa: ANN003
        calls.append(("observation", kwargs))
        return {"id": 71, "duplicate": False}

    async def create_memory_proposal(**kwargs):  # noqa: ANN003
        calls.append(("proposal", kwargs))
        return {"id": 81, "status": "pending"}

    monkeypatch.setattr(
        "app.services.career_memory.record_learning_observation",
        record_learning_observation,
    )
    monkeypatch.setattr(
        "app.services.career_memory.create_memory_proposal",
        create_memory_proposal,
    )

    result = asyncio.run(
        record_profile_chat_evidence(
            session_id=14,
            topic="project",
            user_message="我带 4 人把交付周期缩短 40%。",
            candidates=[
                {
                    "section_type": "project",
                    "title": "AI 视频工作流",
                    "content_json": {"bullet": "带团队优化交付"},
                    "confidence": 0.83,
                }
            ],
        )
    )

    assert [name for name, _ in calls] == ["observation", "proposal"]
    observation_payload = calls[0][1]
    assert observation_payload["source_type"] == "profile_chat"
    assert observation_payload["observation_type"] == "profile_fact_candidate"
    assert observation_payload["source_metadata"] == {
        "session_id": 14,
        "topic": "project",
        "candidate_index": 0,
    }
    assert observation_payload["content"]["source_excerpt"] == "我带 4 人把交付周期缩短 40%。"
    assert calls[1][1]["observation_id"] == 71
    assert result["source_external_id"].startswith("profile-chat:14:")
    assert result["observations"][0]["candidate_index"] == 0
    assert result["proposals"][0]["candidate_index"] == 0


def test_profile_agent_sections_revoke_new_accepts_when_later_candidate_fails(monkeypatch) -> None:
    calls: list[tuple[str, dict]] = []
    next_observation_id = 40
    next_proposal_id = 50

    async def record_learning_observation(**kwargs):  # noqa: ANN003
        nonlocal next_observation_id
        next_observation_id += 1
        calls.append(("observation", kwargs))
        return {"id": next_observation_id, "duplicate": False}

    async def create_memory_proposal(**kwargs):  # noqa: ANN003
        nonlocal next_proposal_id
        next_proposal_id += 1
        calls.append(("proposal", kwargs))
        return {"id": next_proposal_id, "status": "pending", "duplicate": False}

    async def review_memory_proposal(**kwargs):  # noqa: ANN003
        calls.append(("review", kwargs))
        if kwargs["action"] == "revoke":
            return {"id": kwargs["proposal_id"], "status": "revoked"}
        if kwargs["proposal_id"] == 52:
            raise ValueError("事实门拒绝第二条候选")
        return {
            "id": kwargs["proposal_id"],
            "status": "accepted",
            "applied_profile_section_id": 60,
        }

    monkeypatch.setattr(
        "app.services.career_memory.record_learning_observation",
        record_learning_observation,
    )
    monkeypatch.setattr(
        "app.services.career_memory.create_memory_proposal",
        create_memory_proposal,
    )
    monkeypatch.setattr(
        "app.services.career_memory.review_memory_proposal",
        review_memory_proposal,
    )

    with pytest.raises(ValueError, match="事实门拒绝第二条候选"):
        asyncio.run(
            _accept_profile_agent_sections(
                8,
                [
                    {
                        "section_type": "experience",
                        "title": "第一条",
                        "content_json": {"bullet": "第一条事实"},
                    },
                    {
                        "section_type": "project",
                        "title": "第二条",
                        "content_json": {"bullet": "第二条事实"},
                    },
                ],
            )
        )

    assert [
        (name, payload.get("action"))
        for name, payload in calls
        if name == "review"
    ] == [
        ("review", "accept"),
        ("review", "accept"),
        ("review", "revoke"),
        ("review", "revoke"),
    ]
    assert calls[-1][1]["proposal_id"] == 51
