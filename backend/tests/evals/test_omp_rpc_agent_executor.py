from __future__ import annotations

import asyncio
import base64
import json
import os
from pathlib import Path
import time
from types import SimpleNamespace

from scripts.live_eval import agent_executor
from scripts.live_eval.agent_executor import (
    _RpcFrameReader,
    _extract_identity,
    _offeru_agent_prompt,
    _probe_omp_cached,
    probe_omp_cli,
    _record_tool_start,
    _write_omp_eval_config,
)
from scripts.live_eval.cases import LIVE_EVAL_CASES
from scripts.live_eval.runner import _build_prompt, _write_summary


def test_omp_capability_probe_flattens_command_and_caches_by_mtime(
    tmp_path: Path, monkeypatch,
) -> None:
    executable = tmp_path / "omp.cmd"
    executable.write_text("fixture", encoding="utf-8")
    calls: list[tuple[list[str], dict[str, object]]] = []

    def command(executable_arg: str, args: list[str]) -> tuple[str, list[str]]:
        return "probe-wrapper", ["--forward", executable_arg, *args]

    def run(argv: list[str], **kwargs: object) -> SimpleNamespace:
        assert isinstance(argv, list)
        assert not any(isinstance(item, list) for item in argv)
        calls.append((argv, kwargs))
        output = (
            "OMP test version"
            if argv[-1] == "--version"
            else "--mode rpc --no-session --model --thinking --config --tools --approval-mode"
        )
        return SimpleNamespace(returncode=0, stdout=output, stderr="")

    _probe_omp_cached.cache_clear()
    monkeypatch.setattr(agent_executor, "_coding_agent_command", command)
    monkeypatch.setattr(agent_executor.subprocess, "run", run)

    first = probe_omp_cli(str(executable))
    second = probe_omp_cli(str(executable))

    assert first["ok"] is True
    assert first["version"] == "OMP test version"
    assert second == first
    assert [argv for argv, _ in calls] == [
        ["probe-wrapper", "--forward", str(executable), "--version"],
        ["probe-wrapper", "--forward", str(executable), "--help"],
    ]
    assert all(kwargs["timeout"] >= 20 for _, kwargs in calls)
    assert all(kwargs.get("shell", False) is False for _, kwargs in calls)

    stat = executable.stat()
    os.utime(executable, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000_000))
    third = probe_omp_cli(str(executable))

    assert third == first
    assert len(calls) == 4
    _probe_omp_cached.cache_clear()


def test_omp_discovery_prefers_windows_launcher_but_preserves_explicit_paths(
    tmp_path: Path, monkeypatch,
) -> None:
    discovered_shim = str(tmp_path / "omp")
    discovered_cmd = str(tmp_path / "omp.cmd")
    discovered_exe = str(tmp_path / "omp.exe")
    explicit_path = str(tmp_path / "configured-omp")
    env_path = str(tmp_path / "env-omp")
    candidates = {
        "omp": discovered_shim,
        "omp.cmd": discovered_cmd,
        "omp.exe": discovered_exe,
    }
    lookups: list[str] = []

    def which(name: str) -> str | None:
        lookups.append(name)
        return candidates.get(name)

    monkeypatch.delenv("OFFERU_OMP_PATH", raising=False)
    assert agent_executor._resolve_omp_executable(
        explicit_path, is_windows=True, which=which,
    ) == explicit_path
    monkeypatch.setenv("OFFERU_OMP_PATH", env_path)
    assert agent_executor._resolve_omp_executable(
        is_windows=True, which=which,
    ) == env_path
    assert lookups == []

    monkeypatch.delenv("OFFERU_OMP_PATH")
    assert agent_executor._resolve_omp_executable(
        is_windows=True, which=which,
    ) == discovered_cmd
    assert lookups == ["omp", "omp.cmd"]

    lookups.clear()
    assert agent_executor._resolve_omp_executable(
        is_windows=False, which=which,
    ) == discovered_shim
    assert lookups == ["omp"]


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


