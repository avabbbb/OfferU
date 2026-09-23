from __future__ import annotations

from pathlib import Path

from scripts.live_eval.agent_executor import (
    _extract_identity,
    _offeru_agent_prompt,
    _record_tool_start,
    _write_omp_eval_config,
)


def test_extract_identity_from_rpc_state() -> None:
    model, thinking, session_id = _extract_identity(
        {
            "sessionId": "sess_123",
            "thinkingLevel": "xhigh",
            "model": {"provider": "avabbbb", "modelId": "devin/swe-2"},
        }
    )

    assert model == "avabbbb/devin/swe-2"
    assert thinking == "xhigh"
    assert session_id == "sess_123"


def test_tool_execution_start_is_marked_model_issued() -> None:
    call = _record_tool_start(
        {
            "type": "tool_execution_start",
            "toolName": "bash",
            "toolCallId": "tool_1",
            "args": {"command": "python -m app.cli manifest --pretty"},
        }
    )

    assert call == {
        "tool": "bash",
        "input": "python -m app.cli manifest --pretty",
        "tool_call_id": "tool_1",
        "source": "model",
    }


def test_agent_prompt_does_not_prescribe_business_operation_sequence() -> None:
    prompt = _offeru_agent_prompt("帮我判断这个岗位值不值得投。")

    assert "get_profile" not in prompt
    assert "get_job" not in prompt
    assert "prepare_resume_optimization" not in prompt
    assert "Do not follow a pre-scripted tool sequence" in prompt
    assert "app.cli confirm" in prompt


def test_eval_config_denies_cli_confirm_before_allowing_cli(tmp_path: Path) -> None:
    path = _write_omp_eval_config(tmp_path)
    text = path.read_text(encoding="utf-8")

    deny = text.index('match: "*app.cli confirm*"')
    allow = text.index('match: "python* -m app.cli *"')

    assert deny < allow
    assert "approvalMode: always-ask" in text
    assert "approval: deny" in text
