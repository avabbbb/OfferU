from __future__ import annotations

import asyncio
import fnmatch
import hashlib
import json
import os
import secrets
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from sqlalchemy import select

from app.database import async_session
from app.models.models import (
    CareerSource,
    WorkSource,
    WorkSourceSyncRun,
)
from app.services.career_memory import (
    invalidate_memory_source,
    record_learning_observation,
)
from app.services.coding_agent_runtime import run_coding_agent, select_runtime


SOURCE_TYPES = frozenset({"directory", "git_repository"})
SOURCE_STATUSES = frozenset({"active", "invalidated"})
RUN_STATUSES = frozenset({"pending", "running", "completed", "failed"})
TEXT_EXTENSIONS = frozenset(
    {
        ".c",
        ".cc",
        ".cpp",
        ".cs",
        ".css",
        ".go",
        ".h",
        ".hpp",
        ".html",
        ".java",
        ".js",
        ".jsx",
        ".json",
        ".kt",
        ".kts",
        ".md",
        ".php",
        ".proto",
        ".py",
        ".rb",
        ".rs",
        ".scss",
        ".sh",
        ".sql",
        ".svelte",
        ".swift",
        ".toml",
        ".ts",
        ".tsx",
        ".txt",
        ".vue",
        ".xml",
        ".yaml",
        ".yml",
    }
)
DEFAULT_EXCLUDES = (
    ".git/**",
    ".hg/**",
    ".svn/**",
    ".next/**",
    ".nuxt/**",
    ".pytest_cache/**",
    ".ruff_cache/**",
    ".tox/**",
    ".venv/**",
    ".vscode/**",
    "__pycache__/**",
    "build/**",
    "coverage/**",
    "dist/**",
    "node_modules/**",
    "target/**",
)
SECRET_NAMES = frozenset(
    {
        ".env",
        "auth.json",
        "cookies.json",
        "credentials.json",
        "secrets.json",
        "storage-state.json",
        "storage_state.json",
    }
)
SECRET_SUFFIXES = (
    ".key",
    ".keystore",
    ".p12",
    ".pfx",
    ".pem",
)
MAX_FILES = 2_000
MAX_FILE_BYTES = 2_000_000
MAX_EXCERPT_CHARS_PER_FILE = 12_000
MAX_PROMPT_EXCERPT_CHARS = 120_000
RUN_ROOT = Path(__file__).resolve().parents[2] / "data" / "work-source-runs"
_RUN_TASKS: dict[str, asyncio.Task[None]] = {}


WORK_SOURCE_RESULT_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": [
        "summary",
        "accomplishments",
        "current_focus",
        "risks",
        "memory_candidates",
    ],
    "properties": {
        "summary": {"type": "string", "minLength": 1, "maxLength": 4000},
        "accomplishments": {
            "type": "array",
            "maxItems": 20,
            "items": {"type": "string", "minLength": 1, "maxLength": 1000},
        },
        "current_focus": {
            "type": "array",
            "maxItems": 20,
            "items": {"type": "string", "minLength": 1, "maxLength": 1000},
        },
        "risks": {
            "type": "array",
            "maxItems": 20,
            "items": {"type": "string", "minLength": 1, "maxLength": 1000},
        },
        "memory_candidates": {
            "type": "array",
            "maxItems": 20,
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": [
                    "target_tier",
                    "section_type",
                    "title",
                    "statement",
                    "reason",
                    "completion_status",
                    "supporting_paths",
                    "impact",
                ],
                "properties": {
                    "target_tier": {
                        "type": "string",
                        "enum": ["verified_fact", "career_hypothesis"],
                    },
                    "section_type": {
                        "type": "string",
                        "minLength": 2,
                        "maxLength": 60,
                        "pattern": "^[a-z][a-z0-9_]+$",
                    },
                    "title": {"type": "string", "minLength": 1, "maxLength": 220},
                    "statement": {"type": "string", "minLength": 1, "maxLength": 4000},
                    "reason": {"type": "string", "minLength": 1, "maxLength": 4000},
                    "completion_status": {
                        "type": "string",
                        "enum": ["completed", "in_progress", "unknown"],
                    },
                    "supporting_paths": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": 20,
                        "items": {"type": "string", "minLength": 1, "maxLength": 1000},
                    },
                    "impact": {
                        "type": "array",
                        "maxItems": 20,
                        "items": {"type": "string", "minLength": 1, "maxLength": 500},
                    },
                },
            },
        },
    },
}


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _clean_text(value: Any, field: str, *, limit: int, required: bool = False) -> str:
    text = str(value or "").strip()
    if required and not text:
        raise ValueError(f"{field} 不能为空")
    if len(text) > limit:
        raise ValueError(f"{field} 最长 {limit} 个字符")
    return text


