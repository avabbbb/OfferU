"""Persistence operations for the legacy Profile Builder Agent surface."""

from __future__ import annotations

import contextlib
import hashlib
import json
from typing import Any, Optional

from sqlalchemy import select

from app.database import async_session
from app.models.models import Profile, ProfileChatSession, ProfileTargetRole
from app.services.profile_builder_agent import (
    build_next_question,
    generate_raw_turn_patch,
    normalize_profile_agent_patch,
    run_profile_agent_loop,
)
from app.services.profile_archive import build_personal_archive_from_agent_patch
from app.services.profile_operations import (
    _get_or_create_default_profile,
    _load_profile_bundle,
    _serialize_profile,
)
from app.services.profile_schema import normalize_base_info_payload

PROFILE_AGENT_TOPIC = "profile_builder"


def _profile_agent_item(kind: str, **payload: Any) -> dict[str, Any]:
    return {"kind": kind, "agent": PROFILE_AGENT_TOPIC, **payload}


def _extract_agent_state(messages_json: list[Any]) -> dict[str, Any]:
    from app.services.profile_builder_agent import build_initial_agent_state

    for item in reversed(messages_json or []):
        if isinstance(item, dict) and item.get("kind") == "profile_agent_state":
            state = item.get("state")
            if isinstance(state, dict):
                return state
    return build_initial_agent_state(resume_text="")


def _extract_pending_patch(messages_json: list[Any]) -> dict[str, Any] | None:
    for item in reversed(messages_json or []):
        if item.get("kind") == "profile_agent_patch" and not item.get("applied"):
            patch = item.get("patch")
            if isinstance(patch, dict):
                return patch
    return None


