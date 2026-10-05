"""Full local business-data reset behind the Operation Registry boundary."""

from __future__ import annotations

import asyncio
import copy
import json
import os
import shutil
from pathlib import Path
from typing import Any

from sqlalchemy import delete, select, text
from sqlalchemy.engine import make_url

from app.database import async_session
from app.models.models import (
    AgentRunEvent,
    AgentRunRecord,
    ApplicationTable,
    ApplicationTemplate,
    ApplicationWorkspaceSettings,
    Batch,
    CareerTask,
    InterviewScoringSkill,
    JobSearchTask,
    Profile,
    ResumeTemplate,
)
from app.runtime_paths import runtime_data_dir
from app.services.agent_files import atomic_write_json
from app.services.data_safety import DataSafetyError, _assert_managed_tree
from app.services.harness_memory import empty_agent_memory
from app.services.reset_inventory import (
    RESET_DATA_DIRECTORIES,
    RESET_DATA_FILE_DEFAULTS,
    RESET_DATA_FILES,
)
from app.services.reset_write_guard import reset_write_guard


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

_DATA_DIRECTORIES = RESET_DATA_DIRECTORIES

_HARNESS_FILES = {
    **RESET_DATA_FILE_DEFAULTS,
    "harness_agent_memory.json": empty_agent_memory(),
}
_RESET_EPHEMERAL_FILES = {"agent_integration_challenges.json": {}}


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
    current_plan_id: str = "",
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
        elif current_plan_id and name in {
            "proposal_plans", "proposal_confirmation_groups", "proposal_operation_nodes",
            "proposal_confirmation_decisions", "proposal_execution_receipts", "proposal_continuations",
        }:
            group_ids = "SELECT id FROM proposal_confirmation_groups WHERE plan_id = :current_plan_id"
            node_ids = f"SELECT id FROM proposal_operation_nodes WHERE group_id IN ({group_ids})"
            binding = {
                "proposal_plans": "id = :current_plan_id",
                "proposal_confirmation_groups": "plan_id = :current_plan_id",
                "proposal_confirmation_decisions": "plan_id = :current_plan_id",
                "proposal_operation_nodes": f"group_id IN ({group_ids})",
                "proposal_execution_receipts": f"node_id IN ({node_ids})",
                "proposal_continuations": f"group_id IN ({group_ids})",
            }[name]
            where = f" WHERE NOT ({binding})"
            params["current_plan_id"] = current_plan_id
        result = await db.execute(text(f"DELETE FROM {quoted}{where}"), params)
        counts[name] = int(result.rowcount or 0)
    return counts


def _managed_root() -> Path:
    configured_root = str(os.environ.get("OFFERU_DATA_DIR") or "").strip()
    candidate = Path(configured_root).expanduser() if configured_root else runtime_data_dir()
    _assert_managed_tree(candidate, Path(candidate.anchor))
    root = candidate.resolve()
    if not root.is_dir():
        raise DataSafetyError("OfferU 运行数据目录不存在，拒绝执行本地数据清理。")
    _assert_managed_tree(root, root)
    return root


def _assert_reset_database_root(root: Path) -> Path:
    from app.database import engine
    from app.services.data_safety import _runtime_layout

    url = make_url(str(engine.url))
    if not url.drivername.startswith("sqlite") or not url.database or url.database == ":memory:":
        raise DataSafetyError("全清只支持位于当前 OfferU 数据目录内的 SQLite 数据库。")
    configured_path = Path(url.database)
    if not configured_path.is_absolute():
        configured_path = Path.cwd() / configured_path
    configured_path = Path(os.path.abspath(configured_path))
    _assert_managed_tree(configured_path, root)
    database_path = configured_path.resolve()

    layout = _runtime_layout()
    if layout.backend_dir.resolve() != root.resolve() or layout.database_path != database_path:
        raise DataSafetyError("当前数据库与备份服务解析的数据根不一致，拒绝执行全清。")
    if database_path.is_symlink():
        raise DataSafetyError("全清数据库不能是符号链接。")
    return database_path