def _clean_patterns(value: Optional[list[str]], field: str) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise ValueError(f"{field} 必须是字符串数组")
    if len(value) > 100:
        raise ValueError(f"{field} 最多包含 100 项")
    return [
        _clean_text(item, f"{field} item", limit=300, required=True).replace("\\", "/")
        for item in value
    ]


def _path_key(path: Path) -> str:
    normalized = str(path).replace("\\", "/")
    return normalized.casefold() if os.name == "nt" else normalized


def _source_key(source_type: str, path: Path) -> str:
    return hashlib.sha256(f"{source_type}:{_path_key(path)}".encode("utf-8")).hexdigest()


def _canonical_hash(value: Any) -> str:
    payload = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _secret_like(relative_path: str) -> bool:
    name = relative_path.rsplit("/", 1)[-1].casefold()
    if name in SECRET_NAMES or name.startswith(".env."):
        return True
    if name.endswith(SECRET_SUFFIXES):
        return True
    return any(
        token in name
        for token in (
            "credential",
            "private-key",
            "private_key",
            "client_secret",
            "access_token",
            "refresh_token",
            "api_key",
            "apikey",
            "password",
        )
    )


def _matches_any(relative_path: str, patterns: list[str] | tuple[str, ...]) -> bool:
    return any(
        fnmatch.fnmatch(relative_path, pattern)
        or fnmatch.fnmatch(relative_path.rsplit("/", 1)[-1], pattern)
        for pattern in patterns
    )


def _included(
    relative_path: str,
    *,
    include_patterns: list[str],
    exclude_patterns: list[str],
) -> bool:
    if _secret_like(relative_path):
        return False
    if _matches_any(relative_path, (*DEFAULT_EXCLUDES, *exclude_patterns)):
        return False
    if include_patterns and not _matches_any(relative_path, include_patterns):
        return False
    return Path(relative_path).suffix.casefold() in TEXT_EXTENSIONS


def _manifest(
    root: Path,
    *,
    include_patterns: list[str],
    exclude_patterns: list[str],
) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for current_root, dirnames, filenames in os.walk(root, followlinks=False):
        current = Path(current_root)
        safe_dirs: list[str] = []
        for dirname in dirnames:
            candidate = current / dirname
            relative = candidate.relative_to(root).as_posix() + "/"
            if candidate.is_symlink():
                continue
            if _matches_any(relative, (*DEFAULT_EXCLUDES, *exclude_patterns)):
                continue
            safe_dirs.append(dirname)
        dirnames[:] = safe_dirs

        for filename in filenames:
            path = current / filename
            if path.is_symlink():
                continue
            relative = path.relative_to(root).as_posix()
            if not _included(
                relative,
                include_patterns=include_patterns,
                exclude_patterns=exclude_patterns,
            ):
                continue
            try:
                stat = path.stat()
                if stat.st_size > MAX_FILE_BYTES:
                    continue
                digest = hashlib.sha256(path.read_bytes()).hexdigest()
            except (OSError, PermissionError):
                continue
            result[relative] = {
                "sha256": digest,
                "size": int(stat.st_size),
                "mtime_ns": int(stat.st_mtime_ns),
            }
            if len(result) > MAX_FILES:
                raise ValueError(f"工作源可同步文本文件超过上限 {MAX_FILES}")
    return dict(sorted(result.items()))


