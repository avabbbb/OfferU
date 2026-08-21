"""Agent Bridge OperationGateway (Slice 1).

Maps Bridge `operation.*` requests onto the existing Operation Registry.
Slice 1 exposes read-only Operations only; anything mutation-classed is
rejected with `grant_denied` before execution. No second write path: reads go
through `execute_operation` so audit stays in one place.
"""

from __future__ import annotations

from typing import Any

from app.ops import OPERATIONS, execute_operation, get_operation_schema
from app.services.agent_bridge.errors import BridgeProtocolError

# Slice 1 read-only grant: the pre-application tracer Operation plus the two
# catalog reads every adapter needs to render its tool list.
GRANTED_READ_OPERATIONS: frozenset[str] = frozenset(
    {
        "get_pre_application_state",
        "get_job",
        "list_jobs",
        "get_profile",
    }
)

BRIDGE_SURFACE = "bridge"


def _deny(code: str, message: str, details: dict[str, Any] | None = None) -> BridgeProtocolError:
    return BridgeProtocolError(code, message, details=details)


def granted_operations() -> list[dict[str, Any]]:
    """Registry schemas for the current Slice-1 grant, sorted by name."""
    schemas = []
    for name in sorted(GRANTED_READ_OPERATIONS):
        schema = get_operation_schema(name)
        if schema is not None:
            schemas.append(schema)
    return schemas


async def invoke_read_operation(
    *,
    operation: str,
    arguments: dict[str, Any],
) -> dict[str, Any]:
    """Execute one granted read-only Operation through the Registry."""
    op = OPERATIONS.get(operation)
    if op is None:
        raise _deny(
            "grant_denied",
            "Operation is not granted for this Run",
            {"operation": operation},
        )
    if op.is_mutation:
        # Slice 1 is read-only; mutations arrive with Slice 3 proposals.
        raise _deny(
            "grant_denied",
            "Side-effect operations are not granted for this Run",
            {"operation": operation},
        )
    envelope = await execute_operation(
        operation,
        arguments,
        surface=BRIDGE_SURFACE,
    )
    if not envelope.get("ok"):
        errors = [str(item) for item in envelope.get("errors") or []]
        raise _deny(
            "schema_invalid" if any("缺少必填参数" in e or "未知参数" in e for e in errors) else "internal_error",
            "; ".join(errors) or f"{operation} failed",
            {"operation": operation},
        )
    return {
        "completed": True,
        "value": envelope.get("outputs"),
        "operationVersion": envelope.get("operation_version"),
        "warnings": list(envelope.get("warnings") or []),
    }


__all__ = [
    "BRIDGE_SURFACE",
    "GRANTED_READ_OPERATIONS",
    "granted_operations",
    "invoke_read_operation",
]