def test_omp_eval_prompt_uses_the_cli_form_allowed_by_omp_policy() -> None:
    case = next(item for item in LIVE_EVAL_CASES if item.case_id == "E16")

    omp_prompt = _build_prompt(case, case.user_turns[0], runtime="omp")
    codebuddy_prompt = _build_prompt(case, case.user_turns[0], runtime="codebuddy")

    assert "python -m app.cli <子命令>" in omp_prompt
    assert "PYTHONPATH=backend backend/.venv312/Scripts/python.exe" not in omp_prompt
    assert "PYTHONPATH=backend backend/.venv312/Scripts/python.exe" in codebuddy_prompt


def test_eval_config_denies_cli_confirm_before_allowing_cli(tmp_path: Path) -> None:
    path = _write_omp_eval_config(tmp_path)
    text = path.read_text(encoding="utf-8")

    deny = text.index('match: "*app.cli confirm*"')
    reject_deny = text.index('match: "*app.cli run reject_agent_run*"')
    allow = text.index('match: "python* -m app.cli *"')
    bare_cli_allow = text.index('match: "python* -m app.cli"')

    assert deny < allow
    assert reject_deny < allow
    assert allow < bare_cli_allow
    assert "approvalMode: always-ask" in text
    assert "bash: prompt" in text
    assert "approval: deny" in text


def test_agent_cannot_self_reject_a_pending_proposal() -> None:
    prompt = _offeru_agent_prompt("请帮我处理这个岗位。")

    assert "Do not call app.cli confirm or reject_agent_run" in prompt


def test_agent_native_summary_stays_not_run_when_case_passes(tmp_path: Path) -> None:
    _write_summary(
        tmp_path,
        [{
            "case_id": "E16",
            "slug": "proposal-review",
            "status": "PASS",
            "issue_type": "none",
            "hard_gate_violations": [],
            "scores": {},
        }],
        mode="real-user",
        suite="smoke",
        freeze={"runtime": "omp"},
    )

    summary = json.loads((tmp_path / "summary.json").read_text(encoding="utf-8"))

    assert summary["passed"] == 1
    assert summary["agent_native_e2e"]["status"] == "NOT_RUN"
    assert "OS isolation" in summary["agent_native_e2e"]["reason"]
    assert "observer-verified human decision" in summary["agent_native_e2e"]["reason"]


def test_real_user_mode_does_not_simulate_reject_policy(tmp_path: Path, monkeypatch) -> None:
    import sqlite3
    from dataclasses import replace

    from scripts.live_eval import runner
    from scripts.live_eval.cases import CONFIRM_REJECT
    from scripts.live_eval.grader import Trace

    case = replace(
        next(item for item in LIVE_EVAL_CASES if item.case_id == "E16"),
        confirmation_policy=CONFIRM_REJECT,
        user_turns=("Review this job and prepare a proposal if appropriate.",),
    )

    def create_eval_db(_source_db: Path, eval_db: Path) -> None:
        with sqlite3.connect(eval_db) as connection:
            connection.execute(
                "CREATE TABLE agent_runs (run_id TEXT, status TEXT, failure_reason TEXT, steps_json TEXT, goal TEXT, created_at TEXT)"
            )
            connection.execute(
                "CREATE TABLE operation_audit_logs (id INTEGER PRIMARY KEY, idempotency_key TEXT, operation TEXT)"
            )

    monkeypatch.setattr(runner, "clone_database", create_eval_db)
    monkeypatch.setattr(runner, "_pick_target_job", lambda _db, pinned_job_id=None: pinned_job_id or 1)
    monkeypatch.setattr(runner, "_seed_current_view", lambda _url, _eval_db, _job_id: {"ok": True})
    monkeypatch.setattr(runner, "snapshot", lambda _db: {"tables": {}, "rows": {}})
    monkeypatch.setattr(runner, "_audit_keys", lambda _db: set())
    simulated_cli_calls: list[tuple[object, ...]] = []
    monkeypatch.setattr(
        runner,
        "_run_cli",
        lambda *args: simulated_cli_calls.append(args) or {"ok": True},
    )

    async def fake_harness(_prompt: str, *, eval_db: Path, timeout: int) -> Trace:
        del timeout
        with sqlite3.connect(eval_db) as connection:
            connection.execute(
                "INSERT INTO agent_runs VALUES (?, ?, ?, ?, ?, ?)",
                (
                    "run_pending",
                    "waiting_confirmation",
                    "",
                    '[{"id":"action_1","tool":"prepare_resume_optimization",'
                    '"status":"waiting_confirmation","requires_confirmation":true}]',
                    "Prepare a resume proposal",
                    "2026-09-23",
                ),
            )
        return Trace(case_id=case.case_id, case_slug=case.slug, final_text="The proposal is waiting for review.")

    monkeypatch.setattr(runner, "_run_harness_once", fake_harness)

    asyncio.run(
        runner.run_case_once(
            case,
            run_dir=tmp_path / "run",
            source_db=tmp_path / "source.db",
            timeout=5,
            mode="real-user",
            runtime="codebuddy",
        )
    )

    assert simulated_cli_calls == []