def _changes(
    before: dict[str, dict[str, Any]],
    after: dict[str, dict[str, Any]],
) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    for path in sorted(set(before) | set(after)):
        if path not in before:
            rows.append({"path": path, "change": "added"})
        elif path not in after:
            rows.append({"path": path, "change": "deleted"})
        elif before[path].get("sha256") != after[path].get("sha256"):
            rows.append({"path": path, "change": "modified"})
    return rows


def _excerpts(root: Path, changes: list[dict[str, str]]) -> tuple[str, int]:
    parts: list[str] = []
    total = 0
    sent_files = 0
    for item in changes:
        if item["change"] == "deleted":
            continue
        path = root / item["path"]
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except (OSError, PermissionError):
            continue
        remaining = MAX_PROMPT_EXCERPT_CHARS - total
        if remaining <= 0:
            break
        excerpt = text[: min(MAX_EXCERPT_CHARS_PER_FILE, remaining)]
        parts.append(
            f"\n<changed_file path={json.dumps(item['path'], ensure_ascii=False)} "
            f"change={json.dumps(item['change'])}>\n{excerpt}\n</changed_file>"
        )
        total += len(excerpt)
        sent_files += 1
    return "".join(parts), sent_files


def _snapshot(
    root: Path,
    before_checkpoint: dict[str, Any],
    include_patterns: list[str],
    exclude_patterns: list[str],
) -> tuple[dict[str, Any], list[dict[str, str]], str, int]:
    manifest = _manifest(
        root,
        include_patterns=include_patterns,
        exclude_patterns=exclude_patterns,
    )
    fingerprint = _canonical_hash(
        {path: item["sha256"] for path, item in manifest.items()}
    )
    checkpoint = {
        "version": 1,
        "fingerprint": fingerprint,
        "manifest": manifest,
        "file_count": len(manifest),
    }
    before_manifest = before_checkpoint.get("manifest")
    if not isinstance(before_manifest, dict):
        before_manifest = {}
    changes = _changes(before_manifest, manifest)
    excerpts, sent_files = _excerpts(root, changes)
    return checkpoint, changes, excerpts, sent_files


def _worker_prompt(
    source_name: str,
    source_type: str,
    changes: list[dict[str, str]],
    excerpts: str,
) -> str:
    change_list = "\n".join(
        f"- {item['change']}: {item['path']}" for item in changes[:300]
    )
    return f"""You are the read-only work-source summarizer for OfferU.

Registered source: {source_name}
Source type: {source_type}

Changed paths:
{change_list}

The following excerpts are the only work content you may use:
{excerpts}

Return exactly one JSON object matching the supplied schema.
Rules:
1. Describe only evidence visible in the changed paths and excerpts.
2. Do not claim that unfinished code, TODOs, drafts, or experiments are completed achievements.
3. A verified_fact candidate requires completion_status=completed and at least one supporting path.
4. Use career_hypothesis for in-progress or uncertain capability signals.
5. Never infer personality, seniority, employment, business impact, metrics, or ownership without evidence.
6. Do not copy secrets, credentials, tokens, or long source excerpts into the result.
7. This result is only a review candidate. It never updates the user's career facts directly.
"""


def _clean_string_list(value: Any, field: str, limit: int) -> list[str]:
    if not isinstance(value, list):
        raise ValueError(f"coding-agent {field} 必须是数组")
    return [
        _clean_text(item, f"{field} item", limit=limit, required=True)
        for item in value[:20]
    ]


