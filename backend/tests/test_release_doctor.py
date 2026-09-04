from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from urllib.error import URLError
from unittest.mock import MagicMock, patch

from app.cli import _doctor_backend_health, _doctor_frontend_health, _doctor_release_readiness


def _data_safety() -> dict:
    return {
        "status": "ready",
        "schema_migration": {"status": "ready"},
        "integrity_check": "ok",
        "foreign_key_violations": 0,
    }


def _providers() -> list[dict]:
    return [
        {
            "provider_id": "replay",
            "available": True,
            "authenticated": True,
        }
    ]


def test_local_doctor_reports_core_ready(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.delenv("OFFERU_BUILD_MODE", raising=False)
    monkeypatch.delenv("OFFERU_RUNTIME_MODE", raising=False)
    monkeypatch.delenv("OFFERU_VERSION", raising=False)
    monkeypatch.delenv("OFFERU_AGENT_RUNTIME_DIR", raising=False)
    monkeypatch.delenv("OFFERU_NODE_PATH", raising=False)
    monkeypatch.setenv("OFFERU_DATA_DIR", str(tmp_path))
    (tmp_path / "uploads").mkdir()

    result = _doctor_release_readiness(
        settings=SimpleNamespace(),
        provider_health=_providers(),
        data_safety=_data_safety(),
    )

    assert result["status"] == "CORE_READY"
    assert result["release_mode"] is False
    assert result["live_provider_gate"] == "not_verified"


def test_release_doctor_requires_packaged_contract(monkeypatch, tmp_path: Path) -> None:
    data_dir = tmp_path / "OfferU"
    (data_dir / "uploads").mkdir(parents=True)
    agent_dir = tmp_path / "agent-runtime"
    agent_dir.mkdir()
    node_path = tmp_path / "node.exe"
    node_path.write_bytes(b"fixture")
    monkeypatch.setenv("OFFERU_DATA_DIR", str(data_dir))
    monkeypatch.setenv("OFFERU_AGENT_RUNTIME_DIR", str(agent_dir))
    monkeypatch.setenv("OFFERU_NODE_PATH", str(node_path))
    monkeypatch.setenv("OFFERU_BUILD_MODE", "release")
    monkeypatch.setenv("OFFERU_RUNTIME_MODE", "desktop-sidecar")
    monkeypatch.setenv("OFFERU_VERSION", "0.4.0")

    result = _doctor_release_readiness(
        settings=SimpleNamespace(),
        provider_health=_providers(),
        data_safety=_data_safety(),
    )

    assert result["status"] == "CORE_READY"
    assert result["checks"]["desktop_bridge"]["status"] == "ready"
    assert result["checks"]["version_consistency"]["status"] == "ready"


def test_release_doctor_fails_on_version_or_storage_drift(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("OFFERU_DATA_DIR", str(tmp_path / "missing"))
    monkeypatch.setenv("OFFERU_BUILD_MODE", "release")
    monkeypatch.setenv("OFFERU_RUNTIME_MODE", "desktop-sidecar")
    monkeypatch.setenv("OFFERU_VERSION", "0.3.0")
    monkeypatch.setenv("OFFERU_AGENT_RUNTIME_DIR", str(tmp_path / "missing-agent"))
    monkeypatch.setenv("OFFERU_NODE_PATH", str(tmp_path / "missing-node.exe"))

    result = _doctor_release_readiness(
        settings=SimpleNamespace(),
        provider_health=_providers(),
        data_safety=_data_safety(),
    )

    assert result["status"] == "CORE_NOT_READY"
    assert set(result["blockers"]) == {
        "storage",
        "desktop_bridge",
        "version_consistency",
    }


def test_doctor_probes_backend_health_without_exposing_response_body() -> None:
    response = MagicMock(status=200)
    response.read.return_value = b'{"status":"ok","service":"OfferU","runtime":"python","version":"0.4.0","build_mode":"local-development"}'
    with patch("app.cli._open_local_url") as opener:
        opener.return_value.__enter__.return_value = response

        result = _doctor_backend_health()

    assert result == {
        "status": "ready",
        "url": "http://127.0.0.1:8765/api/health",
        "http_status": 200,
    }
    opener.assert_called_once()
    assert opener.call_args.kwargs["timeout"] == 2.0


def test_doctor_loopback_opener_disables_redirects() -> None:
    source = (Path(__file__).resolve().parents[1] / "app" / "cli.py").read_text(
        encoding="utf-8"
    )
    assert "HTTPRedirectHandler" in source
    assert "_NoRedirectHandler" in source


def test_doctor_rejects_wrong_backend_health_payload_without_echoing_body() -> None:
    response = MagicMock(status=200)
    response.read.return_value = b'{"status":"ok","service":"other","token":"secret"}'
    with patch("app.cli._open_local_url") as opener:
        opener.return_value.__enter__.return_value = response

        result = _doctor_backend_health()

    assert result == {
        "status": "failed",
        "url": "http://127.0.0.1:8765/api/health",
        "http_status": 200,
        "error_kind": "backend_health_payload_invalid",
    }
    assert "secret" not in str(result)


def test_doctor_rejects_non_python_backend_runtime_without_network_retry() -> None:
    response = MagicMock(status=200)
    response.read.return_value = b'{"status":"ok","service":"OfferU","runtime":"node"}'
    with patch("app.cli._open_local_url") as opener:
        opener.return_value.__enter__.return_value = response

        result = _doctor_backend_health()

    assert result == {
        "status": "failed",
        "url": "http://127.0.0.1:8765/api/health",
        "http_status": 200,
        "error_kind": "backend_health_payload_invalid",
    }


def test_doctor_rejects_backend_version_or_build_mode_drift() -> None:
    response = MagicMock(status=200)
    response.read.return_value = b'{"status":"ok","service":"OfferU","runtime":"python","version":"0.3.0","build_mode":"release"}'
    with patch("app.cli._open_local_url") as opener:
        opener.return_value.__enter__.return_value = response

        result = _doctor_backend_health()

    assert result == {
        "status": "failed",
        "url": "http://127.0.0.1:8765/api/health",
        "http_status": 200,
        "error_kind": "backend_health_payload_invalid",
    }


def test_release_doctor_blocks_when_backend_is_not_ready() -> None:
    result = _doctor_release_readiness(
        settings=SimpleNamespace(),
        backend_health={
            "status": "unavailable",
            "url": "http://127.0.0.1:8765/api/health",
            "error_kind": "backend_not_reachable",
        },
        provider_health=_providers(),
        data_safety=_data_safety(),
    )

    assert result["status"] == "CORE_NOT_READY"
    assert "backend" in result["blockers"]


def test_doctor_probes_frontend_without_exposing_response_body(monkeypatch) -> None:
    monkeypatch.setenv("OFFERU_FRONTEND_HEALTH_URL", "http://127.0.0.1:7410/")
    response = MagicMock(status=200)
    response.read.return_value = b"<!doctype html><title>OfferU</title>"
    with patch("app.cli._open_local_url") as opener:
        opener.return_value.__enter__.return_value = response

        result = _doctor_frontend_health()

    assert result == {
        "status": "ready",
        "url": "http://127.0.0.1:7410",
        "http_status": 200,
    }
    opener.assert_called_once()
    assert opener.call_args.kwargs["timeout"] == 2.0


def test_doctor_rejects_wrong_frontend_page_without_exposing_response_body(monkeypatch) -> None:
    monkeypatch.setenv("OFFERU_FRONTEND_HEALTH_URL", "http://127.0.0.1:7410/")
    response = MagicMock(status=200)
    response.read.return_value = b"<!doctype html><title>Other service</title>"
    with patch("app.cli._open_local_url") as opener:
        opener.return_value.__enter__.return_value = response

        result = _doctor_frontend_health()

    assert result == {
        "status": "failed",
        "url": "http://127.0.0.1:7410",
        "http_status": 200,
        "error_kind": "frontend_payload_invalid",
    }
    assert "Other service" not in str(result)


def test_doctor_marks_frontend_unavailable_without_raw_network_error(monkeypatch) -> None:
    monkeypatch.setenv("OFFERU_FRONTEND_HEALTH_URL", "http://127.0.0.1:7410/")
    with patch("app.cli._open_local_url", side_effect=URLError("secret endpoint details")):
        result = _doctor_frontend_health()

    assert result == {
        "status": "unavailable",
        "url": "http://127.0.0.1:7410",
        "error_kind": "frontend_not_reachable",
    }
    assert "secret" not in str(result)


def test_doctor_rejects_8080_as_frontend_without_network_probe(monkeypatch) -> None:
    monkeypatch.setenv("OFFERU_FRONTEND_HEALTH_URL", "http://127.0.0.1:8080/")
    with patch("app.cli._open_local_url") as opener:
        result = _doctor_frontend_health()

    assert result == {
        "status": "failed",
        "url": "http://127.0.0.1:8080",
        "expected_url": "http://127.0.0.1:7410",
        "error_kind": "frontend_port_8080_forbidden",
    }
    opener.assert_not_called()


def test_doctor_rejects_nonlocal_frontend_without_network_probe(monkeypatch) -> None:
    monkeypatch.setenv("OFFERU_FRONTEND_HEALTH_URL", "https://example.com:7410/")
    with patch("app.cli._open_local_url") as opener:
        result = _doctor_frontend_health()

    assert result == {
        "status": "failed",
        "url": "https://example.com:7410",
        "expected_url": "http://127.0.0.1:7410",
        "error_kind": "frontend_url_not_allowed",
    }
    opener.assert_not_called()


def test_doctor_rejects_frontend_credentials_and_path_without_network_probe(monkeypatch) -> None:
    monkeypatch.setenv("OFFERU_FRONTEND_HEALTH_URL", "http://user:secret@127.0.0.1:7410/private?token=1")
    with patch("app.cli._open_local_url") as opener:
        result = _doctor_frontend_health()

    assert result == {
        "status": "failed",
        "url": "http://127.0.0.1:7410",
        "expected_url": "http://127.0.0.1:7410",
        "error_kind": "frontend_url_not_allowed",
    }
    assert "secret" not in str(result)
    opener.assert_not_called()


def test_release_doctor_blocks_when_frontend_is_not_ready() -> None:
    result = _doctor_release_readiness(
        settings=SimpleNamespace(),
        provider_health=_providers(),
        data_safety=_data_safety(),
        frontend_health={
            "status": "failed",
            "url": "http://127.0.0.1:8080",
            "error_kind": "frontend_port_8080_forbidden",
        },
    )

    assert result["status"] == "CORE_NOT_READY"
    assert "frontend" in result["blockers"]


def test_packaged_doctor_reports_embedded_frontend(monkeypatch) -> None:
    monkeypatch.setenv("OFFERU_RUNTIME_MODE", "desktop-sidecar")

    assert _doctor_frontend_health() == {
        "status": "embedded",
        "url": "tauri://localhost",
    }
