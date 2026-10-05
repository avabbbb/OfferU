from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from app.services import runtime_identity


def _build_metadata(**overrides: object) -> dict[str, object]:
    return {
        "schema_version": 1,
        "version": "0.4.0",
        "commit": "d" * 40,
        "build_timestamp": "2026-10-02T01:02:03.000Z",
        "dirty": False,
        "source_fingerprint": "sha256:" + "a" * 64,
        **overrides,
    }


def test_packaged_identity_uses_embedded_metadata_and_actual_data_root(
    monkeypatch, tmp_path: Path
) -> None:
    resource_dir = tmp_path / "bundle"
    metadata_path = resource_dir / "offeru-assets" / "offeru-build-identity.json"
    metadata_path.parent.mkdir(parents=True)
    metadata_path.write_text(json.dumps(_build_metadata()), encoding="utf-8")
    data_root = tmp_path / "OfferU-data"

    monkeypatch.setattr(runtime_identity, "packaged_resource_dir", lambda: resource_dir)
    monkeypatch.setattr(runtime_identity.sys, "frozen", True, raising=False)
    monkeypatch.setenv("OFFERU_DATA_DIR", str(data_root))
    monkeypatch.setenv("OFFERU_RUNTIME_MODE", "desktop-sidecar")
    monkeypatch.setenv("OFFERU_RUNTIME_INSTANCE_ID", "4cb704f3-df88-4fbf-9e8c-1a10ef96ea7d")
    monkeypatch.setenv("OFFERU_BUILD_COMMIT", "e" * 40)

    identity = runtime_identity.get_runtime_identity("0.4.0")

    assert identity == {
        "runtime_instance_id": "4cb704f3-df88-4fbf-9e8c-1a10ef96ea7d",
        "version": "0.4.0",
        "commit": "d" * 40,
        "build_timestamp": "2026-10-02T01:02:03.000Z",
        "dirty": False,
        "source_fingerprint": "sha256:" + "a" * 64,
        "data_root": str(data_root.resolve()),
        "runtime_type": "desktop-sidecar",
        "build_source": "package",
    }


def test_missing_packaged_metadata_stays_unknown_instead_of_reading_source_git(
    monkeypatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(runtime_identity, "packaged_resource_dir", lambda: tmp_path)
    monkeypatch.setattr(runtime_identity.sys, "frozen", True, raising=False)
    monkeypatch.setenv("OFFERU_RUNTIME_MODE", "desktop-sidecar")
    monkeypatch.setenv("OFFERU_BUILD_COMMIT", "f" * 40)
    monkeypatch.delenv("OFFERU_DATA_DIR", raising=False)

    identity = runtime_identity.get_runtime_identity("0.4.0")

    assert identity["build_source"] == "unknown"
    assert identity["version"] is None
    assert identity["commit"] is None
    assert identity["build_timestamp"] is None
    assert identity["dirty"] is None
    assert identity["source_fingerprint"] is None
    assert identity["data_root"] is None


def test_source_identity_is_explicitly_unbuilt_without_a_build_timestamp(
    monkeypatch,
) -> None:
    monkeypatch.setattr(runtime_identity, "packaged_resource_dir", lambda: None)
    monkeypatch.delattr(runtime_identity.sys, "frozen", raising=False)
    monkeypatch.setenv("OFFERU_RUNTIME_MODE", "local")
    monkeypatch.delenv("OFFERU_RUNTIME_INSTANCE_ID", raising=False)
    monkeypatch.delenv("OFFERU_BUILD_TIMESTAMP", raising=False)
    monkeypatch.delenv("OFFERU_BUILD_COMMIT", raising=False)
    monkeypatch.delenv("OFFERU_BUILD_DIRTY", raising=False)

    identity = runtime_identity.get_runtime_identity("0.4.0")

    assert identity["build_source"] == "source"
    assert identity["version"] == "0.4.0"
    assert identity["build_timestamp"] is None
    assert identity["runtime_type"] == "local"


def test_health_keeps_database_filename_redacted_and_adds_identity() -> None:
    from app.main import health_check

    health = asyncio.run(health_check())

    assert health["database_path_redacted"] is True
    assert Path(health["database_path"]).name == health["database_path"]
    assert "build_identity" in health
    assert "runtime_instance_id" in health


def test_diagnostics_identity_returns_actual_data_root_only_to_loopback(
    monkeypatch, tmp_path: Path
) -> None:
    from app.main import diagnostics_runtime_identity

    data_root = tmp_path / "actual-user-data"
    monkeypatch.setenv("OFFERU_DATA_DIR", str(data_root))
    monkeypatch.setenv("OFFERU_RUNTIME_MODE", "local")
    monkeypatch.setenv("OFFERU_RUNTIME_INSTANCE_ID", "4cb704f3-df88-4fbf-9e8c-1a10ef96ea7d")
    monkeypatch.setenv("OFFERU_APPROVAL_TOKEN", "never-return-this")

    def request_from(host: str) -> Request:
        return Request(
            {
                "type": "http",
                "http_version": "1.1",
                "method": "GET",
                "scheme": "http",
                "path": "/api/diagnostics/runtime-identity",
                "raw_path": b"/api/diagnostics/runtime-identity",
                "query_string": b"",
                "headers": [],
                "server": ("127.0.0.1", 8766),
                "client": (host, 50000),
            }
        )

    identity = asyncio.run(diagnostics_runtime_identity(request_from("127.0.0.1")))

    assert identity["data_root"] == str(data_root.resolve())
    assert identity["runtime_instance_id"] == "4cb704f3-df88-4fbf-9e8c-1a10ef96ea7d"
    assert identity["build_source"] == "source"
    assert "never-return-this" not in repr(identity)
    with pytest.raises(HTTPException) as error:
        asyncio.run(diagnostics_runtime_identity(request_from("203.0.113.5")))
    assert error.value.status_code == 403