def _validated_result(
    payload: Any,
    changes: list[dict[str, str]],
) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("coding-agent 工作源结果必须是 JSON 对象")
    changed_paths = {item["path"] for item in changes}
    verified_paths = {
        item["path"] for item in changes if item["change"] in {"added", "modified"}
    }
    summary = _clean_text(payload.get("summary"), "summary", limit=4000, required=True)
    accomplishments = _clean_string_list(
        payload.get("accomplishments"), "accomplishments", 1000
    )
    current_focus = _clean_string_list(payload.get("current_focus"), "current_focus", 1000)
    risks = _clean_string_list(payload.get("risks"), "risks", 1000)
    raw_candidates = payload.get("memory_candidates")
    if not isinstance(raw_candidates, list):
        raise ValueError("coding-agent memory_candidates 必须是数组")
    candidates: list[dict[str, Any]] = []
    for raw in raw_candidates[:20]:
        if not isinstance(raw, dict):
            raise ValueError("memory candidate 必须是对象")
        tier = _clean_text(
            raw.get("target_tier"),
            "target_tier",
            limit=32,
            required=True,
        )
        if tier not in {"verified_fact", "career_hypothesis"}:
            raise ValueError("工作源候选只允许 verified_fact 或 career_hypothesis")
        completion = _clean_text(
            raw.get("completion_status"),
            "completion_status",
            limit=24,
            required=True,
        )
        if completion not in {"completed", "in_progress", "unknown"}:
            raise ValueError("无效的 completion_status")
        if tier == "verified_fact" and completion != "completed":
            tier = "career_hypothesis"
        supporting_paths = _clean_string_list(
            raw.get("supporting_paths"), "supporting_paths", 1000
        )
        if not supporting_paths or any(path not in changed_paths for path in supporting_paths):
            raise ValueError("memory candidate 必须引用本次变化中的 supporting_paths")
        if tier == "verified_fact" and any(
            path not in verified_paths for path in supporting_paths
        ):
            tier = "career_hypothesis"
        statement = _clean_text(
            raw.get("statement"), "statement", limit=4000, required=True
        )
        candidates.append(
            {
                "target_tier": tier,
                "section_type": _clean_text(
                    raw.get("section_type"),
                    "section_type",
                    limit=60,
                    required=True,
                ),
                "title": _clean_text(raw.get("title"), "title", limit=220, required=True),
                "after": {
                    "description": statement,
                    "bullet": statement,
                    "completion_status": completion,
                    "supporting_paths": supporting_paths,
                },
                "reason": _clean_text(
                    raw.get("reason"), "reason", limit=4000, required=True
                ),
                "impact": _clean_string_list(raw.get("impact"), "impact", 500),
            }
        )
    return {
        "summary": summary,
        "accomplishments": accomplishments,
        "current_focus": current_focus,
        "risks": risks,
        "memory_candidates": candidates,
    }


def _source_payload(source: WorkSource) -> dict[str, Any]:
    return {
        "id": source.id,
        "name": source.name,
        "source_type": source.source_type,
        "root_path": source.root_path,
        "runtime_id": source.runtime_id,
        "include_patterns": source.include_patterns_json or [],
        "exclude_patterns": source.exclude_patterns_json or [],
        "status": source.status,
        "last_fingerprint": (source.checkpoint_json or {}).get("fingerprint"),
        "last_synced_at": str(source.last_synced_at) if source.last_synced_at else None,
        "created_at": str(source.created_at),
        "updated_at": str(source.updated_at),
    }


def _run_payload(run: WorkSourceSyncRun) -> dict[str, Any]:
    return {
        "run_id": run.run_id,
        "work_source_id": run.work_source_id,
        "runtime_id": run.runtime_id,
        "runtime_version": run.runtime_version,
        "status": run.status,
        "attempts": run.attempts,
        "observation_id": run.observation_id,
        "result": run.result_json or {},
        "trace": run.trace_json or {},
        "error": run.error,
        "created_at": str(run.created_at),
        "started_at": str(run.started_at) if run.started_at else None,
        "completed_at": str(run.completed_at) if run.completed_at else None,
    }


