from __future__ import annotations

from app.main import _TRUSTED_WEB_ORIGINS, _is_allowed_cors_origin


def test_github_pages_is_the_only_trusted_public_loopback_client() -> None:
    assert _TRUSTED_WEB_ORIGINS == {"https://avabbbb.github.io"}
    assert _is_allowed_cors_origin("https://avabbbb.github.io") is True
    assert _is_allowed_cors_origin("https://evil.example") is False
    assert _is_allowed_cors_origin("https://avabbbb.github.io.evil.example") is False


def test_existing_local_origins_remain_allowed() -> None:
    assert _is_allowed_cors_origin("http://127.0.0.1:7410") is True
    assert _is_allowed_cors_origin("http://localhost:7410") is True
    assert _is_allowed_cors_origin("tauri://localhost") is True
