"""One-process capability used only by the OfferU approval UI."""

from __future__ import annotations

import hmac
import os
import secrets
import time


# The launcher (Tauri shell or `offeru start`) passes this random value to the
# backend at launch. Consume it immediately so Agent/provider subprocesses
# cannot inherit the capability.
_APPROVAL_TOKEN = os.environ.pop("OFFERU_APPROVAL_TOKEN", "")

# `offeru start` opens the browser with a one-time pairing code instead of the
# token itself; the page trades it for the token once.
_PAIRING_TTL_SECONDS = 300
_pairing: dict[str, float] = {}


def accepts_authorization(header: str | None) -> bool:
    if not _APPROVAL_TOKEN or not header:
        return False
    scheme, separator, token = header.partition(" ")
    return bool(
        separator
        and scheme.casefold() == "bearer"
        and token
        and hmac.compare_digest(token, _APPROVAL_TOKEN)
    )


def issue_pairing_code() -> str:
    code = secrets.token_urlsafe(24)
    _pairing[code] = time.monotonic() + _PAIRING_TTL_SECONDS
    return code


def exchange_pairing_code(code: str) -> str | None:
    expires = _pairing.pop(code, None)
    if not _APPROVAL_TOKEN or expires is None or time.monotonic() > expires:
        return None
    return _APPROVAL_TOKEN