async def register_work_source(
    *,
    name: str,
    root_path: str,
    source_type: str = "directory",
    runtime_id: str = "auto",
    include_patterns: Optional[list[str]] = None,
    exclude_patterns: Optional[list[str]] = None,
) -> dict[str, Any]:
    clean_name = _clean_text(name, "name", limit=220, required=True)
    clean_type = _clean_text(
        source_type, "source_type", limit=32, required=True
    ).lower()
    if clean_type not in SOURCE_TYPES:
        raise ValueError("source_type 仅支持 directory 或 git_repository")
    clean_runtime = _clean_text(
        runtime_id, "runtime_id", limit=40, required=True
    ).lower()
    path = Path(_clean_text(root_path, "root_path", limit=4000, required=True)).expanduser()
    try:
        path = path.resolve(strict=True)
    except OSError as exc:
        raise ValueError("工作源目录不存在或不可访问") from exc
    if not path.is_dir():
        raise ValueError("root_path 必须是目录")
    if clean_type == "git_repository" and not (path / ".git").exists():
        raise ValueError("git_repository 工作源根目录未发现 .git")
    clean_include = _clean_patterns(include_patterns, "include_patterns")
    clean_exclude = _clean_patterns(exclude_patterns, "exclude_patterns")
    key = _source_key(clean_type, path)

    async with async_session() as db:
        existing = (
            await db.execute(select(WorkSource).where(WorkSource.source_key == key))
        ).scalar_one_or_none()
        if existing is not None:
            if existing.status != "active":
                raise ValueError("该工作源已失效，不能复用")
            return {**_source_payload(existing), "duplicate": True}
        source = WorkSource(
            source_key=key,
            name=clean_name,
            source_type=clean_type,
            root_path=str(path),
            runtime_id=clean_runtime,
            include_patterns_json=clean_include,
            exclude_patterns_json=clean_exclude,
            checkpoint_json={},
            status="active",
        )
        db.add(source)
        await db.commit()
        await db.refresh(source)
        return {**_source_payload(source), "duplicate": False}


async def list_work_sources(
    *,
    status: str = "active",
    limit: int = 100,
) -> dict[str, Any]:
    clean_status = _clean_text(status, "status", limit=24).lower() or "active"
    if clean_status not in SOURCE_STATUSES | {"all"}:
        raise ValueError("status 必须是 active、invalidated 或 all")
    safe_limit = max(1, min(int(limit), 500))
    query = select(WorkSource).order_by(WorkSource.updated_at.desc()).limit(safe_limit)
    if clean_status != "all":
        query = query.where(WorkSource.status == clean_status)
    async with async_session() as db:
        sources = (await db.execute(query)).scalars().all()
    return {"total": len(sources), "items": [_source_payload(item) for item in sources]}


async def get_work_source(work_source_id: int) -> dict[str, Any]:
    async with async_session() as db:
        source = (
            await db.execute(
                select(WorkSource).where(WorkSource.id == int(work_source_id))
            )
        ).scalar_one_or_none()
    if source is None:
        raise ValueError(f"work source #{work_source_id} not found")
    return _source_payload(source)


def _schedule(run_id: str) -> None:
    existing = _RUN_TASKS.get(run_id)
    if existing and not existing.done():
        return
    task = asyncio.create_task(_execute_sync(run_id))
    _RUN_TASKS[run_id] = task
    task.add_done_callback(lambda _task: _RUN_TASKS.pop(run_id, None))


async def start_work_source_sync(
    *,
    work_source_id: int,
    data_consent: bool,
    runtime_id: Optional[str] = None,
) -> dict[str, Any]:
    if data_consent is not True:
        raise ValueError("同步前必须明确授权本次工作源内容发送给所选 coding agent")
    async with async_session() as db:
        source = (
            await db.execute(
                select(WorkSource).where(WorkSource.id == int(work_source_id))
            )
        ).scalar_one_or_none()
        if source is None:
            raise ValueError(f"work source #{work_source_id} not found")
        if source.status != "active":
            raise ValueError("失效工作源不能同步")
        selected_runtime = _clean_text(
            runtime_id or source.runtime_id,
            "runtime_id",
            limit=40,
            required=True,
        ).lower()
        if selected_runtime == "auto":
            # 按 settings.coding_agent_priority 解析为具体 runtime
            selected_runtime = str((await select_runtime()).get("id"))
        run = WorkSourceSyncRun(
            run_id=f"work-sync-{secrets.token_hex(16)}",
            work_source_id=source.id,
            runtime_id=selected_runtime,
            status="pending",
            checkpoint_before_json=source.checkpoint_json or {},
        )
        db.add(run)
        await db.commit()
        await db.refresh(run)
        payload = _run_payload(run)
    _schedule(run.run_id)
    return payload


