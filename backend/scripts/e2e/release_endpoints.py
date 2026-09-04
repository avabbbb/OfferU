"""Fixed loopback endpoints for public-release acceptance scripts."""

from __future__ import annotations

import json
import os
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, build_opener


_REPO_ROOT = Path(__file__).resolve().parents[3]


class _NoRedirectHandler(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_LOCAL_LOOPBACK_OPENER = build_opener(ProxyHandler({}), _NoRedirectHandler())
_ALLOWED_RELEASE_URLS = frozenset(
    {
        "http://127.0.0.1:7410",
        "http://127.0.0.1:8765/api/health",
    }
)


def release_version() -> str:
    """Read the version shipped by the current checkout, not a running service."""

    manifest_path = _REPO_ROOT / "frontend" / "package.json"
    try:
        payload = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError) as exc:
        raise RuntimeError(f"cannot read current OfferU release version: {manifest_path}") from exc
    version = payload.get("version") if isinstance(payload, dict) else None
    if not isinstance(version, str) or not version.strip():
        raise RuntimeError(f"current OfferU release version is missing: {manifest_path}")
    return version.strip()


def is_offeru_health_payload(
    payload: object,
    *,
    expected_version: str | None = None,
    expected_build_mode: str | None = None,
) -> bool:
    valid = (
        isinstance(payload, dict)
        and payload.get("status") == "ok"
        and payload.get("service") == "OfferU"
        and payload.get("runtime") == "python"
        and isinstance(payload.get("version"), str)
        and bool(payload.get("version", "").strip())
        and isinstance(payload.get("build_mode"), str)
        and bool(payload.get("build_mode", "").strip())
    )
    if not valid:
        return False
    if expected_version is not None and payload.get("version") != expected_version:
        return False
    if expected_build_mode is not None and payload.get("build_mode") != expected_build_mode:
        return False
    return True


def _fixed_local_url(env_name: str, default: str, *, port: int, label: str) -> str:
    value = (os.getenv(env_name) or default).strip().rstrip("/")
    try:
        parsed = urlsplit(value)
        configured_port = parsed.port
    except ValueError as exc:
        raise RuntimeError(
            f"{label} only accepts http://127.0.0.1:{port}; configured value was rejected"
        ) from exc

    if (
        parsed.scheme != "http"
        or parsed.hostname != "127.0.0.1"
        or configured_port != port
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
    ):
        raise RuntimeError(
            f"{label} only accepts http://127.0.0.1:{port}; configured value was rejected"
        )
    return f"http://127.0.0.1:{port}"


def release_frontend_url() -> str:
    return _fixed_local_url(
        "OFFERU_E2E_BASE_URL",
        "http://127.0.0.1:7410",
        port=7410,
        label="release web URL",
    )


def release_api_url() -> str:
    return _fixed_local_url(
        "OFFERU_E2E_API_URL",
        "http://127.0.0.1:8765",
        port=8765,
        label="release API URL",
    )


def open_release_url(url: str, *, timeout: float = 2.0):
    """Open a release smoke URL directly, without inheriting system proxies."""

    candidate = str(url).strip()
    normalized = candidate.rstrip("/")
    if normalized not in _ALLOWED_RELEASE_URLS:
        raise RuntimeError("release smoke URL is not allowed")
    return _LOCAL_LOOPBACK_OPENER.open(normalized, timeout=timeout)


def assert_release_frontend_ready(*, timeout: float = 2.0) -> None:
    """Reject an unreachable or unrelated page before any browser is created."""

    try:
        with open_release_url(release_frontend_url(), timeout=timeout) as response:
            if not 200 <= response.status < 300:
                raise RuntimeError(f"frontend returned HTTP {response.status}")
            if b"OfferU" not in response.read(8192):
                raise RuntimeError("frontend did not return the OfferU page identity")
    except (HTTPError, OSError, URLError) as exc:
        raise RuntimeError("OfferU frontend is not ready at 127.0.0.1:7410") from exc


def assert_release_backend_ready(
    *,
    expected_build_mode: str = "local-development",
    timeout: float = 2.0,
) -> None:
    """Reject a stale/wrong service before an API E2E mutates its workspace."""

    try:
        with open_release_url(
            f"{release_api_url()}/api/health",
            timeout=timeout,
        ) as response:
            if not 200 <= response.status < 300:
                raise RuntimeError(f"backend returned HTTP {response.status}")
            payload = json.loads(response.read(8192))
    except (HTTPError, OSError, URLError, ValueError, json.JSONDecodeError) as exc:
        raise RuntimeError("OfferU backend health could not be read at 127.0.0.1:8765") from exc

    if not is_offeru_health_payload(
        payload,
        expected_version=release_version(),
        expected_build_mode=expected_build_mode,
    ):
        raise RuntimeError("OfferU backend returned the wrong release identity")