def _preflight_reset_paths() -> Path:
    root = _managed_root()
    data_root = root / "data"
    _assert_managed_tree(data_root, root)
    for name in _DATA_DIRECTORIES:
        target = data_root / name
        _assert_managed_tree(target, data_root)
        if target.exists():
            if not target.is_dir():
                raise DataSafetyError(f"受管清理目录不是安全的本地目录: {name}")
            if any(item.is_symlink() for item in target.rglob("*")):
                raise DataSafetyError(f"受管清理目录包含符号链接: {name}")

    upload_root = root / "uploads"
    _assert_managed_tree(upload_root, root)
    if upload_root.exists():
        if not upload_root.is_dir():
            raise DataSafetyError("受管清理目录不是安全的本地目录: uploads")
        if any(item.is_symlink() for item in upload_root.rglob("*")):
            raise DataSafetyError("受管清理目录包含符号链接: uploads")

    for name in (*RESET_DATA_FILES, *_RESET_EPHEMERAL_FILES):
        target = data_root / name
        _assert_managed_tree(target, data_root)
        if target.exists() and not target.is_file():
            raise DataSafetyError(f"受管清理文件不是安全的本地文件: {name}")
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
    root = _preflight_reset_paths()
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

    for name, payload in _RESET_EPHEMERAL_FILES.items():
        target = data_root / name
        _assert_managed_tree(target, data_root)
        atomic_write_json(target, payload)
        file_counts[f"data/{name}"] = 1

    return {
        "deleted_files": deleted_files,
        "reset_files": file_counts,
        "directories": directory_counts,
    }


async def _authorized_reset_context() -> tuple[str, str, str, str]:
    from app.ops import _OPERATION_AUTHORIZATION
    from app.services.agent_run_state import load_agent_run

    authorization = _OPERATION_AUTHORIZATION.get()
    if authorization is None or authorization.operation != "reset_local_business_data":
        raise DataSafetyError("全清只能通过已确认的 Operation Registry 提案执行。")
    if not all((authorization.run_id, authorization.action_id, authorization.idempotency_key)):
        raise DataSafetyError("全清授权缺少持久化 Run、动作或幂等键。")
    from app.services.proposal_plan_store import get_plan
    from app.services.proposal_plan_builder import verify_plan_snapshot

    plan = await get_plan(authorization.plan_id)
    if plan is None:
        raise DataSafetyError("全清授权没有持久化 v2 Plan。")
    verify_plan_snapshot(plan)
    nodes = [node for group in plan["groups"] for node in group["nodes"]]
    if len(nodes) != 1 or nodes[0]["operation"] != "reset_local_business_data" or nodes[0]["id"] != authorization.node_id:
        raise DataSafetyError("全清只能在独立的单操作 Plan 中执行。")

    run = await load_agent_run(authorization.run_id)
    step = next(
        (
            item
            for item in (run or {}).get("steps") or []
            if isinstance(item, dict)
            and str(item.get("id") or "") == authorization.action_id
        ),
        None,
    )
    if (
        step is None
        or str(step.get("tool") or "") != "reset_local_business_data"
        or str(step.get("idempotency_key") or "") != authorization.idempotency_key
        or str(step.get("status") or "") != "executing"
    ):
        raise DataSafetyError("全清授权未对应到已确认且正在执行的持久化提案。")
    task_id = str((run or {}).get("task_id") or "")
    return str(authorization.run_id), task_id, str(authorization.action_id), str(authorization.plan_id)