def _profile_agent_candidate_source(
    session_id: int,
    index: int,
    item: dict[str, Any],
) -> tuple[str, str, dict[str, Any]]:
    """Build a stable, secret-free evidence envelope for one Agent candidate."""

    section_type = str(item.get("section_type") or "general").strip().lower()
    title = str(item.get("title") or f"Profile Agent 候选 {index + 1}").strip()[:220]
    content = item.get("content_json") if isinstance(item.get("content_json"), dict) else {}
    canonical = json.dumps(
        {"section_type": section_type, "title": title, "content_json": content},
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    external_id = f"profile-agent:{session_id}:{digest}"
    excerpt = next(
        (
            str(content.get(key)).strip()
            for key in ("bullet", "description", "summary")
            if isinstance(content.get(key), str) and content.get(key).strip()
        ),
        "",
    )
    if not excerpt:
        normalized = content.get("normalized")
        excerpt = json.dumps(
            normalized if isinstance(normalized, dict) else content,
            ensure_ascii=False,
            sort_keys=True,
        )
    observation_content = {
        "fact_type": section_type,
        "title": title,
        "source_excerpt": excerpt[:20_000],
        "candidate": content,
        "confidence": float(item.get("confidence") or 0.7),
        "session_id": session_id,
        "candidate_index": index,
    }
    observation_content["candidate_hash"] = digest
    return external_id, title, observation_content


async def _accept_profile_agent_sections(
    session_id: int,
    sections: list[dict[str, Any]],
    *,
    rollback_proposal_ids: list[int] | None = None,
) -> list[dict[str, Any]]:
    """Promote Agent sections through Career Memory's evidence gate.

    The Profile Builder Agent can suggest facts, but it must not create a
    ProfileSection directly.  Each user-confirmed section becomes an
    observation and a pending proposal first; only the memory review path can
    accept it and attach its source evidence.
    """

    from app.services.career_memory import (
        create_memory_proposal,
        record_learning_observation,
        review_memory_proposal,
    )

    accepted: list[dict[str, Any]] = []
    newly_accepted: list[int] = []
    try:
        for index, item in enumerate(sections):
            if not isinstance(item, dict):
                continue
            section_type = str(item.get("section_type") or "general").strip().lower()
            title = str(item.get("title") or f"Profile Agent 候选 {index + 1}").strip()[:220]
            content = item.get("content_json")
            if not isinstance(content, dict) or not content:
                continue
            external_id, source_title, observation_content = _profile_agent_candidate_source(
                session_id,
                index,
                item,
            )
            observation = await record_learning_observation(
                source_type="profile_agent",
                source_external_id=external_id,
                source_title=source_title,
                source_locator=f"profile-agent:session:{session_id}:candidate:{index}",
                source_metadata={"session_id": session_id, "candidate_index": index},
                observation_type="profile_fact_candidate",
                content=observation_content,
                # LearningObservation.idempotency_key is a 64-char column; the
                # canonical candidate digest already provides the stable identity.
                idempotency_key=str(observation_content["candidate_hash"]),
            )
            proposal = await create_memory_proposal(
                observation_id=int(observation["id"]),
                target_tier="verified_fact",
                section_type=section_type,
                title=title,
                after=content,
                reason="来自 Profile Builder Agent 的候选；用户确认后经过职业事实门写入。",
                impact=["纳入岗位分析、简历策略和面试准备的证据池"],
            )
            status = str(proposal.get("status") or "")
            proposal_id = int(proposal.get("id") or 0)
            if not proposal.get("duplicate") and proposal_id:
                # Register the id before invoking the fact gate. If the gate
                # fails after creating a ProfileSection but before returning,
                # the outer rollback still has enough identity to revoke it.
                newly_accepted.append(proposal_id)
            if status in {"pending", "deferred"}:
                reviewed = await review_memory_proposal(
                    proposal_id=proposal_id,
                    action="accept",
                    note="用户在 Profile Builder Agent 中确认候选",
                )
            elif status == "accepted":
                reviewed = proposal
            else:
                raise ValueError(
                    f"Profile Agent 候选「{title}」当前状态为 {status or 'unknown'}，不能写入"
                )
            if reviewed.get("error"):
                raise ValueError(str(reviewed["error"]))
            reviewed_id = int(reviewed.get("id") or proposal_id)
            profile_section_id = reviewed.get("applied_profile_section_id")
            reviewed_status = reviewed.get("status") or status
            if reviewed_status != "accepted":
                raise ValueError(
                    f"Profile Agent 候选「{title}」接受后状态为 {reviewed_status or 'unknown'}"
                )
            accepted.append(
                {
                    "candidate_index": index,
                    "observation_id": observation.get("id"),
                    "proposal_id": reviewed_id,
                    "profile_section_id": profile_section_id,
                    "status": reviewed_status,
                }
            )
    except Exception:
        await _rollback_profile_agent_proposals(newly_accepted)
        raise
    if rollback_proposal_ids is not None:
        rollback_proposal_ids.extend(newly_accepted)
    return accepted


async def _rollback_profile_agent_proposals(proposal_ids: list[int]) -> None:
    """Revoke only newly accepted candidates after an atomic apply failure."""

    if not proposal_ids:
        return
    from app.services.career_memory import review_memory_proposal

    for proposal_id in reversed(dict.fromkeys(proposal_ids)):
        with contextlib.suppress(Exception):
            await review_memory_proposal(
                proposal_id=proposal_id,
                action="revoke",
                note="Profile Agent 批量确认失败，撤销本次新写入",
            )


async def get_profile_agent_session(session_id: int) -> dict[str, Any]:
    """Read one Profile Builder session without creating or mutating a profile."""
    async with async_session() as db:
        profile = (
            await db.execute(
                select(Profile).where(Profile.is_default == True)
            )
        ).scalar_one_or_none()
        if profile is None:
            raise ValueError("profile agent session not found")
        session = (
            await db.execute(
                select(ProfileChatSession).where(
                    ProfileChatSession.id == session_id,
                    ProfileChatSession.profile_id == profile.id,
                    ProfileChatSession.topic == PROFILE_AGENT_TOPIC,
                )
            )
        ).scalar_one_or_none()
        if session is None:
            raise ValueError("profile agent session not found")
        messages_json = list(session.messages_json or [])
        return {
            "id": session.id,
            "status": session.status,
            "state": _extract_agent_state(messages_json),
            "pending_patch": _extract_pending_patch(messages_json),
            "messages_json": messages_json,
        }


def _update_missing_after_patch(state: dict[str, Any], patch: dict[str, Any]) -> dict[str, Any]:
    next_state = dict(state)
    missing = list(next_state.get("missing_fields") or [])
    if patch.get("target_roles") and "target_role" in missing:
        missing.remove("target_role")
    base_info = patch.get("base_info") if isinstance(patch.get("base_info"), dict) else {}
    if any(base_info.get(key) for key in ("phone", "email")) and "contact_info" in missing:
        missing.remove("contact_info")
    if base_info.get("current_city") and "target_city" in missing:
        missing.remove("target_city")
    section_types = {
        str(item.get("section_type") or "")
        for item in (patch.get("sections") if isinstance(patch.get("sections"), list) else [])
        if isinstance(item, dict)
    }
    if section_types.intersection({"experience", "project"}) and "core_experience" in missing:
        missing.remove("core_experience")
    if "skill" in section_types and "skills" in missing:
        missing.remove("skills")
    if patch.get("sections") and "resume" in missing:
        missing.remove("resume")
    next_state["missing_fields"] = missing
    from app.services.profile_builder_agent import FIELD_LABELS

    next_state["missing_field_labels"] = [FIELD_LABELS.get(item, item) for item in missing]
    next_state["next_question"] = build_next_question(
        missing,
        next_state.get("goal", {}).get("target_role", ""),
    )
    return next_state


async def start_profile_agent_session(
    state: dict[str, Any],
    patch: dict[str, Any],
    messages_json: list[dict[str, Any]],
) -> dict[str, Any]:
    async with async_session() as db:
        profile = await _get_or_create_default_profile(db)
        session = ProfileChatSession(
            profile_id=profile.id,
            topic=PROFILE_AGENT_TOPIC,
            status="active",
            messages_json=messages_json,
            extracted_bullets_count=len(patch.get("sections") or []),
        )
        db.add(session)
        await db.commit()
        await db.refresh(session)
        return {
            "session_id": session.id,
            "state": state,
            "assistant_message": patch["assistant_message"],
            "patch": patch,
        }


async def continue_profile_agent_session(
    session_id: int,
    message: str,
) -> dict[str, Any]:
    async with async_session() as db:
        profile = await _get_or_create_default_profile(db)
        session = (
            await db.execute(
                select(ProfileChatSession).where(
                    ProfileChatSession.id == session_id,
                    ProfileChatSession.profile_id == profile.id,
                    ProfileChatSession.topic == PROFILE_AGENT_TOPIC,
                )
            )
        ).scalar_one_or_none()
        if not session:
            raise ValueError("profile agent session not found")
        messages_json = list(session.messages_json or [])
        state = _extract_agent_state(messages_json)
        user_message = message.strip()
        messages_json.append({"role": "user", "topic": PROFILE_AGENT_TOPIC, "content": user_message})
        loop_result = await run_profile_agent_loop(
            state=state,
            messages_json=messages_json,
            user_message=user_message,
            generate_patch=generate_raw_turn_patch,
        )
        patch = loop_result["patch"]
        next_state = (
            _update_missing_after_patch(state, patch)
            if patch.get("sections") or patch.get("base_info")
            else state
        )
        messages_json.extend(
            [
                {"role": "assistant", "topic": PROFILE_AGENT_TOPIC, "content": patch["assistant_message"]},
                _profile_agent_item("profile_agent_patch", patch=patch, applied=False),
                _profile_agent_item(
                    "profile_agent_loop",
                    trace=loop_result["trace"],
                    stop_reason=loop_result["stop_reason"],
                ),
                _profile_agent_item("profile_agent_state", state=next_state),
            ]
        )
        session.messages_json = messages_json
        session.extracted_bullets_count = int(session.extracted_bullets_count or 0) + len(
            patch.get("sections") or []
        )
        if patch["action"] == "finish":
            session.status = "completed"
        await db.commit()
        return {
            "session_id": session.id,
            "state": next_state,
            "assistant_message": patch["assistant_message"],
            "patch": patch,
            "agent_trace": loop_result["trace"],
            "stop_reason": loop_result["stop_reason"],
        }


async def apply_profile_agent_patch(
    session_id: int,
    patch: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    # Read and normalize the pending Agent patch before touching the Profile.
    # The section candidates are promoted through Career Memory below; this
    # first transaction deliberately performs no ProfileSection mutation.
    async with async_session() as db:
        profile = await _get_or_create_default_profile(db)
        session = (
            await db.execute(
                select(ProfileChatSession).where(
                    ProfileChatSession.id == session_id,
                    ProfileChatSession.profile_id == profile.id,
                    ProfileChatSession.topic == PROFILE_AGENT_TOPIC,
                )
            )
        ).scalar_one_or_none()
        if not session:
            raise ValueError("profile agent session not found")
        messages_json = list(session.messages_json or [])
        raw_patch = patch if isinstance(patch, dict) else _extract_pending_patch(messages_json)
        if not raw_patch:
            raise ValueError("no pending patch")
        normalized_patch = normalize_profile_agent_patch(raw_patch)
        profile_id = profile.id

    rollback_proposal_ids: list[int] = []
    evidence = await _accept_profile_agent_sections(
        session_id,
        normalized_patch.get("sections") or [],
        rollback_proposal_ids=rollback_proposal_ids,
    )

    # Re-open the session after the evidence gate commits its own records. The
    # base fields, target roles and archive are user-confirmed profile metadata;
    # career sections themselves already exist only through accepted proposals.
    metadata_committed = False
    try:
        async with async_session() as db:
            profile = (
                await db.execute(select(Profile).where(Profile.id == profile_id))
            ).scalar_one_or_none()
            if profile is None:
                raise ValueError("profile not found")
            session = (
                await db.execute(
                    select(ProfileChatSession).where(
                        ProfileChatSession.id == session_id,
                        ProfileChatSession.profile_id == profile.id,
                        ProfileChatSession.topic == PROFILE_AGENT_TOPIC,
                    )
                )
            ).scalar_one_or_none()
            if session is None:
                raise ValueError("profile agent session not found")
            existing_base_info = profile.base_info_json if isinstance(profile.base_info_json, dict) else {}
            base_info = normalized_patch.get("base_info") if isinstance(normalized_patch.get("base_info"), dict) else {}
            if base_info:
                merged_base = normalize_base_info_payload({**existing_base_info, **base_info})
                profile.base_info_json = {**existing_base_info, **merged_base, **base_info}
                if base_info.get("name"):
                    profile.name = str(base_info["name"])[:120]
                if base_info.get("summary") and not profile.headline:
                    profile.headline = str(base_info["summary"])[:300]

            existing_roles = {
                role.role_name
                for role in (
                    await db.execute(
                        select(ProfileTargetRole).where(ProfileTargetRole.profile_id == profile.id)
                    )
                ).scalars().all()
            }
            for index, role_name in enumerate(normalized_patch.get("target_roles") or []):
                role = str(role_name).strip()
                if not role or role in existing_roles:
                    continue
                db.add(
                    ProfileTargetRole(
                        profile_id=profile.id,
                        role_name=role[:120],
                        role_level="",
                        fit="primary" if index == 0 else "secondary",
                    )
                )
                existing_roles.add(role)

            latest_base_info = profile.base_info_json if isinstance(profile.base_info_json, dict) else existing_base_info
            profile.base_info_json = {
                **latest_base_info,
                "personal_archive": build_personal_archive_from_agent_patch(
                    existing_base_info=latest_base_info,
                    patch=normalized_patch,
                    existing_archive=latest_base_info.get("personal_archive")
                    if isinstance(latest_base_info, dict)
                    else None,
                )
            )
            for item in reversed(messages_json):
                if isinstance(item, dict) and item.get("kind") == "profile_agent_patch" and not item.get("applied"):
                    item["applied"] = True
                    break
            messages_json.append(
                _profile_agent_item(
                    "profile_agent_apply",
                    patch=normalized_patch,
                    result={
                        "applied": True,
                        "evidence": evidence,
                    },
                )
            )
            session.messages_json = messages_json
            await db.commit()
            metadata_committed = True
            profile, roles, sections = await _load_profile_bundle(db, profile.id)
            result = {
                "applied": True,
                "applied_sections_count": len(evidence),
                "evidence": evidence,
                "profile": _serialize_profile(profile, roles, sections),
            }
    except Exception:
        if not metadata_committed:
            await _rollback_profile_agent_proposals(rollback_proposal_ids)
        raise
    return result
