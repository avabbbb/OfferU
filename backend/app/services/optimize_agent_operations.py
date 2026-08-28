"""Registry-backed adapters for the legacy conversational resume optimizer."""

from __future__ import annotations

from typing import Any

from app.database import async_session


async def start_optimize_agent_session(
    job_ids: list[int],
    mode: str = "per_job",
    profile_id: int | None = None,
    reference_resume_id: int | None = None,
) -> dict[str, Any]:
    from app.agents.optimize_agent import start_session

    async with async_session() as db:
        return await start_session(
            job_ids=job_ids,
            mode=mode,
            profile_id=profile_id,
            reference_resume_id=reference_resume_id,
            db=db,
        )


async def chat_optimize_agent_session(
    session_id: str,
    message: str,
    action: str = "reply",
    feedback: str = "",
) -> dict[str, Any]:
    from app.agents.optimize_agent import chat_turn

    async with async_session() as db:
        return await chat_turn(
            session_id=session_id,
            user_message=message,
            action=action,
            feedback=feedback,
            db=db,
        )


async def stream_optimize_agent_session(
    session_id: str,
    message: str,
    action: str = "reply",
    feedback: str = "",
) -> dict[str, Any]:
    """Collect the legacy generator under the Registry operation boundary.

    The HTTP adapter still emits the exact legacy SSE payloads. Collecting the
    generator here gives the operation audit one durable mutation boundary and
    avoids handing a request-scoped DB session into a background stream.
    """
    from app.agents.optimize_agent import chat_turn_stream

    events: list[str] = []
    async with async_session() as db:
        async for event in chat_turn_stream(
            session_id=session_id,
            user_message=message,
            action=action,
            feedback=feedback,
            db=db,
        ):
            events.append(event)
    return {"session_id": session_id, "events": events}


async def delete_optimize_agent_session(session_id: str) -> dict[str, Any]:
    from app.agents.optimize_agent import delete_session

    async with async_session() as db:
        deleted = await delete_session(session_id, db)
    if not deleted:
        return {"error": "会话不存在"}
    return {"deleted": True, "session_id": session_id}