def test_grader_audit_excludes_only_confirmations_bound_to_accepted_human_decisions() -> None:
    from scripts.live_eval.runner import _audit_rows_for_grading

    full_audit = [
        {
            "id": 1,
            "operation": "set_current_view",
            "confirmation_ref": "agent-run:run_1:action_1",
            "surface": "pi",
            "idempotency_key": "run_1:action_1",
            "status": "completed",
            "dry_run": False,
        },
        {
            "id": 2,
            "operation": "set_current_view",
            "confirmation_ref": "agent-run:run_2:action_2",
            "surface": "agent_runtime_ui",
            "idempotency_key": "run_2:action_2",
            "status": "completed",
            "dry_run": False,
        },
        {"id": 3, "operation": "get_profile", "confirmation_ref": None},
        {
            "id": 4,
            "operation": "triage_job",
            "confirmation_ref": "agent-run:run_3:action_3",
            "surface": "cli",
            "idempotency_key": "run_3:action_3",
            "status": "completed",
            "dry_run": False,
        },
        {
            "id": 5,
            "operation": "set_current_view",
            "confirmation_ref": "agent-run:run_1:action_1",
            "surface": "cli",
            "idempotency_key": "run_1:action_1:cli",
            "status": "completed",
            "dry_run": False,
        },
        {
            "id": 6,
            "operation": "triage_job",
            "confirmation_ref": "agent-run:run_4:action_4",
            "surface": "agent_runtime_ui",
            "idempotency_key": "run_4:action_4",
            "status": "completed",
            "dry_run": False,
        },
    ]
    human_decisions = [
        {"run_id": "run_1", "action_id": "action_1", "decision": "accepted"},
        {"run_id": "run_2", "action_id": "action_2", "decision": "rejected"},
        {"run_id": "run_3", "action_id": "action_3", "decision": "approve"},
        {"run_id": "run_4", "action_id": "action_4", "decision": "accepted"},
    ]

    grader_rows, excluded_ids = _audit_rows_for_grading(
        full_audit,
        human_decisions=human_decisions,
    )

    assert [row["id"] for row in grader_rows] == [2, 3, 5]
    assert excluded_ids == [1, 4, 6]
    assert [row["id"] for row in full_audit] == [1, 2, 3, 4, 5, 6]


