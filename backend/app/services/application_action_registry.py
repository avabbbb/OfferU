"""Registry for external application-action connectors.

Mirrors ``job_sources.router.JobSourceRouter`` but for the *write* plane.
Per ADR-0058, a ``JobSource`` (read/search) never satisfies this protocol —
external write capability is a separate trust boundary behind a protected
Operation + Proposal/HITL.

Phase 1 registers no real executor: the registry exists so the capability
matrix, idempotency, and audit seams are stable before any CLI / browser
bridge / extension adapter lands. ``list_application_action_connectors``
surfaces an empty-but-honest matrix rather than pretending a write path
exists.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any

from app.services.application_actions import (
    ApplicationActionConnector,
    ApplicationActionStatus,
)


@dataclass
class ConnectorCapabilityRow:
    """One row of the capability matrix for a registered connector."""

    source_id: str
    status: ApplicationActionStatus
    greet: bool
    send_message: bool
    send_resume: bool
    exchange_contact: bool
    execution_available: bool
    error: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "source_id": self.source_id,
            "status": self.status,
            "capabilities": {
                "greet": self.greet,
                "send_message": self.send_message,
                "send_resume": self.send_resume,
                "exchange_contact": self.exchange_contact,
            },
            "execution_available": self.execution_available,
            "error": self.error,
        }


class ApplicationActionConnectorRegistry:
    """Holds registered write-plane connectors keyed by ``source_id``."""

    def __init__(self) -> None:
        self._connectors: dict[str, ApplicationActionConnector] = {}

    def register(self, connector: ApplicationActionConnector) -> None:
        self._connectors[connector.source_id] = connector

    def unregister(self, source_id: str) -> None:
        self._connectors.pop(source_id, None)

    def connectors(self) -> list[ApplicationActionConnector]:
        return list(self._connectors.values())

    def get(self, source_id: str) -> ApplicationActionConnector | None:
        return self._connectors.get(source_id)

    async def capability_matrix(self) -> dict[str, Any]:
        """Concurrently collect each connector's status + capabilities.

        A connector whose ``status()``/``capabilities()`` raises is reported
        UNAVAILABLE with its error, never silently dropped — the matrix is a
        diagnostics surface.
        """

        async def _row(conn: ApplicationActionConnector) -> ConnectorCapabilityRow:
            try:
                status = await asyncio.wait_for(conn.status(), timeout=10.0)
            except Exception as exc:  # noqa: BLE001 — surface, don't hide
                return ConnectorCapabilityRow(
                    source_id=conn.source_id,
                    status="UNAVAILABLE",
                    greet=False,
                    send_message=False,
                    send_resume=False,
                    exchange_contact=False,
                    execution_available=False,
                    error=f"{type(exc).__name__}: {exc}",
                )
            try:
                caps = await asyncio.wait_for(conn.capabilities(), timeout=10.0)
            except Exception as exc:  # noqa: BLE001
                return ConnectorCapabilityRow(
                    source_id=conn.source_id,
                    status=status,
                    greet=False,
                    send_message=False,
                    send_resume=False,
                    exchange_contact=False,
                    execution_available=False,
                    error=f"capabilities: {type(exc).__name__}: {exc}",
                )
            return ConnectorCapabilityRow(
                source_id=conn.source_id,
                status=status,
                greet=caps.greet,
                send_message=caps.send_message,
                send_resume=caps.send_resume,
                exchange_contact=caps.exchange_contact,
                # Phase 1: no external executor is wired, so nothing may report
                # executable even if a connector claims a capability.
                execution_available=False,
            )

        rows = await asyncio.gather(*(_row(c) for c in self._connectors.values()))
        return {
            "schema": "offeru.application_action_capability_matrix.v1",
            "execution_plane": "external_write",
            "execution_available": False,
            "note": "站外写执行器尚未接入；能力矩阵仅声明边界，任何真实写都必须走受保护 Operation + Proposal/HITL。",
            "connectors": [r.to_dict() for r in rows],
        }


application_action_connector_registry = ApplicationActionConnectorRegistry()
