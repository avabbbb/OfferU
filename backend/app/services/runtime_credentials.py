"""Read-only access to locally persisted scraper credentials.

The settings route owns configuration writes.  Runtime adapters read the
persisted value through this small service instead of importing a FastAPI
module, which keeps web state out of the domain/provider dependency graph.
"""

from __future__ import annotations

import json

from app.runtime_paths import runtime_config_file


_COOKIE_KEYS = frozenset({"boss_cookie", "zhilian_cookie"})


def load_scraper_cookie(key: str) -> str:
    """Return one allow-listed scraper cookie without exposing other config."""

    clean_key = str(key or "").strip()
    if clean_key not in _COOKIE_KEYS:
        raise ValueError(f"不支持的 scraper credential: {clean_key}")
    try:
        path = runtime_config_file()
        if not path.is_file():
            return ""
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return ""
    value = payload.get(clean_key) if isinstance(payload, dict) else ""
    return value.strip() if isinstance(value, str) else ""


__all__ = ["load_scraper_cookie"]
