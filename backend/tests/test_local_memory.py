import asyncio
from pathlib import Path
from unittest.mock import patch

import pytest
from pydantic import ValidationError

from app.services.local_memory import MAX_MEMORY_BYTES, SOURCE_ID, list_local_memory_sources, preview_local_memory_source


@pytest.fixture
def summary(tmp_path, monkeypatch):
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))
    path = tmp_path / "memories" / "memory_summary.md"
    path.parent.mkdir()
    path.write_bytes("- 用户希望从事产品工作\n".encode("utf-8"))
    return path


def test_discovery_does_not_read_memory_contents(summary):
    with patch.object(Path, "open", side_effect=AssertionError("discovery must not read contents")):
        result = asyncio.run(list_local_memory_sources())
    assert [item["id"] for item in result["items"]] == [SOURCE_ID]
    assert "text" not in result["items"][0]


@pytest.mark.parametrize("source,consent", [(SOURCE_ID, False), ("../auth.json", True)])
def test_preview_requires_consent_and_rejects_arbitrary_paths(summary, source, consent):
    with patch.object(Path, "open", side_effect=AssertionError("invalid request must not read")):
        with pytest.raises(ValidationError):
            asyncio.run(preview_local_memory_source(source, consent))


def test_preview_is_bounded_and_does_not_silently_truncate(summary):
    assert asyncio.run(preview_local_memory_source(SOURCE_ID, True))["text"] == "- 用户希望从事产品工作\n"
    summary.write_bytes(b"x" * (MAX_MEMORY_BYTES + 1))
    with pytest.raises(ValueError, match="80 KB"):
        asyncio.run(preview_local_memory_source(SOURCE_ID, True))


def test_agent_cannot_grant_itself_permission_to_read_memory(summary):
    from app.ops import execute_operation, get_operation_schema

    with patch.object(Path, "open", side_effect=AssertionError("unconfirmed Agent must not read")):
        result = asyncio.run(execute_operation(
            "preview_local_memory_source", {"source_id": SOURCE_ID, "consent": True}, surface="cli", audit=False,
        ))
    assert result["ok"] is False
    assert result["outputs"] == {"executed": False, "requires_confirmation": True}
    assert "text" in get_operation_schema("preview_local_memory_source")["audit_redacted_output_parameters"]


def test_preview_rejects_symlink_to_another_file(summary):
    outside = summary.parent.parent / "auth.json"
    outside.write_text("private", encoding="utf-8")
    summary.unlink()
    try:
        summary.symlink_to(outside)
    except OSError:
        pytest.skip("This environment does not allow symlinks")
    with pytest.raises(ValueError, match="路径"):
        asyncio.run(preview_local_memory_source(SOURCE_ID, True))
