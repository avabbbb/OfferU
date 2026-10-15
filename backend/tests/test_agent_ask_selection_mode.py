"""Ask selection semantics (docs/02 §4.2, D-3).

Single-choice questions must accept exactly one option, multiple-choice
questions honour min/max, free text is the「其他」answer and skip is the
always-available exit when the agent allows it.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from uuid import uuid4

import pytest

from app.services.agent_run_state import validate_agent_input_answer
from proposal_v2_fixtures import make_db

OPTIONS = [
    {"option_id": "product", "label": "产品经历", "recommended": True},
    {"option_id": "tech", "label": "技术经历", "recommended": True},
    {"option_id": "both", "label": "都写"},
]


@pytest.fixture
def ask_db(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    database = make_db(tmp_path, monkeypatch)
    asyncio.run(database.start(create_schema=True))
    yield database
    asyncio.run(database.close())


async def _new_run() -> str:
    from app.services import agent_run_state

    run_id = f"run_{uuid4().hex[:16]}"
    await agent_run_state.create_agent_run(
        conversation_id=f"ask-{run_id}",
        goal="Ask fixture",
        mode="ask_selection_fixture",
        skill_id="tailor_resume",
        actions=[],
        run_id=run_id,
    )
    return run_id


def _answer(**overrides):
    value = {"answer_id": "a1", "selected_option_ids": [], "free_text": ""}
    value.update(overrides)
    return value


def test_single_is_default_and_keeps_only_one_recommendation(ask_db):
    async def run():
        from app.services import agent_run_state

        run_id = await _new_run()
        request = await agent_run_state.create_agent_input_request(
            run_id, question="突出哪段经历？", options=OPTIONS
        )
        assert request["selection_mode"] == "single"
        assert request["max_selections"] == 1
        assert request["allow_skip"] is True
        assert [o.get("recommended") for o in request["options"]] == [True, None, None]

        rejected = await agent_run_state.answer_agent_input_request(
            run_id, request["request_id"],
            answer=_answer(selected_option_ids=["product", "tech"]),
        )
        assert rejected["ok"] is False and rejected["error"] == "invalid"
        # A rejected answer must not consume the question (no dead end).
        pending = await agent_run_state.list_pending_agent_input_requests(run_id)
        assert [item["request_id"] for item in pending] == [request["request_id"]]

        accepted = await agent_run_state.answer_agent_input_request(
            run_id, request["request_id"], answer=_answer(selected_option_ids=["tech"]),
        )
        assert accepted["ok"] is True

    asyncio.run(run())


def test_multiple_clamps_bounds_so_the_question_stays_answerable(ask_db):
    async def run():
        from app.services import agent_run_state

        run_id = await _new_run()
        request = await agent_run_state.create_agent_input_request(
            run_id, question="哪些城市可以接受？", options=OPTIONS,
            selection_mode="multiple", min_selections=9, max_selections=2,
        )
        assert request["selection_mode"] == "multiple"
        assert (request["min_selections"], request["max_selections"]) == (2, 2)

    asyncio.run(run())


def test_skip_is_an_exit_and_unknown_mode_falls_back_to_single(ask_db):
    async def run():
        from app.services import agent_run_state

        run_id = await _new_run()
        request = await agent_run_state.create_agent_input_request(
            run_id, question="期望薪资？", options=OPTIONS, selection_mode="weird",
        )
        assert request["selection_mode"] == "single"
        skipped = await agent_run_state.answer_agent_input_request(
            run_id, request["request_id"], answer=_answer(skipped=True),
        )
        assert skipped["ok"] is True
        assert skipped["request"]["answer"]["skipped"] is True

    asyncio.run(run())


@pytest.mark.parametrize(
    ("request_overrides", "answer", "expected_fragment"),
    [
        ({}, _answer(), "跳过"),
        ({}, _answer(selected_option_ids=["nope"]), "不属于"),
        ({}, _answer(selected_option_ids=["product", "product"]), "重复"),
        ({"allow_skip": False}, _answer(skipped=True), "不能跳过"),
        ({}, _answer(skipped=True, selected_option_ids=["tech"]), "跳过时"),
        ({"allow_free_text": False}, _answer(free_text="都行"), "自由输入"),
        ({"selection_mode": "multiple", "max_selections": 2},
         _answer(selected_option_ids=["product", "tech", "both"]), "最多"),
        ({"selection_mode": "multiple", "min_selections": 2},
         _answer(selected_option_ids=["tech"]), "至少"),
    ],
)
def test_validation_messages_are_actionable(request_overrides, answer, expected_fragment):
    request = {
        "options": OPTIONS, "selection_mode": "single", "allow_skip": True,
        "allow_free_text": True, "min_selections": 0, "max_selections": 1,
        **request_overrides,
    }
    errors = validate_agent_input_answer(request, answer)
    assert errors and any(expected_fragment in item for item in errors)


def test_free_text_counts_as_other_even_when_min_is_not_met():
    request = {
        "options": OPTIONS, "selection_mode": "multiple", "allow_skip": True,
        "allow_free_text": True, "min_selections": 2, "max_selections": 0,
    }
    assert validate_agent_input_answer(request, _answer(free_text="看岗位再定")) == []
