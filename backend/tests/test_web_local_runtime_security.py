from __future__ import annotations

from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
MAIN_SOURCE = (REPO_ROOT / "backend" / "app" / "main.py").read_text(encoding="utf-8")


def test_offer_web_origin_is_explicitly_allowlisted_for_loopback_runtime() -> None:
    assert '"https://avabbbb.github.io"' in MAIN_SOURCE
    assert "_TRUSTED_WEB_ORIGINS" in MAIN_SOURCE


def test_local_runtime_cors_does_not_use_wildcard_origins() -> None:
    assert 'allow_origins=["*"]' not in MAIN_SOURCE
    assert "allow_origins=cors_origins" in MAIN_SOURCE


def test_local_runtime_remains_loopback_bound() -> None:
    assert '"127.0.0.1"' in MAIN_SOURCE
    assert "_LOOPBACK_HOSTS" in MAIN_SOURCE
    assert "forbidden_host" in MAIN_SOURCE
