"""隔离运行环境：把真实库复制成一次 run 的独立副本，并做前后快照。

原则：
- 绝不写真实库。每个 case 拿到自己的 SQLite 副本，跑坏了大不了删掉。
- 快照按"表行数 + 关键表全量行"采集，diff 只汇报真正的增删改。
"""

from __future__ import annotations

import io
import json
import shutil
import sqlite3
from pathlib import Path
from typing import Any

# 这些表的行级变化直接对应求职业务事实，必须逐行比对。
KEY_TABLES: tuple[str, ...] = (
    "jobs",
    "pools",
    "applications",
    "application_attempts",
    "application_records",
    "application_stage_events",
    "application_progress_candidates",
    "profiles",
    "profile_sections",
    "profile_target_roles",
    "resumes",
    "resume_sections",
    "resume_versions",
    "resume_optimization_proposals",
    "memory_proposals",
    "learning_observations",
    "agent_runs",
    "agent_run_events",
    "career_tasks",
    "operation_audit_logs",
)


def _connect(db_path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(str(db_path))
    connection.row_factory = sqlite3.Row
    return connection


def table_names(db_path: Path) -> list[str]:
    connection = _connect(db_path)
    try:
        rows = connection.execute(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
        ).fetchall()
        return [str(row["name"]) for row in rows]
    finally:
        connection.close()


def _row_dict(row: sqlite3.Row) -> dict[str, Any]:
    return {key: row[key] for key in row.keys()}


def snapshot(db_path: Path, *, full_tables: tuple[str, ...] = KEY_TABLES) -> dict[str, Any]:
    """采集一份快照：所有表的行数 + 关键表的全量行。"""

    db_path = Path(db_path)
    connection = _connect(db_path)
    try:
        existing = {
            str(row["name"])
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
        }
        result: dict[str, Any] = {"tables": {}, "rows": {}}
        for name in sorted(existing):
            try:
                count = int(
                    connection.execute(f'SELECT COUNT(*) AS c FROM "{name}"').fetchone()["c"]
                )
            except sqlite3.Error:
                continue
            result["tables"][name] = count
            if name not in full_tables:
                continue
            try:
                rows = connection.execute(f'SELECT * FROM "{name}"').fetchall()
            except sqlite3.Error:
                continue
            result["rows"][name] = [_row_dict(row) for row in rows]
        return result
    finally:
        connection.close()


def _row_key(table: str, row: dict[str, Any]) -> str:
    for candidate in ("id", "run_id", "task_id", "session_id", "proposal_id", "event_id"):
        if candidate in row and row[candidate] is not None:
            return f"{candidate}={row[candidate]}"
    return json.dumps(row, ensure_ascii=False, sort_keys=True)[:200]


def diff(before: dict[str, Any], after: dict[str, Any]) -> dict[str, Any]:
    """只汇报真正变化的部分。"""

    changes: dict[str, Any] = {"tables": {}, "rows": {}}
    before_tables = before.get("tables") or {}
    after_tables = after.get("tables") or {}
    for name in sorted(set(before_tables) | set(after_tables)):
        old = before_tables.get(name)
        new = after_tables.get(name)
        if old != new:
            changes["tables"][name] = {"before": old, "after": new, "delta": (new or 0) - (old or 0)}

    before_rows = before.get("rows") or {}
    after_rows = after.get("rows") or {}
    for name in sorted(set(before_rows) | set(after_rows)):
        old_map = {_row_key(name, row): row for row in (before_rows.get(name) or [])}
        new_map = {_row_key(name, row): row for row in (after_rows.get(name) or [])}
        added = [key for key in new_map if key not in old_map]
        removed = [key for key in old_map if key not in new_map]
        modified = [
            key
            for key in new_map
            if key in old_map and new_map[key] != old_map[key]
        ]
        if added or removed or modified:
            changes["rows"][name] = {
                "added": sorted(added)[:50],
                "removed": sorted(removed)[:50],
                "modified": sorted(modified)[:50],
                "added_count": len(added),
                "removed_count": len(removed),
                "modified_count": len(modified),
            }
    return changes


def clone_database(source: Path, destination: Path) -> Path:
    """用 SQLite 在线备份 API 复制库，避免复制到写了一半的文件。"""

    source = Path(source)
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        destination.unlink()
    src = sqlite3.connect(str(source))
    dst = sqlite3.connect(str(destination))
    try:
        src.backup(dst)
    finally:
        dst.close()
        src.close()
    return destination


def has_changes(changes: dict[str, Any], *, tables: tuple[str, ...] | None = None) -> bool:
    """`changes` 里是否存在业务写入（可限定表范围）。"""

    rows = changes.get("rows") or {}
    for name, payload in rows.items():
        if tables is not None and name not in tables:
            continue
        if payload.get("added_count") or payload.get("removed_count") or payload.get("modified_count"):
            return True
    return False


def write_json(path: Path, payload: Any) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with io.open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)


__all__ = [
    "KEY_TABLES",
    "clone_database",
    "diff",
    "has_changes",
    "snapshot",
    "table_names",
    "write_json",
]
