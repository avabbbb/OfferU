"""One-process capability used only by the embedded OfferU approval UI."""

from __future__ import annotations

import hmac
import os


# Tauri passes this random value to the backend child at launch. Consume it
# immediately so Agent/provider subprocesses cannot inherit the capability.
_APPROVAL_TOKEN = os.environ.pop("OFFERU_APPROVAL_TOKEN", "")


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
