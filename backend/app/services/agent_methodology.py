"""Read-only loader for the checked-in OfferU Agent methodology packs."""

from __future__ import annotations

import hashlib
import re
from pathlib import Path
from typing import Any

import yaml

from app.runtime_paths import PACKAGE_BACKEND_DIR, packaged_resource_dir


_SOURCE_PACK_ROOT = Path(".agents/skills/offeru")
_BUNDLE_PACK_ROOT = Path("offeru-assets/skills/offeru")
_METHOD_PATHS = {
    "profile_onboarding": Path("skills/profile_onboarding/SKILL.md"),
    "tailor_resume": Path("skills/tailor_resume/SKILL.md"),
    "company_research": Path("skills/research/SKILL.md"),
    "role_intelligence": Path("skills/research/SKILL.md"),
}
METHOD_SKILL_IDS = frozenset(_METHOD_PATHS)
_METHOD_VERSION = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+")


def _asset_root() -> tuple[Path, Path]:
    packaged = packaged_resource_dir()
    if packaged is not None:
        return packaged / _BUNDLE_PACK_ROOT, _SOURCE_PACK_ROOT
    return PACKAGE_BACKEND_DIR.parent / _SOURCE_PACK_ROOT, _SOURCE_PACK_ROOT


def _result(
    *,
    status: str,
    skill_id: str,
    source_ref: str,
    text: str = "",
    version: str = "",
    digest: str = "",
    error_code: str = "",
) -> dict[str, Any]:
    return {
        "status": status,
        "skill_id": skill_id,
        "text": text,
        "source_ref": source_ref,
        "version": version,
        "sha256": digest,
        "error_code": error_code,
    }


def get_agent_methodology(skill_id: str) -> dict[str, Any]:
    """Return one trusted method asset by canonical Registry ID.

    The caller can freeze the returned text and provenance into its Run. This
    function never evaluates Markdown, accepts a caller path, or reads user
    memory, credentials, or writable runtime data.
    """

    if not isinstance(skill_id, str) or skill_id not in _METHOD_PATHS:
        raise ValueError("skill_id is not allowlisted for an OfferU method asset")

    relative_path = _METHOD_PATHS[skill_id]
    pack_root, source_root_ref = _asset_root()
    asset_path = pack_root / relative_path
    source_ref = (source_root_ref / relative_path).as_posix()
    try:
        resolved_root = pack_root.resolve()
        if asset_path.is_symlink() or not asset_path.resolve().is_relative_to(resolved_root):
            return _result(
                status="unavailable",
                skill_id=skill_id,
                source_ref=source_ref,
                error_code="methodology_asset_outside_pack",
            )
        payload = asset_path.read_bytes()
    except FileNotFoundError:
        return _result(
            status="missing",
            skill_id=skill_id,
            source_ref=source_ref,
            error_code="methodology_asset_missing",
        )
    except OSError:
        return _result(
            status="unavailable",
            skill_id=skill_id,
            source_ref=source_ref,
            error_code="methodology_asset_unreadable",
        )

    digest = hashlib.sha256(payload).hexdigest()
    try:
        content = payload.decode("utf-8")
    except UnicodeDecodeError:
        return _result(
            status="invalid",
            skill_id=skill_id,
            source_ref=source_ref,
            digest=digest,
            error_code="methodology_asset_not_utf8",
        )

    lines = content.splitlines()
    frontmatter_end = None
    if lines and lines[0] == "---":
        try:
            frontmatter_end = lines.index("---", 1)
        except ValueError:
            pass
    metadata = "\n".join(lines[1:frontmatter_end]) if frontmatter_end is not None else ""
    try:
        parsed = yaml.safe_load(metadata)
        version = parsed.get("method_version", "") if isinstance(parsed, dict) else ""
    except yaml.YAMLError:
        version = ""
    if not isinstance(version, str) or not _METHOD_VERSION.fullmatch(version):
        return _result(
            status="invalid",
            skill_id=skill_id,
            source_ref=source_ref,
            digest=digest,
            error_code="methodology_version_missing",
        )
    return _result(
        status="ready",
        skill_id=skill_id,
        source_ref=source_ref,
        text=content,
        version=version,
        digest=digest,
    )


def methodology_assets() -> dict[str, bytes]:
    """Exact owned assets installed next to either host's generated router."""
    assets: dict[str, bytes] = {}
    for skill_id, relative in _METHOD_PATHS.items():
        method = get_agent_methodology(skill_id)
        if method["status"] != "ready":
            raise ValueError(f"OfferU method asset is unavailable: {skill_id}")
        assets[relative.as_posix()] = method["text"].encode("utf-8")
    return assets


__all__ = ["get_agent_methodology", "methodology_assets", "METHOD_SKILL_IDS"]
