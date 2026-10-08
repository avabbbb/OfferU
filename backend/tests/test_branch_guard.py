from __future__ import annotations

from scripts.dev.branch_guard import BaselineState, evaluate


def _state(**overrides: object) -> BaselineState:
    data = {
        "mode": "owner-test",
        "repository": "H:/WorkSpace_For_VsCode/Python/OFFERU",
        "branch": "feat/test",
        "head": "a" * 40,
        "base_ref": "origin/main",
        "base_sha": "b" * 40,
        "merge_base": "b" * 40,
        "ahead": 1,
        "behind": 0,
        "dirty": False,
        "named_local_branches": 3,
        "named_branches": ["main", "feat/test", "integration/current"],
        "worktree_count": 4,
        "fetched": True,
    }
    data.update(overrides)
    return BaselineState(**data)


def test_owner_test_accepts_clean_head_that_contains_latest_main() -> None:
    failures, warnings = evaluate(_state(), allow_dirty=False, max_named_branches=3)
    assert failures == []
    assert warnings == []


def test_owner_test_rejects_stale_baseline() -> None:
    failures, _ = evaluate(_state(behind=7), allow_dirty=False, max_named_branches=3)
    assert any("behind origin/main" in item for item in failures)


def test_owner_test_rejects_dirty_worktree() -> None:
    failures, _ = evaluate(_state(dirty=True), allow_dirty=False, max_named_branches=3)
    assert any("working tree is dirty" in item for item in failures)


def test_start_warns_on_branch_budget_and_stale_or_dirty_state() -> None:
    failures, warnings = evaluate(
        _state(
            mode="start",
            behind=2,
            dirty=True,
            named_local_branches=4,
            named_branches=["main", "dev", "integration", "worker-1"],
        ),
        allow_dirty=False,
        max_named_branches=3,
    )
    assert failures == []
    assert any("behind origin/main" in item for item in warnings)
    assert any("working tree is dirty" in item for item in warnings)
    assert any("advisory budget" in item for item in warnings)


def test_integrate_mode_is_advisory_but_owner_test_keeps_hard_floor() -> None:
    failures, warnings = evaluate(
        _state(mode="integrate", behind=1, dirty=True, named_local_branches=9),
        allow_dirty=False,
        max_named_branches=3,
    )
    assert failures == []
    assert len(warnings) >= 3

    owner_failures, _ = evaluate(
        _state(mode="owner-test", behind=1, dirty=True, named_local_branches=9),
        allow_dirty=False,
        max_named_branches=3,
    )
    assert any("behind origin/main" in item for item in owner_failures)
    assert any("working tree is dirty" in item for item in owner_failures)


def test_pr_mode_reports_staleness_without_blocking() -> None:
    failures, warnings = evaluate(
        _state(mode="pr", named_local_branches=9, behind=1),
        allow_dirty=False,
        max_named_branches=3,
    )
    assert failures == []
    assert any("behind origin/main" in item for item in warnings)
    assert any("advisory budget" in item for item in warnings)
