"""Full local business-data reset behind the Operation Registry boundary."""

from __future__ import annotations

import copy
import shutil
from pathlib import Path
from typing import Any

from sqlalchemy import delete, select, text

from app.database import async_session
from app.models.models import (
    ApplicationTable,
    ApplicationTemplate,
    ApplicationWorkspaceSettings,
    Batch,
    InterviewScoringSkill,
    Profile,
    ResumeTemplate,
)
from app.runtime_paths import runtime_data_dir
from app.services.agent_files import atomic_write_json
from app.services.data_safety import DataSafetyError, _assert_managed_tree
from app.services.harness_memory import empty_agent_memory


# These are product configuration or safety records, not the user's career
# workspace.  Their rows must survive a reset so the next import can use the
# same providers, templates, policies, and rollback path.
PRESERVED_TABLES = frozenset(
    {
        "agent_provider_health",
        "application_templates",
        "application_workspace_settings",
        "automation_rules",
        "email_accounts",
        "html_resume_templates",
        "interview_scoring_skills",
        "operation_audit_logs",
        "resume_templates",
    }
)

_DATA_DIRECTORIES = (
    "application_events",
    "artifacts",
    "batch_evaluations",
    "batch_workers",
    "executor-smoke",
    "executor-smoke-pi",
    "exports",
    "follow_ups",
    "job_research_workers",
    "pi_sessions",
    "pre_application_decisions",
    "resume_drafts",
    "role_benchmark_workers",
    "run_workspaces",
    "uploads",
    "work-source-runs",
)

_HARNESS_FILES = {
    "harness_agent_conversations.json": {
        "schema_version": "offeru.harness_conversations.v1",
        "conversations": [],
    },
    "harness_agent_memory.json": empty_agent_memory(),
    "harness_agent_runs.json": {
        "schema_version": "offeru.agent_runs.v2",
        "runs": [],
    },
}


def _quote_identifier(value: str) -> str:
    return '"' + value.replace('"', '""') + '"'