async def _scrub_current_reset_run(db: Any, *, run_id: str, action_id: str) -> None:
    run = await db.get(AgentRunRecord, run_id)
    if run is None:
        raise DataSafetyError("全清确认 Run 已不存在，拒绝删除职业数据。")
    from app.models.models import ProposalOperationNode
    node = await db.get(ProposalOperationNode, action_id)
    reset_step = json.loads(node.snapshot_json) if node is not None else None
    if (
        reset_step is None
        or reset_step.get("operation") != "reset_local_business_data"
        or node.status != "executing"
    ):
        raise DataSafetyError("全清确认步骤已变化，拒绝删除职业数据。")

    run.conversation_id = ""
    run.goal = "Owner Fresh Reset"
    run.mode = "ui_operation_request"
    run.skill_snapshot_json = {}
    run.steps_json = []
    run.exit_criteria_json = ["reset receipt checkpointed"]
    run.llm_runtime_json = {"runtime": "none", "reason": "fresh_reset_context_closed"}
    run.recovery_cursor_json = {}
    run.final_result_json = {
        "assistant_message": "OfferU was reset. Start a fresh session.",
        "requires_confirmation": False,
        "turn_finished": True,
    }
    run.failure_reason = ""
    run.harness_name = ""
    run.harness_version = ""
    run.adapter_name = ""
    run.adapter_version = ""
    run.harness_session_id = ""
    run.lease_id = ""
    run.lease_expires_at = None

    task = await db.get(JobSearchTask, run.task_id)
    if task is not None:
        task.conversation_id = ""
        task.title = "Fresh reset receipt"
        task.goal = "OfferU local career data reset"
        task.status = "completed"
        task.primary_job_id = None
        task.domain_refs_json = {"operation": "reset_local_business_data"}
    await db.execute(delete(AgentRunEvent).where(AgentRunEvent.run_id == run_id))


async def _cancel_task_objects(tasks: list[asyncio.Task[Any]]) -> int:
    current = asyncio.current_task()
    active = [task for task in tasks if task is not current and not task.done()]
    for task in active:
        task.cancel()
    if active:
        await asyncio.gather(*active, return_exceptions=True)
    return len(active)


async def _quiesce_active_work(*, current_run_id: str, current_task_id: str) -> dict[str, int]:
    from app.services.career_tasks import _LIVE_TASKS, cancel_career_task
    from app.services.embedded_agent_worker import get_embedded_agent_worker
    from app.services.job_research import cancel_job_research
    from app.services.memory_distiller import stop_memory_distill_service

    await stop_memory_distill_service()

    async with async_session() as db:
        active_task_ids = [
            str(value)
            for value in (
                await db.execute(
                    select(CareerTask.task_id).where(
                        CareerTask.status.in_(("queued", "running", "waiting_for_approval"))
                    )
                )
            ).scalars()
            .all()
        ]
    career_cancelled = 0
    for task_id in active_task_ids:
        if task_id == current_task_id:
            continue
        await cancel_career_task(task_id)
        career_cancelled += 1
    career_workers_cancelled = await _cancel_task_objects(
        [task for task_id, task in _LIVE_TASKS.items() if task_id != current_task_id]
    )

    import app.services.job_research as job_research

    research_cancelled = 0
    for run_id, task in list(job_research._LIVE_TASKS.items()):
        if task.done():
            continue
        await cancel_job_research(run_id)
        research_cancelled += 1

    import app.services.role_intelligence as role_intelligence

    benchmark_cancelled = await _cancel_task_objects(list(role_intelligence._LIVE_TASKS.values()))

    from app.services import batch_job_evaluations

    batch_workers_cancelled = await _cancel_task_objects(list(batch_job_evaluations._LIVE_TASKS))

    from app.services.agent_runtime_tasks import BACKGROUND_RUNTIME_TASKS

    runtime_streams_cancelled = await _cancel_task_objects(
        list(BACKGROUND_RUNTIME_TASKS)
    )

    worker = get_embedded_agent_worker()
    active_run_id = worker.active_run_id
    if active_run_id == current_run_id:
        await worker.dispose_run(active_run_id)
    elif active_run_id:
        from app.services.embedded_agent_host import abort_embedded_agent_run

        await abort_embedded_agent_run(active_run_id, worker=worker)

    return {
        "career_tasks": career_cancelled,
        "career_task_workers": career_workers_cancelled,
        "job_research_runs": research_cancelled,
        "role_benchmark_workers": benchmark_cancelled,
        "batch_workers": batch_workers_cancelled,
        "agent_runtime_streams": runtime_streams_cancelled,
        "embedded_agent_runs": int(bool(active_run_id and active_run_id != current_run_id)),
    }


