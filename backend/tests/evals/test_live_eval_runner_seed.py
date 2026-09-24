from __future__ import annotations

import asyncio
import sqlite3
from dataclasses import replace
from pathlib import Path

import pytest

from scripts.live_eval import runner
from scripts.live_eval.cases import LIVE_EVAL_CASES


def _eval_url(path: Path) -> str:
    return f"sqlite+aiosqlite:///{path.resolve().as_posix()}"


def _create_initialized_schema(path: Path, *, job_id: int) -> None:
    with sqlite3.connect(path) as connection:
        connection.execute("CREATE TABLE jobs (id INTEGER PRIMARY KEY)")
        connection.execute(
            """
            CREATE TABLE agent_workspace_states (
                id INTEGER PRIMARY KEY,
                scope TEXT NOT NULL UNIQUE,
                route TEXT NOT NULL DEFAULT '',
                title TEXT NOT NULL DEFAULT '',
                entity_type TEXT NOT NULL DEFAULT '',
                entity_id TEXT NOT NULL DEFAULT '',
                selection_json JSON NOT NULL DEFAULT '{}',
                filters_json JSON NOT NULL DEFAULT '{}',
                context_json JSON NOT NULL DEFAULT '{}',
                version INTEGER NOT NULL DEFAULT 1,
                updated_by TEXT NOT NULL DEFAULT 'unknown',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        connection.execute(
            "CREATE TABLE agent_runs (run_id TEXT PRIMARY KEY, status TEXT NOT NULL)"
        )
        connection.execute("INSERT INTO jobs (id) VALUES (?)", (job_id,))


def test_eval_subprocess_environment_uses_private_data_dir(tmp_path: Path) -> None:
    database = tmp_path / "case" / "eval.db"
    data_dir = database.parent / "offeru-data"

    env = runner._child_environment(_eval_url(database), data_dir=data_dir)

    assert env["DATABASE_URL"] == _eval_url(database)
    assert env["OFFERU_DATA_DIR"] == str(data_dir.resolve())


def test_clone_database_rejects_redirected_ancestor_before_unlink(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source_db = tmp_path / "source.db"
    source_db.touch()
    redirected_root = tmp_path / "linked-root"
    destination = redirected_root / "case" / "eval.db"
    destination.parent.mkdir(parents=True)
    destination.write_text("preserve existing target", encoding="utf-8")
    original_is_symlink = Path.is_symlink

    def report_symlink(path: Path) -> bool:
        return path == redirected_root or original_is_symlink(path)

    monkeypatch.setattr(Path, "is_symlink", report_symlink)

    with pytest.raises(
        ValueError,
        match="clone destination must not traverse a symlink or junction",
    ):
        runner.clone_database(source_db, destination)

    assert destination.read_text(encoding="utf-8") == "preserve existing target"


def test_seed_current_view_initializes_clone_then_writes_fixture_context(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    eval_db = tmp_path / "case" / "eval.db"
    eval_db.parent.mkdir()
    eval_db.touch()
    calls: list[tuple[str, list[str], Path | None]] = []

    def initialize_clone(
        database_url: str,
        args: list[str],
        *,
        data_dir: Path | None = None,
    ) -> dict[str, object]:
        calls.append((database_url, args, data_dir))
        _create_initialized_schema(eval_db, job_id=73)
        return {"ok": True}

    monkeypatch.setattr(runner, "_run_cli", initialize_clone)
    result = runner._seed_current_view(_eval_url(eval_db), eval_db, 73)

    assert calls == [(
        _eval_url(eval_db),
        ["run", "get_current_view", "--args", '{"scope":"default"}'],
        eval_db.parent / "offeru-data",
    )]
    assert result == {
        "ok": True,
        "stage": "fixture_context",
        "fixture_only": True,
        "context_kind": "current_job_selection",
        "job_id": 73,
        "side_effect_operation_executed": False,
        "proposal_created": False,
        "approval_performed": False,
    }

    with sqlite3.connect(eval_db) as connection:
        row = connection.execute(
            "SELECT scope, route, title, entity_type, entity_id, selection_json, "
            "filters_json, context_json, version, updated_by FROM agent_workspace_states"
        ).fetchone()
        assert row == (
            "default",
            "/jobs/73",
            "Live Eval fixture job",
            "job",
            "73",
            "{}",
            "{}",
            "{}",
            1,
            "live_eval_fixture",
        )
        assert connection.execute("SELECT COUNT(*) FROM agent_runs").fetchone()[0] == 0


def test_seed_current_view_rejects_a_url_that_does_not_match_the_clone(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    eval_db = tmp_path / "eval.db"
    other_db = tmp_path / "source.db"
    eval_db.touch()
    other_db.touch()
    monkeypatch.setattr(
        runner,
        "_run_cli",
        lambda *_args, **_kwargs: pytest.fail("must validate before invoking the CLI"),
    )

    with pytest.raises(ValueError, match="exactly to the isolated Live Eval clone"):
        runner._seed_current_view(_eval_url(other_db), eval_db, 73)


def test_capability_mode_is_rejected_before_any_eval_database_work(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    clone_calls: list[Path] = []
    monkeypatch.setattr(
        runner,
        "clone_database",
        lambda _source, destination: clone_calls.append(destination),
    )

    with pytest.raises(ValueError, match="capability mode is unavailable"):
        asyncio.run(
            runner.run_case_once(
                LIVE_EVAL_CASES[0],
                run_dir=tmp_path / "run",
                source_db=tmp_path / "source.db",
                timeout=1,
                mode="capability",
            )
        )

    assert clone_calls == []


def test_capability_mode_is_not_an_available_cli_choice() -> None:
    with pytest.raises(SystemExit) as raised:
        runner.main(["--mode", "capability"])

    assert raised.value.code == 2


@pytest.mark.parametrize(
    ("symlink_kind", "expected_message"),
    [
        ("case_dir", "must not traverse a symlink or junction"),
        ("eval_db", "must not traverse a symlink or junction"),
        ("run_dir", "must not traverse a symlink or junction"),
        ("ancestor", "must not traverse a symlink or junction"),
        ("junction", "must not traverse a symlink or junction"),
    ],
)
def test_run_case_rejects_redirected_path_components_before_cloning(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    symlink_kind: str,
    expected_message: str,
) -> None:
    case = LIVE_EVAL_CASES[0]
    run_dir = tmp_path / "runs"
    case_dir = run_dir / case.slug
    if symlink_kind == "case_dir":
        redirected_path = case_dir
    elif symlink_kind == "eval_db":
        redirected_path = case_dir / "eval.db"
    elif symlink_kind == "run_dir":
        redirected_path = run_dir
    else:
        redirected_path = run_dir.parent
    original_is_symlink = Path.is_symlink
    original_is_junction = getattr(Path, "is_junction", None)
    clone_calls: list[Path] = []

    def report_symlink(path: Path) -> bool:
        return (
            symlink_kind != "junction" and path == redirected_path
        ) or original_is_symlink(path)

    def report_junction(path: Path) -> bool:
        if symlink_kind == "junction" and path == redirected_path:
            return True
        if original_is_junction is not None:
            return original_is_junction(path)
        return original_is_symlink(path)

    monkeypatch.setattr(Path, "is_symlink", report_symlink)
    monkeypatch.setattr(Path, "is_junction", report_junction, raising=False)
    monkeypatch.setattr(
        runner,
        "clone_database",
        lambda _source, destination: clone_calls.append(destination),
    )

    with pytest.raises(ValueError, match=expected_message):
        asyncio.run(
            runner.run_case_once(
                case,
                run_dir=run_dir,
                source_db=tmp_path / "source.db",
                timeout=1,
                mode="real-user",
            )
        )

    assert clone_calls == []


def test_run_case_rejects_case_slug_that_escapes_run_directory(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    case = LIVE_EVAL_CASES[0]
    escaped_case = replace(case, slug="../outside")
    clone_calls: list[Path] = []
    monkeypatch.setattr(
        runner,
        "clone_database",
        lambda _source, destination: clone_calls.append(destination),
    )

    with pytest.raises(ValueError, match="case path escapes its run directory"):
        asyncio.run(
            runner.run_case_once(
                escaped_case,
                run_dir=tmp_path / "runs",
                source_db=tmp_path / "source.db",
                timeout=1,
                mode="real-user",
            )
        )

    assert clone_calls == []
