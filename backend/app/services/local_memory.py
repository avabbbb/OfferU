"""Permissioned preview of supported local AI memory files, without history scans."""

import os
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict


MAX_MEMORY_BYTES = 80_000
SOURCE_ID = "codex-memory-summary"
SOURCE_NAME = "Codex · 职业记忆摘要"


class LocalMemoryPreviewInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    source_id: Literal["codex-memory-summary"]
    consent: Literal[True]


def _summary_path() -> Path:
    agent_root = Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex").expanduser().resolve()
    candidate = agent_root / "memories" / "memory_summary.md"
    # Never follow a memory-directory link into auth/session or unrelated files.
    if candidate.is_symlink() or candidate.parent.is_symlink() or not candidate.resolve().is_relative_to(agent_root):
        raise ValueError("记忆摘要路径不可读取，请改用你选择的导出文件")
    return candidate


async def list_local_memory_sources() -> dict:
    """Discover one known summary by metadata only; never open memory content."""
    try:
        path = _summary_path()
        if not path.is_file():
            return {"items": []}
        size = path.stat().st_size
    except (OSError, ValueError):
        return {"items": [], "message": "无法检查记忆摘要，可改用导出文件"}
    return {"items": [{"id": SOURCE_ID, "name": SOURCE_NAME, "bytes": size, "can_preview": size <= MAX_MEMORY_BYTES}]}


async def preview_local_memory_source(source_id: str, consent: bool) -> dict:
    request = LocalMemoryPreviewInput(source_id=source_id, consent=consent)
    try:
        path = _summary_path()
        with path.open("rb") as stream:
            payload = stream.read(MAX_MEMORY_BYTES + 1)
    except OSError:
        raise ValueError("记忆摘要不存在或无法读取，请重新查找或选择导出文件") from None
    if len(payload) > MAX_MEMORY_BYTES:
        raise ValueError("摘要超过 80 KB，请先导出你希望使用的职业片段")
    try:
        text = payload.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise ValueError("摘要不是可读取的文本，请改用文本导出") from None
    if not text.strip() or "\x00" in text:
        raise ValueError("摘要没有可导入的文字")
    return {"source_id": request.source_id, "source_name": SOURCE_NAME, "text": text}
