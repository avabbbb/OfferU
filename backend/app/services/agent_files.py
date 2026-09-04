from __future__ import annotations

import json
import os
import uuid
from pathlib import Path
from typing import Any

from app.services.security_redaction import redact_secret_value


def atomic_write_json(path: Path, payload: Any) -> None:
    """Write a canonical Agent file without exposing readers to partial JSON."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    safe_payload = redact_secret_value(payload)
    try:
        with temporary.open("w", encoding="utf-8", newline="\n") as handle:
            json.dump(safe_payload, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def atomic_write_bytes(path: Path, payload: bytes) -> None:
    """Write a binary Agent artifact without exposing partial output."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)
