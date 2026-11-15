"""Loopback pairing token for the static showcase bridge.

The token is a local secret, not an account credential. It stops an arbitrary
web page from reading or writing the loopback API through the browser's CORS
allowlist. It lives next to the local database and is never sent anywhere
except the paired tab.
"""

from __future__ import annotations

import secrets
import threading
from pathlib import Path

from app.core import store

_TOKEN_FILE = "bridge_token"
_lock = threading.Lock()
_cached: str | None = None


def token_path() -> Path:
    return store.data_dir() / _TOKEN_FILE


def pairing_token() -> str:
    global _cached
    with _lock:
        if _cached:
            return _cached
        path = token_path()
        try:
            existing = path.read_text(encoding="utf-8").strip()
        except OSError:
            existing = ""
        if len(existing) >= 24:
            _cached = existing
            return existing
        token = secrets.token_urlsafe(32)
        path.write_text(token, encoding="utf-8")
        try:
            path.chmod(0o600)
        except OSError:
            pass
        _cached = token
        return token
