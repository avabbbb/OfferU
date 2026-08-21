from __future__ import annotations

from collections.abc import Mapping
from types import MappingProxyType
from typing import Any, Literal, TypeAlias, cast


ErrorCode: TypeAlias = Literal[
    "protocol_mismatch",
    "capability_mismatch",
    "pairing_required",
    "run_not_found",
    "lease_lost",
    "grant_denied",
    "schema_invalid",
    "context_stale",
    "proposal_pending",
    "proposal_rejected",
    "reconciliation_required",
    "backpressure",
    "internal_error",
]

ERROR_CODES: tuple[ErrorCode, ...] = (
    "protocol_mismatch",
    "capability_mismatch",
    "pairing_required",
    "run_not_found",
    "lease_lost",
    "grant_denied",
    "schema_invalid",
    "context_stale",
    "proposal_pending",
    "proposal_rejected",
    "reconciliation_required",
    "backpressure",
    "internal_error",
)

# ``None`` means the protocol table marks retryability as conditional. Callers
# may decide either way for that specific failure; false is the fail-closed
# default when they do not provide a decision.
ERROR_CODE_RETRYABILITY: Mapping[ErrorCode, bool | None] = MappingProxyType(
    {
        "protocol_mismatch": False,
        "capability_mismatch": False,
        "pairing_required": True,
        "run_not_found": False,
        "lease_lost": None,
        "grant_denied": False,
        "schema_invalid": False,
        "context_stale": True,
        "proposal_pending": True,
        "proposal_rejected": False,
        "reconciliation_required": None,
        "backpressure": True,
        "internal_error": None,
    }
)
ERROR_RETRYABILITY = ERROR_CODE_RETRYABILITY


class BridgeProtocolError(ValueError):
    """A safe, structured Agent Bridge failure.

    The exception never stores the raw input line. This lets the CLI return a
    deterministic protocol error without accidentally echoing career data or
    credentials to stderr.
    """

    def __init__(
        self,
        code: ErrorCode | str,
        message: str,
        *,
        retryable: bool | None = None,
        details: Mapping[str, Any] | None = None,
        request_id: str | None = None,
    ) -> None:
        if code not in ERROR_CODE_RETRYABILITY:
            raise ValueError(f"Unknown Agent Bridge error code: {code!r}")
        if not isinstance(message, str) or not message:
            raise ValueError("Bridge error message must be a non-empty string")
        if retryable is not None and type(retryable) is not bool:
            raise TypeError("retryable must be a bool or None")
        if details is not None and not isinstance(details, Mapping):
            raise TypeError("details must be a mapping or None")
        if request_id is not None and not isinstance(request_id, str):
            raise TypeError("request_id must be a string or None")

        typed_code = cast(ErrorCode, code)
        fixed_retryability = ERROR_CODE_RETRYABILITY[typed_code]
        if fixed_retryability is not None:
            if retryable is not None and retryable != fixed_retryability:
                raise ValueError(
                    f"{typed_code} retryable must be {fixed_retryability}"
                )
            resolved_retryability = fixed_retryability
        else:
            resolved_retryability = False if retryable is None else retryable

        self.code = typed_code
        self.message = message
        self.retryable = resolved_retryability
        self.details = dict(details or {})
        self.request_id = request_id
        super().__init__(message)

    def to_payload(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "message": self.message,
            "retryable": self.retryable,
            "details": dict(self.details),
        }

    def to_response(self, request_id: str | None = None) -> dict[str, Any]:
        from .protocol import error_response

        response_id = self.request_id if request_id is None else request_id
        return error_response(response_id, self)


__all__ = [
    "BridgeProtocolError",
    "ERROR_CODES",
    "ERROR_CODE_RETRYABILITY",
    "ERROR_RETRYABILITY",
    "ErrorCode",
]
