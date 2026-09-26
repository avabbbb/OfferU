from __future__ import annotations

import asyncio
from typing import Any

from fastapi import HTTPException
import pytest

from app.routes import main_agent


def test_career_artifact_route_reads_through_registry_projection(monkeypatch: Any) -> None:
    calls: list[tuple[str, dict[str, Any]]] = []
    artifact = {
        "id": "artifact_synthetic",
        "artifact_type": "reengagement_candidate",
        "title": "Synthetic re-engagement review",
        "content_markdown": "Review this opportunity before deciding.",
    }

    async def fake_outputs(operation: str, args: dict[str, Any]) -> dict[str, Any]:
        calls.append((operation, args))
        return artifact

    monkeypatch.setattr(main_agent, "_ui_operation_outputs", fake_outputs)

    result = asyncio.run(main_agent.career_artifact("artifact_synthetic"))

    assert result == artifact
    assert calls == [("get_career_artifact", {"artifact_id": "artifact_synthetic"})]


def test_career_artifact_route_returns_not_found_without_leaking_store_details(monkeypatch: Any) -> None:
    async def missing(*_args: Any, **_kwargs: Any) -> dict[str, Any]:
        return {"error": "artifact path H:\\private\\data\\missing.json not found"}

    monkeypatch.setattr(main_agent, "_ui_operation_outputs", missing)

    with pytest.raises(HTTPException) as error:
        asyncio.run(main_agent.career_artifact("artifact_missing"))

    assert error.value.status_code == 404
    assert error.value.detail == "Career artifact not found"