async def _reset_semantic_indexes() -> dict[str, Any]:
    try:
        from app.services.semantic_search import get_semantic_search
    except ModuleNotFoundError as exc:
        if exc.name != "qdrant_client":
            raise
        from app.config import get_settings

        if str(get_settings().qdrant_host or "").strip():
            raise DataSafetyError(
                "已配置的 OfferU 搜索索引不可访问；为避免重置后重新读到旧数据，未清理职业数据库。"
            ) from exc
        return {
            "state": "not_applicable",
            "reason": "semantic_index_not_configured",
            "collections_cleared": [],
            "embedding_cache_cleared": False,
        }
    return await get_semantic_search().reset_career_indexes()


async def reset_local_business_data() -> dict[str, Any]:
    """Clear the active local workspace while retaining safety/configuration state."""

    current_run_id, current_task_id, current_action_id, current_plan_id = await _authorized_reset_context()
    active_root = _preflight_reset_paths()
    _assert_reset_database_root(active_root)

    async with reset_write_guard():
        # Recheck after in-flight materializers have settled and before any
        # backup or destructive work starts.
        active_root = _preflight_reset_paths()
        _assert_reset_database_root(active_root)
        from app.ops import execute_operation

        safety_result = await execute_operation(
            "get_data_safety_status", {}, surface="local_data_reset"
        )
        if not safety_result.get("ok"):
            raise DataSafetyError(
                "; ".join(str(item) for item in safety_result.get("errors") or [])
                or "无法检查恢复状态，拒绝执行本地数据清理。"
            )
        if (safety_result.get("outputs") or {}).get("pending_restore"):
            raise DataSafetyError("存在待重启恢复任务；请先取消恢复，避免重启后旧数据重新出现。")

        # Backup is part of this approved reset, not a second Career Truth
        # change. Do not reuse the reset node's authorization for another op.
        from app.ops import _OPERATION_AUTHORIZATION
        token = _OPERATION_AUTHORIZATION.set(None)
        try:
            backup_result = await execute_operation(
                "create_data_backup", {"reason": "pre_reset"}, surface="local_data_reset"
            )
        finally:
            _OPERATION_AUTHORIZATION.reset(token)
        if not backup_result.get("ok"):
            raise DataSafetyError(
                "; ".join(str(item) for item in backup_result.get("errors") or [])
                or "全清前备份失败，未清理本地职业数据。"
            )
        backup = backup_result.get("outputs") or {}
        if not backup.get("backup_id"):
            raise DataSafetyError("全清前未能确认可恢复备份，拒绝清理本地职业数据。")

        quiesced = await _quiesce_active_work(
            current_run_id=current_run_id,
            current_task_id=current_task_id,
        )
        _preflight_reset_paths()

        cleared_indexes = await _reset_semantic_indexes()

        counts: dict[str, int]
        preserved_profile_id: int | None = None
        async with async_session() as db:
            sqlite_version = await db.execute(text("SELECT sqlite_version()"))
            if sqlite_version.scalar_one_or_none() is None:
                raise DataSafetyError("当前数据库不是受支持的本地 SQLite 数据库。")

            if current_run_id:
                persisted_task_id = str(
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
                if persisted_task_id != current_task_id:
                    raise DataSafetyError("重置确认 Run 的任务关联在执行前发生变化。")
                await _scrub_current_reset_run(
                    db,
                    run_id=current_run_id,
                    action_id=current_action_id,
                )

            await db.execute(text("PRAGMA defer_foreign_keys = ON"))
            counts = await _delete_business_rows(
                db,
                current_run_id=current_run_id,
                current_task_id=current_task_id,
                current_plan_id=current_plan_id,
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
        "backup": {
            "backup_id": backup.get("backup_id"),
            "created_at": backup.get("created_at"),
            "size_bytes": backup.get("size_bytes"),
            "reason": backup.get("reason"),
            "archive_sha256": backup.get("archive_sha256"),
        },
        "quiesced": quiesced,
        "cleared_indexes": cleared_indexes,
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
