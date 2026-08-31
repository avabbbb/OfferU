"""Small, dependency-free redaction boundary for logs and public errors."""

from __future__ import annotations

from collections.abc import Mapping
import re
from typing import Any


SENSITIVE_KEY = re.compile(
    r"(?:api[_-]?(?:key|token)|auth[_-]?token|access[_-]?token|refresh[_-]?token|client[_-]?secret|"
    r"password|secret|credential|cookie|authorization|token|share[_-]?token|"
    r"session[_-]?token)",
    re.IGNORECASE,
)
_BEARER = re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]+", re.IGNORECASE)
_URL_USERINFO = re.compile(r"(https?://)[^/@\s]+@", re.IGNORECASE)
_URL_SECRET = re.compile(
    r"([?&](?:api[_-]?(?:key|token)|auth[_-]?token|access[_-]?token|refresh[_-]?token|token|secret|"
    r"password|code|state)=)[^&#\s]+",
    re.IGNORECASE,
)
_KEY_VALUE_SECRET = re.compile(
    r"(\b(?:api[_-]?(?:key|token)|auth[_-]?token|access[_-]?token|refresh[_-]?token|client[_-]?secret|"
    r"password|secret|credential|cookie|authorization|token|share[_-]?token|"
    r"session[_-]?token)\b\s*[:=]\s*)"
    r"(\"[^\"]*\"|'[^']*'|[^\s,;}\]]+)",
    re.IGNORECASE,
)
_EMAIL = re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.IGNORECASE)
_PHONE = re.compile(r"(?<![\w])(?:\+?\d[\d\s().-]{7,}\d)(?![\w])")


def redact_sensitive_text(value: Any, *, max_length: int = 1000) -> str:
    """Return bounded text safe for logs, diagnostics and public errors."""

    text = redact_secret_text(value, max_length=max_length)
    text = _EMAIL.sub("[redacted email]", text)
    text = _PHONE.sub("[redacted phone]", text)
    return text[:max_length - 1] + "…" if len(text) > max_length else text


def redact_secret_text(value: Any, *, max_length: int = 1000) -> str:
    """Return bounded text with credential-like values removed, preserving PII."""

    text = "" if value is None else str(value)
    text = _BEARER.sub("Bearer [redacted]", text)
    text = _URL_USERINFO.sub(r"\1[redacted]@", text)
    text = _URL_SECRET.sub(r"\1[redacted]", text)
    text = _KEY_VALUE_SECRET.sub(r"\1[redacted]", text)
    if len(text) > max_length:
        return text[: max(0, max_length - 1)] + "…"
    return text


def redact_sensitive_value(value: Any, *, key: str = "", max_length: int = 1000) -> Any:
    """Recursively redact secret-like fields and sensitive scalar values."""

    if key and SENSITIVE_KEY.search(key):
        return "[redacted]"
    if isinstance(value, Mapping):
        return {
            str(item_key): redact_sensitive_value(
                item_value,
                key=str(item_key),
                max_length=max_length,
            )
            for item_key, item_value in value.items()
        }
    if isinstance(value, (list, tuple, set)):
        return [redact_sensitive_value(item, max_length=max_length) for item in value]
    if isinstance(value, str):
        return redact_sensitive_text(value, max_length=max_length)
    return value


def redact_secret_value(value: Any, *, key: str = "", max_length: int = 1000) -> Any:
    """Recursively redact credentials while preserving ordinary user content."""

    if key and SENSITIVE_KEY.search(key):
        return "[redacted]"
    if isinstance(value, Mapping):
        return {
            str(item_key): redact_secret_value(
                item_value,
                key=str(item_key),
                max_length=max_length,
            )
            for item_key, item_value in value.items()
        }
    if isinstance(value, (list, tuple, set)):
        return [redact_secret_value(item, max_length=max_length) for item in value]
    if isinstance(value, str):
        return redact_secret_text(value, max_length=max_length)
    return value


def safe_error_message(exc: BaseException, *, fallback: str = "操作失败", max_length: int = 500) -> str:
    """Expose a bounded, redacted exception message without a traceback."""

    message = redact_sensitive_text(exc, max_length=max_length).strip()
    return message or fallback


__all__ = [
    "SENSITIVE_KEY",
    "redact_secret_text",
    "redact_secret_value",
    "redact_sensitive_text",
    "redact_sensitive_value",
    "safe_error_message",
]