async def _managed_table_names(db: Any) -> tuple[list[str], dict[str, set[str]]]:
    result = await db.execute(
        text(
            "SELECT name FROM sqlite_master "
            "WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        )
    )
    names = [str(row[0]) for row in result]
    parents: dict[str, set[str]] = {}
    for name in names:
        foreign_keys = await db.execute(
            text(f"PRAGMA foreign_key_list({_quote_identifier(name)})")
        )
        parents[name] = {str(row[2]) for row in foreign_keys if row[2]}
    return names, parents


def _delete_order(names: list[str], parents: dict[str, set[str]]) -> list[str]:
    """Return child-first table order, tolerating legacy self/cyclic FKs."""

    pending = set(names)
    children: dict[str, set[str]] = {name: set() for name in names}
    for child, referenced in parents.items():
        for parent in referenced:
            if parent in children and parent != child:
                children[parent].add(child)

    ordered: list[str] = []
    while pending:
        leaves = sorted(
            name
            for name in pending
            if not (children.get(name, set()) & pending)
        )
        if not leaves:
            # The current schema has no required cycles, but old local schema
            # variants did.  Defer their FK checks until the transaction ends.
            ordered.extend(sorted(pending))
            break
        ordered.extend(leaves)
        pending.difference_update(leaves)
    return ordered


async def _delete_business_rows(
    db: Any,
    *,
    current_run_id: str = "",
    current_task_id: str = "",
) -> dict[str, int]:
    names, parents = await _managed_table_names(db)
    deletable = [name for name in names if name not in PRESERVED_TABLES]
    counts: dict[str, int] = {}
    for name in _delete_order(deletable, parents):
        quoted = _quote_identifier(name)
        params: dict[str, str] = {}
        where = ""
        if name == "agent_runs" and current_run_id:
            where = " WHERE \"run_id\" <> :current_run_id"
            params["current_run_id"] = current_run_id
        elif name == "agent_run_events" and current_run_id:
            where = " WHERE \"run_id\" <> :current_run_id"
            params["current_run_id"] = current_run_id
        elif name == "job_search_tasks" and current_task_id:
            where = " WHERE \"task_id\" <> :current_task_id"
            params["current_task_id"] = current_task_id
        result = await db.execute(text(f"DELETE FROM {quoted}{where}"), params)
        counts[name] = int(result.rowcount or 0)
    return counts


def _managed_root() -> Path:
    root = runtime_data_dir().resolve()
    if not root.is_dir():
        raise DataSafetyError("OfferU 运行数据目录不存在，拒绝执行本地数据清理。")
    _assert_managed_tree(root, root)
    return root


def _clear_directory_contents(root: Path, *, boundary: Path) -> int:
    _assert_managed_tree(root, boundary)
    root = root.resolve()
    try:
        root.relative_to(boundary.resolve())
    except ValueError as exc:
        raise DataSafetyError("清理目标不在 OfferU 受管运行目录内。") from exc
    if root.exists() and (root.is_symlink() or not root.is_dir()):
        raise DataSafetyError(f"受管清理目录不是安全的本地目录: {root.name}")
    if not root.exists():
        root.mkdir(parents=True, exist_ok=True)
        return 0

    entries = list(root.rglob("*"))
    if any(item.is_symlink() for item in entries):
        raise DataSafetyError(f"受管清理目录包含符号链接: {root.name}")

    deleted_files = 0
    for item in sorted(root.iterdir(), key=lambda path: len(path.parts), reverse=True):
        if item.is_dir():
            deleted_files += sum(1 for child in item.rglob("*") if child.is_file())
            shutil.rmtree(item)
        else:
            item.unlink()
            deleted_files += 1
    return deleted_files


def _reset_runtime_files() -> dict[str, Any]:
    root = _managed_root()
    data_root = root / "data"
    upload_root = root / "uploads"
    _assert_managed_tree(data_root, root)
    _assert_managed_tree(upload_root, root)

    directory_counts: dict[str, int] = {}
    deleted_files = 0
    for name in _DATA_DIRECTORIES:
        count = _clear_directory_contents(data_root / name, boundary=data_root)
        directory_counts[f"data/{name}"] = count
        deleted_files += count

    upload_count = _clear_directory_contents(upload_root, boundary=root)
    directory_counts["uploads"] = upload_count
    deleted_files += upload_count

    file_counts: dict[str, int] = {}
    for name, payload in _HARNESS_FILES.items():
        target = data_root / name
        _assert_managed_tree(target, data_root)
        atomic_write_json(target, payload)
        file_counts[f"data/{name}"] = 1

    return {
        "deleted_files": deleted_files,
        "reset_files": file_counts,
        "directories": directory_counts,
    }


async def reset_local_business_data(*, user_confirmed: bool) -> dict[str, Any]:
    """Clear the active local workspace while retaining safety/configuration state."""

    if user_confirmed is not True:
        raise DataSafetyError("清空本地业务数据必须由使用者明确确认。")

    # A confirmed Registry action must survive its own reset long enough for
    # AgentRunCoordinator to checkpoint the final result.
    current_run_id = ""
    current_task_id = ""
    try:
        from app.ops import _OPERATION_AUTHORIZATION

        authorization = _OPERATION_AUTHORIZATION.get()
        if authorization is not None and authorization.operation == "reset_local_business_data":
            current_run_id = authorization.run_id
    except Exception:
        current_run_id = ""

    counts: dict[str, int]
    preserved_profile_id: int | None = None
    async with async_session() as db:
        sqlite_version = await db.execute(text("SELECT sqlite_version()"))
        if sqlite_version.scalar_one_or_none() is None:
            raise DataSafetyError("当前数据库不是受支持的本地 SQLite 数据库。")

        if current_run_id:
            current_task_id = str(
                (
                    await db.execute(
                        text(
                            "SELECT task_id FROM agent_runs "
                            "WHERE run_id = :run_id"
                        ),
                        {"run_id": current_run_id},
                    )
                ).scalar_one_or_none()
                or ""
            )

        await db.execute(text("PRAGMA defer_foreign_keys = ON"))
        counts = await _delete_business_rows(
            db,
            current_run_id=current_run_id,
            current_task_id=current_task_id,
        )

        # Preserve built-in presentation/rubric configuration, but discard
        # user-created variants so the next test starts from a clean catalog.
        for model, label in (
            (ResumeTemplate, "custom_resume_templates"),
            (InterviewScoringSkill, "custom_interview_scoring_skills"),
        ):
            result = await db.execute(
                delete(model).where(model.is_builtin.is_not(True))
            )
            counts[label] = int(result.rowcount or 0)

        template = (
            await db.execute(
                select(ApplicationTemplate).order_by(ApplicationTemplate.id.asc())
            )
        ).scalars().first()
        if template is None:
            from app.services.application_workspace import _default_template_schema

            template = ApplicationTemplate(schema_json=_default_template_schema())
            db.add(template)
            await db.flush()

        workspace_settings = (
            await db.execute(
                select(ApplicationWorkspaceSettings).order_by(
                    ApplicationWorkspaceSettings.id.asc()
                )
            )
        ).scalars().first()
        if workspace_settings is None:
            db.add(ApplicationWorkspaceSettings())

        from app.services.application_workspace import _default_template_schema

        schema = (
            copy.deepcopy(template.schema_json)
            if isinstance(template.schema_json, list) and template.schema_json
            else _default_template_schema()
        )
        db.add(
            ApplicationTable(
                name="总表",
                is_total=True,
                schema_json=copy.deepcopy(schema),
            )
        )
        db.add(
            ApplicationTable(
                name="新建表",
                is_total=False,
                schema_json=copy.deepcopy(schema),
            )
        )

        default_profile = Profile(name="默认档案", is_default=True)
        db.add(default_profile)
        await db.flush()
        preserved_profile_id = int(default_profile.id)

        db.add(
            Batch(
                id="legacy-import",
                source="legacy",
                keywords=["historical"],
                location="",
                total_fetched=0,
            )
        )
        await db.commit()

    file_result = _reset_runtime_files()
    return {
        "reset": True,
        "scope": "active_local_business_workspace",
        "deleted": {key: value for key, value in counts.items() if value},
        "deleted_total_rows": sum(counts.values()),
        "default_profile_id": preserved_profile_id,
        "workspace_reinitialized": True,
        "file_cleanup_complete": True,
        "files": file_result,
        "preserved": {
            "config_files": ["config.json", ".env"],
            "provider_credentials": "system_keyring_and_config_resolution",
            "oauth_account_metadata": True,
            "built_in_templates_and_scoring": True,
            "operation_audit_logs": True,
            "data_safety_backups": True,
            "installed_plugins": True,
            "current_confirmation_run": bool(current_run_id),
        },
    }


__all__ = ["reset_local_business_data"]
