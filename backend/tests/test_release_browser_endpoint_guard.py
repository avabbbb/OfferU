from __future__ import annotations

from pathlib import Path

import pytest

from scripts.e2e.release_endpoints import (
    assert_release_backend_ready,
    assert_release_frontend_ready,
    is_offeru_health_payload,
    open_release_url,
    release_api_url,
    release_frontend_url,
    release_version,
)


ROOT = Path(__file__).resolve().parents[2]


def test_release_endpoints_default_to_fixed_loopback_ports(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("OFFERU_E2E_BASE_URL", raising=False)
    monkeypatch.delenv("OFFERU_E2E_API_URL", raising=False)

    assert release_frontend_url() == "http://127.0.0.1:7410"
    assert release_api_url() == "http://127.0.0.1:8765"


def test_health_identity_accepts_offeru_python() -> None:
    assert is_offeru_health_payload(
        {
            "status": "ok",
            "service": "OfferU",
            "runtime": "python",
            "version": "0.4.0",
            "build_mode": "local-development",
        }
    )


def test_health_identity_can_require_current_release_identity() -> None:
    expected_version = release_version()
    assert is_offeru_health_payload(
        {
            "status": "ok",
            "service": "OfferU",
            "runtime": "python",
            "version": expected_version,
            "build_mode": "local-development",
        },
        expected_version=expected_version,
        expected_build_mode="local-development",
    )
    assert not is_offeru_health_payload(
        {
            "status": "ok",
            "service": "OfferU",
            "runtime": "python",
            "version": "0.0.0",
            "build_mode": "local-development",
        },
        expected_version=expected_version,
        expected_build_mode="local-development",
    )


@pytest.mark.parametrize(
    "payload",
    [
        {"status": "ok", "service": "Other", "runtime": "python"},
        {"status": "ok", "service": "OfferU", "runtime": "node"},
        {"status": "error", "service": "OfferU", "runtime": "python"},
        None,
    ],
)
def test_health_identity_rejects_wrong_service_runtime_or_status(payload: object) -> None:
    assert not is_offeru_health_payload(payload)


@pytest.mark.parametrize(
    ("env_name", "value"),
    [
        ("OFFERU_E2E_BASE_URL", "http://127.0.0.1:8080"),
        ("OFFERU_E2E_API_URL", "http://127.0.0.1:8080"),
        ("OFFERU_E2E_BASE_URL", "http://localhost:7410"),
        ("OFFERU_E2E_API_URL", "https://127.0.0.1:8765"),
        ("OFFERU_E2E_BASE_URL", "http://127.0.0.1:7410/jobs"),
        ("OFFERU_E2E_API_URL", "http://127.0.0.1:8765?debug=1"),
        ("OFFERU_E2E_BASE_URL", "http://user:password@127.0.0.1:7410"),
        ("OFFERU_E2E_API_URL", "http://192.0.2.10:8765"),
    ],
)
def test_release_endpoint_override_fails_closed(
    monkeypatch: pytest.MonkeyPatch,
    env_name: str,
    value: str,
) -> None:
    monkeypatch.setenv(env_name, value)

    resolver = release_frontend_url if env_name == "OFFERU_E2E_BASE_URL" else release_api_url

    with pytest.raises(RuntimeError, match="only accepts http://127.0.0.1:") as error:
        resolver()
    message = str(error.value)
    assert "password" not in message
    assert "192.0.2.10" not in message


def test_release_http_opener_rejects_non_release_url_before_network() -> None:
    with pytest.raises(RuntimeError, match="release smoke URL is not allowed") as error:
        open_release_url("http://127.0.0.1:8080")
    assert "8080" not in str(error.value)

    with pytest.raises(RuntimeError, match="release smoke URL is not allowed") as error:
        open_release_url("http://127.0.0.1:7410/private")
    assert "/private" not in str(error.value)


def test_release_http_opener_has_a_no_redirect_handler() -> None:
    source = (ROOT / "backend/scripts/e2e/release_endpoints.py").read_text(encoding="utf-8")
    assert "HTTPRedirectHandler" in source
    assert "return None" in source


def test_browser_smoke_readiness_helpers_are_pre_browser_and_fixed() -> None:
    source = (ROOT / "backend/scripts/e2e/release_endpoints.py").read_text(encoding="utf-8")
    assert "def assert_release_frontend_ready" in source
    assert "def assert_release_backend_ready" in source
    assert "OfferU frontend is not ready at 127.0.0.1:7410" in source
    assert "OfferU backend health could not be read at 127.0.0.1:8765" in source
    assert "expected_version=release_version()" in source
    assert "expected_build_mode=expected_build_mode" in source
    assert "received {value!r}" not in source
    assert "not allowed: {normalized!r}" not in source
    assert "headless" not in source

    # Keep these imported in this contract module so a future refactor cannot
    # remove the public pre-browser guards while retaining only source markers.
    assert callable(assert_release_frontend_ready)
    assert callable(assert_release_backend_ready)


@pytest.mark.parametrize(
    ("relative_path", "required_text"),
    [
        ("backend/scripts/e2e/test_public_release_smoke.py", "BASE_URL = release_frontend_url()"),
        ("backend/scripts/e2e/test_public_release_empty_states.py", "BASE_URL = release_frontend_url()"),
        ("backend/scripts/e2e/test_public_release_interview.py", "API_URL = release_api_url()"),
        ("backend/scripts/e2e/test_public_release_worker_soak.py", "API_URL = release_api_url()"),
        ("backend/scripts/e2e/test_public_release_migration.py", "BASE_URL = release_frontend_url()"),
    ],
)
def test_public_release_e2e_scripts_use_the_shared_endpoint_guard(
    relative_path: str,
    required_text: str,
) -> None:
    source = (ROOT / relative_path).read_text(encoding="utf-8")

    assert "from release_endpoints import" in source
    assert required_text in source
    assert "os.getenv(\"OFFERU_E2E_BASE_URL\"" not in source
    assert "os.getenv(\"OFFERU_E2E_API_URL\"" not in source


@pytest.mark.parametrize(
    ("relative_path", "required_guard"),
    [
        ("backend/scripts/e2e/test_public_release_smoke.py", "assert_release_backend_ready()"),
        ("backend/scripts/e2e/test_public_release_interview.py", "assert_release_backend_ready()"),
        ("backend/scripts/e2e/test_public_release_empty_states.py", "assert_release_frontend_ready()"),
    ],
)
def test_browser_scenarios_check_identity_before_creating_browser(
    relative_path: str,
    required_guard: str,
) -> None:
    source = (ROOT / relative_path).read_text(encoding="utf-8")

    assert required_guard in source
    assert "with sync_playwright()" in source
    assert source.index(required_guard) < source.index("with sync_playwright()")