async def _execute_sync(run_id: str) -> None:
    async with async_session() as db:
        run = (
            await db.execute(
                select(WorkSourceSyncRun).where(WorkSourceSyncRun.run_id == run_id)
            )
        ).scalar_one_or_none()
        if run is None or run.status not in {"pending", "failed"}:
            return
        source = (
            await db.execute(
                select(WorkSource).where(WorkSource.id == run.work_source_id)
            )
        ).scalar_one_or_none()
        if source is None or source.status != "active":
            run.status = "failed"
            run.error = "工作源不存在或已失效"
            run.completed_at = _now()
            await db.commit()
            return
        run.status = "running"
        run.error = ""
        run.attempts += 1
        run.started_at = _now()
        await db.commit()
        source_id = source.id
        source_name = source.name
        source_type = source.source_type
        source_path = Path(source.root_path)
        include_patterns = list(source.include_patterns_json or [])
        exclude_patterns = list(source.exclude_patterns_json or [])
        runtime_id = run.runtime_id
        before_checkpoint = dict(run.checkpoint_before_json or {})

    try:
        checkpoint, changes, excerpts, sent_files = await asyncio.to_thread(
            _snapshot,
            source_path,
            before_checkpoint,
            include_patterns,
            exclude_patterns,
        )
        if not changes:
            result = {
                "no_change": True,
                "summary": "工作源自上次同步后没有可同步文本变化。",
                "changed_files": [],
                "memory_candidates": [],
            }
            trace = {
                "schema_enforced": False,
                "model_called": False,
                "sent_file_count": 0,
                "sent_excerpt_chars": 0,
            }
            observation_id = None
            runtime_version = ""
        else:
            run_dir = RUN_ROOT / run_id
            worker = await run_coding_agent(
                runtime_id=runtime_id,
                prompt=_worker_prompt(source_name, source_type, changes, excerpts),
                cwd=run_dir,
                output_schema=WORK_SOURCE_RESULT_SCHEMA,
                timeout_seconds=600,
                web_search_mode="disabled",
            )
            result = _validated_result(worker["structured"], changes)
            result["no_change"] = False
            result["changed_files"] = changes[:300]
            result["changed_file_count"] = len(changes)
            trace = {
                **worker["trace"],
                "sent_file_count": sent_files,
                "sent_excerpt_chars": len(excerpts),
                "raw_source_stored": False,
            }
            runtime_version = str(worker.get("runtime_version") or "")
            observation = await record_learning_observation(
                source_type="work_source",
                source_external_id=f"work-source:{source_id}",
                source_title=source_name,
                source_locator=f"work-source:{source_id}",
                source_metadata={
                    "source_type": source_type,
                    "storage": "summary_only",
                },
                observation_type="work_source_change",
                content={
                    "source_excerpt": result["summary"],
                    "statement": result["summary"],
                    "accomplishments": result["accomplishments"],
                    "current_focus": result["current_focus"],
                    "risks": result["risks"],
                    "memory_candidates": result["memory_candidates"],
                    "changed_files": result["changed_files"],
                    "from_fingerprint": before_checkpoint.get("fingerprint"),
                    "to_fingerprint": checkpoint["fingerprint"],
                },
                idempotency_key=f"work-source:{source_id}:{checkpoint['fingerprint']}",
            )
            observation_id = int(observation["id"])

            from app.services.memory_consolidation import consolidate_memory_observations

            await consolidate_memory_observations(
                observation_ids=[observation_id],
                limit=20,
            )

        async with async_session() as db:
            stored_run = (
                await db.execute(
                    select(WorkSourceSyncRun).where(WorkSourceSyncRun.run_id == run_id)
                )
            ).scalar_one()
            stored_source = (
                await db.execute(
                    select(WorkSource).where(WorkSource.id == source_id)
                )
            ).scalar_one()
            if stored_source.status != "active":
                raise ValueError("工作源在同步期间被撤销")
            stored_source.checkpoint_json = checkpoint
            stored_source.last_synced_at = _now()
            stored_run.checkpoint_after_json = checkpoint
            stored_run.result_json = result
            stored_run.trace_json = trace
            stored_run.runtime_version = runtime_version
            stored_run.observation_id = observation_id
            stored_run.status = "completed"
            stored_run.completed_at = _now()
            stored_run.error = ""
            await db.commit()
    except asyncio.CancelledError:
        async with async_session() as db:
            stored = (
                await db.execute(
                    select(WorkSourceSyncRun).where(WorkSourceSyncRun.run_id == run_id)
                )
            ).scalar_one_or_none()
            if stored is not None and stored.status == "running":
                stored.status = "failed"
                stored.error = "工作源同步被取消，可显式恢复"
                stored.completed_at = _now()
                await db.commit()
        raise
    except Exception as exc:
        invalidated_memory_source_id = None
        async with async_session() as db:
            stored = (
                await db.execute(
                    select(WorkSourceSyncRun).where(WorkSourceSyncRun.run_id == run_id)
                )
            ).scalar_one_or_none()
            if stored is not None:
                stored.status = "failed"
                stored.error = str(exc)[:4000]
                stored.completed_at = _now()
                stored_source = (
                    await db.execute(
                        select(WorkSource).where(
                            WorkSource.id == stored.work_source_id
                        )
                    )
                ).scalar_one_or_none()
                if stored_source is not None and stored_source.status == "invalidated":
                    memory_source = (
                        await db.execute(
                            select(CareerSource)
                            .where(CareerSource.source_type == "work_source")
                            .where(
                                CareerSource.external_id
                                == f"work-source:{stored.work_source_id}"
                            )
                        )
                    ).scalar_one_or_none()
                    invalidated_memory_source_id = (
                        memory_source.id if memory_source is not None else None
                    )
                await db.commit()
        if invalidated_memory_source_id is not None:
            await invalidate_memory_source(
                source_id=invalidated_memory_source_id,
                reason="工作源在同步期间被撤销",
            )


