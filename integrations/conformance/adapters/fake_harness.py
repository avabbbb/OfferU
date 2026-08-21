"""Minimal fake Harness adapter for conformance scenarios.

Reads a JSONL transcript (one request object per line), feeds each line to the
Bridge protocol parser, and records responses. It never touches business
Operations; it exists so later slices can swap in real adapters without
changing scenario files.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from app.services.agent_bridge import (
    BridgeProtocolError,
    parse_request_line,
    success_response,
)


@dataclass
class FakeHarnessAdapter:
    """Drives one scenario transcript against the protocol layer."""

    name: str = "fake-harness"
    version: str = "0.0.1"
    responses: list[dict[str, Any]] = field(default_factory=list)
    errors: list[BridgeProtocolError] = field(default_factory=list)

    def send_line(self, line: str | bytes) -> dict[str, Any] | None:
        """Process one stdin line; returns the response envelope if any."""
        try:
            request = parse_request_line(line)
        except BridgeProtocolError as error:
            self.errors.append(error)
            self.responses.append(error.to_response())
            return self.responses[-1]
        response = success_response(request.id, {"echoedType": str(request.type)})
        self.responses.append(response)
        return response

    def run_transcript(self, path: Path) -> list[dict[str, Any]]:
        for raw in path.read_text(encoding="utf-8").splitlines():
            if not raw.strip():
                continue
            self.send_line(raw)
        return self.responses


def load_transcript(name: str) -> list[str]:
    fixture = Path(__file__).parent / "fixtures" / name
    return [line for line in fixture.read_text(encoding="utf-8").splitlines() if line.strip()]


def transcript_lines(name: str) -> list[dict[str, Any]]:
    return [json.loads(line) for line in load_transcript(name)]
