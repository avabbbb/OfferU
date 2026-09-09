from __future__ import annotations

from app.services.agent_conformance import (
    _base_report,
    _parse_lifecycle_message,
    _probe_event_count,
)


def _codex_item() -> dict:
    return {
        "id": "codex",
        "name": "Codex App Server",
        "available": True,
        "contract_compatible": True,
        "executable_path": r"H:\\tools\\codex.cmd",
        "version": "codex-cli test",
    }


def test_probe_event_count_accepts_nested_trace_and_legacy_top_level() -> None:
    assert _probe_event_count({"trace": {"event_count": 59}}) == 59
    assert _probe_event_count({"event_count": 3}) == 3
    assert _probe_event_count({"trace": {"event_count": "bad"}}) == 0


def test_persisted_live_probe_keeps_streaming_verified_after_restart() -> None:
    report = _base_report(
        _codex_item(),
        {
            "authenticated": True,
            "status": "ready",
            "capabilities": {
                "conformance": {
                    "binary_path": r"H:\\tools\\codex.cmd",
                    "version": "codex-cli test",
                    "streaming_verified": "VERIFIED",
                    "live_probe": {"trace": {"event_count": 59}},
                }
            },
        },
    )
    assert report["live_model_verified"] == "NOT_VERIFIED"
    assert report["streaming_verified"] == "VERIFIED"


def test_historical_probe_without_events_does_not_claim_streaming() -> None:
    report = _base_report(
        _codex_item(),
        {
            "authenticated": True,
            "status": "ready",
            "capabilities": {
                "conformance": {
                    "binary_path": r"H:\\tools\\codex.cmd",
                    "version": "codex-cli test",
                    "streaming_verified": "VERIFIED",
                    "live_probe": {"trace": {"event_count": 0}},
                }
            },
        },
    )
    assert report["streaming_verified"] == "NOT_VERIFIED"


def test_lifecycle_message_requires_a_json_object() -> None:
    assert _parse_lifecycle_message('{"resume_probe":"first"}') == {
        "resume_probe": "first"
    }
    assert _parse_lifecycle_message('["resume_probe"]') is None
    assert _parse_lifecycle_message("not-json") is None


def test_failed_lifecycle_state_cannot_be_promoted_by_old_success_evidence() -> None:
    report = _base_report(
        _codex_item(),
        {
            "authenticated": True,
            "status": "ready",
            "capabilities": {
                "conformance": {
                    "binary_path": r"H:\\tools\\codex.cmd",
                    "version": "codex-cli test",
                    "resume_verified": "ERROR",
                    "cancel_verified": "BLOCKED_AUTH",
                    "lifecycle_probe": {
                        "verified": True,
                        "resume": {"verified": True},
                        "cancel": {"verified": True},
                    },
                }
            },
        },
    )
    assert report["resume_verified"] == "ERROR"
    assert report["cancel_verified"] == "BLOCKED_AUTH"
