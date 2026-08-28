"""Run artifact workspace manager (Slice 4).

Owns the exclusive on-disk workspace for one external-Harness Run: creates
the directory with an audit manifest, verifies it on resume, and enforces
path confinement so a Run's native tools can never reach outside the
workspace root (no symlink/junction escape, no DB/.env/source access).

Layout:
    backend/data/run_workspaces/<run_id>/
        manifest.json     {schema, runId, createdAt, updatedAt, jobIds, owner}
        workspace/        the Run's writable artifact area (executor cwd)
        context.json      ContextProjector output (read-only for the model)
        candidates/       executor-produced research candidates (declared)
"""

from __future__ import annotations

import json
import os
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

_RUN_ID = re.compile(r"^[A-Za-z0-9_-]{1,120}$")
WORKSPACE_SCHEMA = "offeru.run_workspace.v1"
_RUNS_ROOT = Path(__file__).resolve().parents[2] / "data" / "run_workspaces"


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class WorkspaceError(Exception):
    """Raised when a Run workspace is missing, foreign, or escaped."""


def _manifest_path(run_id: str) -> Path:
    return _RUNS_ROOT / run_id / "manifest.json"


def _workspace_dir(run_id: str) -> Path:
    return _RUNS_ROOT / run_id / "workspace"


def _candidates_dir(run_id: str) -> Path:
    return _RUNS_ROOT / run_id / "candidates"


def _validate_run_id(run_id: str) -> str:
    clean = str(run_id or "").strip()
    if not _RUN_ID.fullmatch(clean):
        raise WorkspaceError(f"invalid run id: {run_id!r}")
    return clean


class ArtifactWorkspaceManager:
    """Create, verify, and confine one Run's artifact workspace."""

    def __init__(self, run_id: str, root: Path | None = None):
        self.run_id = _validate_run_id(run_id)
        self.root = (root or _RUNS_ROOT).resolve()
        self.manifest_path = self.root / self.run_id / "manifest.json"
        self.workspace_dir = self.root / self.run_id / "workspace"
        self.candidates_dir = self.root / self.run_id / "candidates"
        self.context_path = self.root / self.run_id / "context.json"

    # ---- lifecycle ----

    def create(self, *, owner: str, job_ids: list[int] | None = None) -> dict[str, Any]:
        """Create the workspace directory tree and write the manifest."""
        self._ensure_root()
        if self.manifest_path.exists():
            # Re-create on explicit request is not allowed; verify instead.
            return self.verify()
        (self.workspace_dir / "inbox").mkdir(parents=True, exist_ok=True)
        (self.workspace_dir / "notes").mkdir(parents=True, exist_ok=True)
        self.candidates_dir.mkdir(parents=True, exist_ok=True)
        manifest = {
            "schema": WORKSPACE_SCHEMA,
            "runId": self.run_id,
            "owner": str(owner or "harness"),
            "jobIds": [int(j) for j in (job_ids or [])],
            "createdAt": _utc_now(),
            "updatedAt": _utc_now(),
        }
        self._write_json(self.manifest_path, manifest)
        return manifest

    def verify(self) -> dict[str, Any]:
        """Verify an existing workspace; raise on missing/foreign layout."""
        if not self.manifest_path.is_file():
            raise WorkspaceError(f"Run {self.run_id} has no workspace manifest")
        manifest = self._read_json(self.manifest_path)
        if manifest.get("schema") != WORKSPACE_SCHEMA:
            raise WorkspaceError(f"Run {self.run_id} manifest schema mismatch")
        if manifest.get("runId") != self.run_id:
            raise WorkspaceError(f"Run {self.run_id} manifest run id mismatch")
        if not self.workspace_dir.is_dir():
            raise WorkspaceError(f"Run {self.run_id} workspace directory missing")
        if not self.candidates_dir.is_dir():
            raise WorkspaceError(f"Run {self.run_id} candidates directory missing")
        return manifest

    # ---- confinement ----

    def resolve_inside(self, relative: str | os.PathLike[str]) -> Path:
        """Resolve a caller-supplied relative path inside the workspace.

        Rejects absolute paths, parent traversal, symlink/junction escapes,
        and any path whose real location leaves the workspace root. This is
        the single choke point for every file tool the Run's native tools see.
        """
        self.verify()
        raw = str(relative)
        candidate = (self.workspace_dir / raw).resolve()
        try:
            candidate.relative_to(self.root / self.run_id)
        except ValueError as exc:
            raise WorkspaceError(
                f"path escape blocked: {raw!r} resolves outside run {self.run_id}"
            ) from exc
        if candidate.is_symlink():
            real = candidate.resolve(strict=False)
            try:
                real.relative_to(self.root / self.run_id)
            except ValueError as exc:
                raise WorkspaceError(f"symlink escape blocked: {raw!r}") from exc
        return candidate

    def write_artifact(self, relative: str, payload: dict[str, Any]) -> Path:
        """Write one JSON artifact inside the workspace (atomic)."""
        path = self.resolve_inside(relative)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f".{path.name}.{os.urandom(4).hex()}.tmp")
        tmp.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        os.replace(tmp, path)
        manifest = self._read_json(self.manifest_path)
        manifest["updatedAt"] = _utc_now()
        self._write_json(self.manifest_path, manifest)
        return path

    def declare_candidate(self, name: str, payload: dict[str, Any]) -> Path:
        """Declare one executor-produced research candidate (pre-acceptance)."""
        safe_name = re.sub(r"[^A-Za-z0-9_.-]", "_", str(name or "candidate"))[:80]
        return self.write_artifact(f"../candidates/{safe_name}.json", payload)

    def list_candidates(self) -> list[dict[str, Any]]:
        """Read declared candidates (never touching the workspace itself)."""
        items = []
        for path in sorted(self.candidates_dir.glob("*.json")):
            try:
                items.append(json.loads(path.read_text(encoding="utf-8")))
            except json.JSONDecodeError:
                continue
        return items

    def destroy(self) -> None:
        """Remove the whole Run workspace (explicit teardown only)."""
        target = (self.root / self.run_id).resolve()
        try:
            target.relative_to(self.root)
        except ValueError as exc:
            raise WorkspaceError(f"refusing to destroy outside root: {target}") from exc
        if target.exists():
            shutil.rmtree(target)

    # ---- helpers ----

    def _ensure_root(self) -> None:
        self.root.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def _read_json(path: Path) -> dict[str, Any]:
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise WorkspaceError(f"cannot read workspace manifest {path}") from exc

    @staticmethod
    def _write_json(path: Path, payload: dict[str, Any]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f".{path.name}.{os.urandom(4).hex()}.tmp")
        tmp.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        os.replace(tmp, path)


__all__ = [
    "ArtifactWorkspaceManager",
    "WorkspaceError",
]