def test_real_user_human_review_continues_through_one_omp_session(tmp_path: Path, monkeypatch) -> None:
    import sqlite3
    from dataclasses import replace

    from scripts.live_eval import runner
    from scripts.live_eval.cases import CONFIRM_MANUAL
    from scripts.live_eval.grader import Trace

    case = replace(
        next(item for item in LIVE_EVAL_CASES if item.case_id == "E16"),
        confirmation_policy=CONFIRM_MANUAL,
        user_turns=("Prepare a suitable proposal for this role.",),
        max_turns=3,
    )
    session_instances: list[object] = []
    seen_sessions: list[object] = []

    class FakeOmpSession:
        def __init__(self, *, eval_db: Path, session_dir: Path, model: str, thinking: str) -> None:
            del session_dir, model, thinking
            self.eval_db = eval_db
            self.start_count = 0
            self.close_count = 0
            session_instances.append(self)

        async def start(self) -> str:
            self.start_count += 1
            return ""

        async def close(self) -> str:
            self.close_count += 1
            return ""

    def create_eval_db(_source_db: Path, eval_db: Path) -> None:
        with sqlite3.connect(eval_db) as connection:
            connection.execute(
                "CREATE TABLE agent_runs (run_id TEXT, status TEXT, failure_reason TEXT, steps_json TEXT, goal TEXT, created_at TEXT)"
            )
            connection.execute(
                "CREATE TABLE operation_audit_logs (id INTEGER PRIMARY KEY, idempotency_key TEXT, operation TEXT, surface TEXT, confirmation_ref TEXT)"
            )

    async def fake_harness(
        prompt: str,
        *,
        session: FakeOmpSession,
        timeout: int,
        case_dir: Path,
        round_index: int,
    ) -> Trace:
        del timeout, case_dir
        seen_sessions.append(session)
        if round_index == 1:
            with sqlite3.connect(session.eval_db) as connection:
                connection.execute(
                    "INSERT INTO agent_runs VALUES (?, ?, ?, ?, ?, ?)",
                    (
                        "run_pending",
                        "waiting_confirmation",
                        "",
                        '[{"id":"action_1","tool":"prepare_resume_optimization",'
                        '"status":"waiting_confirmation","requires_confirmation":true}]',
                        "Prepare a resume proposal",
                        "2026-09-23",
                    ),
                )
        else:
            assert "The OfferU human-review state changed" in prompt
        return Trace(
            case_id=case.case_id,
            case_slug=case.slug,
            final_text=f"round-{round_index}",
            events=[{"type": "agent_end", "round": round_index}],
            tool_calls=[{"tool": "bash", "input": f"call-{round_index}"}],
        )

    async def accept_in_ui(
        eval_db: Path,
        actions: list[dict[str, str]],
        *,
        timeout: int,
        database_path: Path,
    ) -> list[dict[str, str]]:
        del timeout, database_path
        action = actions[0]
        with sqlite3.connect(eval_db) as connection:
            connection.execute(
                "UPDATE agent_runs SET status = ?, steps_json = ? WHERE run_id = ?",
                (
                    "completed",
                    '[{"id":"action_1","tool":"prepare_resume_optimization",'
                    '"status":"completed","requires_confirmation":true}]',
                    action["run_id"],
                ),
            )
        return [{**action, "decision": "accepted", "status": "completed", "step_status": "completed"}]

    monkeypatch.setattr(runner, "OmpRpcAgentSession", FakeOmpSession)
    monkeypatch.setattr(runner, "_run_harness_omp", fake_harness)
    monkeypatch.setattr(runner, "_wait_for_human_review", accept_in_ui)
    monkeypatch.setattr(runner, "clone_database", create_eval_db)
    monkeypatch.setattr(runner, "_pick_target_job", lambda _db, pinned_job_id=None: pinned_job_id or 1)
    monkeypatch.setattr(runner, "_seed_current_view", lambda _url, _eval_db, _job_id: {"ok": True})
    monkeypatch.setattr(runner, "snapshot", lambda _db: {"tables": {}, "rows": {}})
    monkeypatch.setattr(runner, "_audit_keys", lambda _db: set())

    asyncio.run(
        runner.run_case_once(
            case,
            run_dir=tmp_path / "run",
            source_db=tmp_path / "source.db",
            timeout=5,
            mode="real-user",
            runtime="omp",
            model="test/model",
            thinking="high",
        )
    )

    assert len(session_instances) == 1
    assert session_instances[0].start_count == 1
    assert session_instances[0].close_count == 1
    assert len(seen_sessions) == 2
    assert all(session is session_instances[0] for session in seen_sessions)

    case_dir = tmp_path / "run" / case.slug
    full_trace = json.loads((case_dir / "trace.json").read_text(encoding="utf-8"))
    full_calls = json.loads((case_dir / "tool_calls.json").read_text(encoding="utf-8"))
    grader_trace = json.loads((case_dir / "grader_trace.json").read_text(encoding="utf-8"))
    assert full_trace["final_text"] == "round-1\n\nround-2"
    assert [call["input"] for call in full_calls] == ["call-1", "call-2"]
    assert grader_trace["final_text"] == "round-1"
    assert [call["input"] for call in grader_trace["tool_calls"]] == ["call-1"]