async def resume_work_source_sync(run_id: str) -> dict[str, Any]:
    clean_run_id = _clean_text(run_id, "run_id", limit=64, required=True)
    async with async_session() as db:
        run = (
            await db.execute(
                select(WorkSourceSyncRun).where(WorkSourceSyncRun.run_id == clean_run_id)
            )
        ).scalar_one_or_none()
        if run is None:
            raise ValueError(f"work source sync run {clean_run_id} not found")
        if run.status == "completed":
            return _run_payload(run)
        if run.status == "running":
            raise ValueError("工作源同步仍在运行")
        run.status = "pending"
        run.error = ""
        await db.commit()
        await db.refresh(run)
        payload = _run_payload(run)
    _schedule(clean_run_id)
    return payload


async def list_work_source_sync_runs(
    *,
    work_source_id: Optional[int] = None,
    status: Optional[str] = None,
    limit: int = 50,
) -> dict[str, Any]:
    safe_limit = max(1, min(int(limit), 500))
    query = select(WorkSourceSyncRun).order_by(
        WorkSourceSyncRun.created_at.desc()
    ).limit(safe_limit)
    if work_source_id is not None:
        query = query.where(WorkSourceSyncRun.work_source_id == int(work_source_id))
    if status:
        clean_status = _clean_text(status, "status", limit=24).lower()
        if clean_status not in RUN_STATUSES:
            raise ValueError("无效的工作源同步状态")
        query = query.where(WorkSourceSyncRun.status == clean_status)
    async with async_session() as db:
        runs = (await db.execute(query)).scalars().all()
    return {"total": len(runs), "items": [_run_payload(item) for item in runs]}


