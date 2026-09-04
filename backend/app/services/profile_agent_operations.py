"""Persistence operations for the legacy Profile Builder Agent surface."""

from __future__ import annotations

from typing import Any, Optional

from sqlalchemy import func, select

from app.database import async_session
from app.models.models import Profile, ProfileChatSession, ProfileSection, ProfileTargetRole
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

        max_sort = (
            await db.execute(
                select(func.max(ProfileSection.sort_order)).where(
                    ProfileSection.profile_id == profile.id
                )
            )
        ).scalar()
        next_sort = int(max_sort or 0) + 1
        applied_sections: list[ProfileSection] = []
        for item in normalized_patch.get("sections") or []:
            if not isinstance(item, dict):
                continue
            existing_sections = (
                await db.execute(
                    select(ProfileSection)
                    .where(
                        ProfileSection.profile_id == profile.id,
                        ProfileSection.section_type == item["section_type"],
                        ProfileSection.title == item["title"],
                        ProfileSection.status == "active",
                    )
                    .order_by(ProfileSection.id.desc())
                )
            ).scalars().all()
            duplicate = next(
                (
                    section
                    for section in existing_sections
                    if (section.content_json or {}) == item["content_json"]
                ),
                None,
            )
            if duplicate:
                applied_sections.append(duplicate)
                continue
            section = ProfileSection(
                profile_id=profile.id,
                section_type=item["section_type"],
                title=item["title"],
                sort_order=next_sort,
                content_json=item["content_json"],
                source="ai_profile_agent",
                confidence=float(item.get("confidence") or 0.7),
            )
            next_sort += 1
            db.add(section)
            applied_sections.append(section)

        latest_base_info = profile.base_info_json if isinstance(profile.base_info_json, dict) else existing_base_info
        profile.base_info_json = {
            **latest_base_info,
            "personal_archive": build_personal_archive_from_agent_patch(
                existing_base_info=latest_base_info,
                patch=normalized_patch,
                existing_archive=latest_base_info.get("personal_archive")
                if isinstance(latest_base_info, dict)
                else None,
            ),
        }
        for item in reversed(messages_json):
            if isinstance(item, dict) and item.get("kind") == "profile_agent_patch" and not item.get("applied"):
                item["applied"] = True
                break
        messages_json.append(
            _profile_agent_item(
                "profile_agent_apply",
                patch=normalized_patch,
                result={"applied": True},
            )
        )
        session.messages_json = messages_json
        await db.commit()
        for section in applied_sections:
            await db.refresh(section)
        profile, roles, sections = await _load_profile_bundle(db, profile.id)
        return {
            "applied": True,
            "applied_sections_count": len(applied_sections),
            "profile": _serialize_profile(profile, roles, sections),
        }