def test_human_review_status_is_read_from_persisted_agent_run(tmp_path: Path) -> None:
    import sqlite3

    from scripts.live_eval.runner import (
        _agent_run_action_state,
        _human_review_continuation_prompt,
        _new_proposed_actions,
    )

    database = tmp_path / "eval.db"
    with sqlite3.connect(database) as connection:
        connection.execute(
            "CREATE TABLE agent_runs (run_id TEXT, status TEXT, failure_reason TEXT, steps_json TEXT, goal TEXT, created_at TEXT)"
        )
        connection.execute(
            "INSERT INTO agent_runs VALUES (?, ?, ?, ?, ?, ?)",
            ("run_accepted", "completed", "", '[{"id":"action_1","status":"completed","requires_confirmation":true}]', "accepted goal", "2026-09-23"),
        )
        connection.execute(
            "INSERT INTO agent_runs VALUES (?, ?, ?, ?, ?, ?)",
            ("run_rejected", "needs_reconciliation", "rejected_by_user", '[{"id":"action_2","status":"waiting_confirmation","requires_confirmation":true}]', "rejected goal", "2026-09-23"),
        )
        connection.execute(
            "INSERT INTO agent_runs VALUES (?, ?, ?, ?, ?, ?)",
            ("run_executing", "executing", "", '[{"id":"action_3","status":"executing"}]', "executing goal", "2026-09-23"),
        )
        connection.execute(
            "INSERT INTO agent_runs VALUES (?, ?, ?, ?, ?, ?)",
            (
                "run_partial_reject",
                "waiting_confirmation",
                "",
                '[{"id":"action_4","tool":"update_job","status":"rejected",'
                '"requires_confirmation":true},{"id":"action_5","tool":"update_profile",'
                '"status":"waiting_confirmation","requires_confirmation":true}]',
                "partial reject goal",
                "2026-09-23",
            ),
        )

    assert _agent_run_action_state(database, "run_accepted", "action_1")["decision"] == "accepted"
    assert _agent_run_action_state(database, "run_rejected", "action_2")["decision"] == "rejected"
    assert _agent_run_action_state(database, "run_executing", "action_3")["decision"] == "in_progress"
    assert _agent_run_action_state(database, "run_partial_reject", "action_4")["decision"] == "rejected"
    assert _agent_run_action_state(database, "run_partial_reject", "action_5")["decision"] == "pending"
    assert {
        item["action_id"]
        for item in _new_proposed_actions(
            database, exclude_run_ids=set(), exclude_action_keys=set(),
        )
    } == {"action_1", "action_2", "action_4", "action_5"}
    followup = _human_review_continuation_prompt([
        {"run_id": "run_rejected", "action_id": "action_2", "decision": "rejected"},
    ])
    assert "do not repeat it" in followup
    assert "route around that decision" in followup


def test_rpc_v2_frame_reader_reassembles_utf8_chunks() -> None:
    expected = {"type": "response", "id": "large", "data": {"text": "求职信息" * 400}}
    encoded = json.dumps(expected, ensure_ascii=False).encode("utf-8")
    split = len(encoded) // 2
    parts = (encoded[:split], encoded[split:])

    async def _read_reassembled() -> dict:
        # Build the StreamReader inside the running loop so Python 3.12 does
        # not require a pre-set current event loop in the main thread.
        stream = asyncio.StreamReader()
        for index, part in enumerate(parts):
            stream.feed_data(
                (
                    json.dumps(
                        {
                            "type": "rpc_chunk",
                            "chunkId": "rpc-large",
                            "index": index,
                            "count": len(parts),
                            "byteLength": len(encoded),
                            "data": base64.b64encode(part).decode("ascii"),
                        }
                    )
                    + "\n"
                ).encode("utf-8")
            )
        stream.feed_eof()
        return await _RpcFrameReader(stream, lambda: 0).read(deadline=time.monotonic() + 2)

    actual = asyncio.run(_read_reassembled())

    assert actual == expected
