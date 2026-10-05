"""Safe build and running-instance identity for health and local diagnostics."""

from __future__ import annotations

import json
import os
from pathlib import Path
import re
import subprocess
import sys
from uuid import UUID
from typing import Any

from app.runtime_paths import PACKAGE_BACKEND_DIR, packaged_resource_dir, runtime_data_dir


_BUILD_FINGERPRINT = re.compile(r"^sha256:[0-9a-f]{64}$")
_BUILD_COMMIT = re.compile(r"^[0-9a-f]{40}$")
_RUNTIME_TYPES = {"local", "desktop-sidecar"}


def _packaged_metadata(app_version: str) -> dict[str, Any] | None:
    resource_dir = packaged_resource_dir()
    if resource_dir is None:
        return None
    metadata_path = resource_dir / "offeru-assets" / "offeru-build-identity.json"
    try:
        value = json.loads(metadata_path.read_text(encoding="utf-8"))
        timestamp = value.get("build_timestamp")
        if isinstance(timestamp, str):
            from datetime import datetime

            parsed = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
            valid_timestamp = parsed.tzinfo is not None and parsed.utcoffset().total_seconds() == 0
        else:
            valid_timestamp = False
        if not (
            isinstance(value, dict)
            and value.get("schema_version") == 1
            and value.get("version") == app_version
            and isinstance(value.get("version"), str)
            and isinstance(value.get("commit"), str)
            and _BUILD_COMMIT.fullmatch(value["commit"])
            and valid_timestamp
            and isinstance(value.get("dirty"), bool)
            and isinstance(value.get("source_fingerprint"), str)
            and _BUILD_FINGERPRINT.fullmatch(value["source_fingerprint"])
        ):
            return None
        return value
    except (OSError, ValueError, TypeError, AttributeError, OverflowError):
        return None


def _git_value(*args: str) -> str | None:
    """Inspect the checkout rooted at this source file, never the process cwd."""

    try:
        result = subprocess.run(
            ["git", "-C", str(PACKAGE_BACKEND_DIR.parent), *args],
            check=True,
            capture_output=True,
            text=True,
            timeout=1.5,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return result.stdout.strip()


def _source_commit() -> str | None:
    value = _git_value("rev-parse", "HEAD")
    return value.lower() if value and _BUILD_COMMIT.fullmatch(value.lower()) else None


def _source_dirty() -> bool | None:
    value = _git_value("status", "--porcelain", "--untracked-files=normal")
    return value != "" if value is not None else None


def _known_commit(value: str | None) -> str | None:
    normalized = value.strip().lower() if value else ""
    return normalized if _BUILD_COMMIT.fullmatch(normalized) else None


def _known_dirty(value: str | None) -> bool | None:
    if value is None:
        return None
    normalized = value.strip().lower()
    if normalized in {"true", "1"}:
        return True
    if normalized in {"false", "0"}:
        return False
    return None


def _runtime_instance_id() -> str | None:
    raw = str(os.getenv("OFFERU_RUNTIME_INSTANCE_ID") or "").strip()
    if not raw:
        return None
    try:
        return str(UUID(raw))
    except (ValueError, AttributeError):
        return None


def _runtime_type() -> str:
    value = str(
        os.getenv("OFFERU_RUNTIME_MODE")
        or os.getenv("OFFERU_INTERVIEW_RUNTIME")
        or "local"
    ).strip()
    return value if value in _RUNTIME_TYPES else "unknown"


def _actual_data_root() -> str | None:
    configured = str(os.getenv("OFFERU_DATA_DIR") or "").strip()
    if getattr(sys, "frozen", False) and not configured:
        # A frozen sidecar must never report its extraction/source directory as user data.
        return None
    try:
        return str((Path(configured).expanduser() if configured else runtime_data_dir()).resolve())
    except (OSError, RuntimeError, ValueError):
        return None


def get_runtime_identity(app_version: str) -> dict[str, Any]:
    """Return only nonsecret identity fields; source runs never invent a build time."""

    frozen = bool(getattr(sys, "frozen", False))
    instance_id = _runtime_instance_id()
    if frozen:
        metadata = _packaged_metadata(app_version)
        if metadata is None:
            version = commit = build_timestamp = source_fingerprint = None
            dirty = None
            build_source = "unknown"
        else:
            version = metadata["version"]
            commit = metadata["commit"]
            build_timestamp = metadata["build_timestamp"]
            dirty = metadata["dirty"]
            source_fingerprint = metadata["source_fingerprint"]
            build_source = "package"
    else:
        version = app_version
        # Tauri debug passes the revision captured by build.rs. A direct source run
        # reads the checkout from this module's fixed repository root instead.
        if instance_id and "OFFERU_BUILD_COMMIT" in os.environ:
            commit = _known_commit(os.getenv("OFFERU_BUILD_COMMIT"))
        else:
            commit = _source_commit()
        if instance_id and "OFFERU_BUILD_DIRTY" in os.environ:
            dirty = _known_dirty(os.getenv("OFFERU_BUILD_DIRTY"))
        else:
            dirty = _source_dirty()
        build_timestamp = None
        source_fingerprint = None
        build_source = "source"

    return {
        "runtime_instance_id": instance_id,
        "version": version,
        "commit": commit,
        "build_timestamp": build_timestamp,
        "dirty": dirty,
        "source_fingerprint": source_fingerprint,
        "data_root": _actual_data_root(),
        "runtime_type": _runtime_type(),
        "build_source": build_source,
    }


__all__ = ["get_runtime_identity"]