async def get_work_source_sync_run(run_id: str) -> dict[str, Any]:
    clean_run_id = _clean_text(run_id, "run_id", limit=64, required=True)
    async with async_session() as db:
        run = (
            await db.execute(
                select(WorkSourceSyncRun).where(WorkSourceSyncRun.run_id == clean_run_id)
            )
        ).scalar_one_or_none()
    if run is None:
        raise ValueError(f"work source sync run {clean_run_id} not found")
    return _run_payload(run)


async def invalidate_work_source(
    *,
    work_source_id: int,
    reason: str,
) -> dict[str, Any]:
    clean_reason = _clean_text(reason, "reason", limit=4000, required=True)
    async with async_session() as db:
        source = (
            await db.execute(
                select(WorkSource).where(WorkSource.id == int(work_source_id))
            )
        ).scalar_one_or_none()
        if source is None:
            raise ValueError(f"work source #{work_source_id} not found")
        memory_source = (
            await db.execute(
                select(CareerSource)
                .where(CareerSource.source_type == "work_source")
                .where(CareerSource.external_id == f"work-source:{source.id}")
            )
        ).scalar_one_or_none()
        runs = (
            await db.execute(
                select(WorkSourceSyncRun).where(
                    WorkSourceSyncRun.work_source_id == source.id
                )
            )
        ).scalars().all()
        duplicate = source.status == "invalidated"
        if not duplicate:
            source.status = "invalidated"
            source.name = ""
            source.root_path = ""
            source.include_patterns_json = []
            source.exclude_patterns_json = []
            source.checkpoint_json = {}
            source.source_key = f"invalidated:{source.id}:{source.source_key[:32]}"
            source.invalidated_at = _now()
            for run in runs:
                task = _RUN_TASKS.get(run.run_id)
                if task and not task.done():
                    task.cancel()
                if run.status in {"pending", "running"}:
                    run.status = "failed"
                    run.completed_at = _now()
                run.checkpoint_before_json = {}
                run.checkpoint_after_json = {}
                run.result_json = {}
                run.trace_json = {"invalidated": True}
                run.error = ""
        await db.commit()
        memory_source_id = memory_source.id if memory_source else None

    cascade = None
    if memory_source_id is not None:
        cascade = await invalidate_memory_source(
            source_id=memory_source_id,
            reason=clean_reason,
        )
    return {
        "work_source_id": int(work_source_id),
        "invalidated": True,
        "duplicate": duplicate,
        "memory_cascade": cascade,
    }


# =============================================
# 周期自动同步（"同步最新工作内容"闭环的最后一环）
# =============================================

_AUTO_SYNC_TASK: Optional[asyncio.Task] = None


async def _auto_sync_loop(interval_seconds: int) -> None:
    while True:
        await asyncio.sleep(interval_seconds)
        try:
            async with async_session() as db:
                sources = (
                    await db.execute(
                        select(WorkSource).where(WorkSource.status == "active")
                    )
                ).scalars().all()
            for source in sources:
                try:
                    # 周期同步沿用注册时的 data consent（用户注册工作源即授权其内容
                    # 周期性送往所选 coding agent；关闭自动同步只需 interval=0）
                    await start_work_source_sync(
                        work_source_id=source.id,
                        data_consent=True,
                        runtime_id=source.runtime_id,
                    )
                except Exception:
                    continue
        except asyncio.CancelledError:
            raise
        except Exception:
            pass


def start_work_source_auto_sync() -> None:
    """启动周期自动同步；settings.work_source_auto_sync_interval_seconds<=0 时关闭。"""
    global _AUTO_SYNC_TASK
    from app.config import get_settings

    interval = int(get_settings().work_source_auto_sync_interval_seconds or 0)
    if interval <= 0:
        return
    if _AUTO_SYNC_TASK is not None and not _AUTO_SYNC_TASK.done():
        return
    _AUTO_SYNC_TASK = asyncio.create_task(_auto_sync_loop(max(600, min(interval, 604_800))))


async def stop_work_source_auto_sync() -> None:
    global _AUTO_SYNC_TASK
    task = _AUTO_SYNC_TASK
    _AUTO_SYNC_TASK = None
    if task is None or task.done():
        return
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
