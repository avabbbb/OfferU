import asyncio
import os

import pytest

from app.ops import list_operations
from app.routes.main_agent import skills as skills_route
from app.services import directory_skills
from app.services.agent_skill_registry import (
    _routable_skills,
    catalog,
    registry_snapshot,
    resolve_skill,
)
from app.services.directory_skills import DEFAULT_READONLY_TOOLS, LOCAL_SKILL_DIRS_ENV

NL = chr(10)
READONLY = frozenset(DEFAULT_READONLY_TOOLS)
BODY = "Polish the summary section first."


def _write_skill(root, dirname, frontmatter, body=BODY):
    skill_dir = root / dirname
    skill_dir.mkdir(parents=True)
    text = NL.join(["---", frontmatter, "---", body, ""])
    (skill_dir / "SKILL.md").write_text(text, encoding="utf-8")


def _use_roots(monkeypatch, value):
    monkeypatch.setenv(LOCAL_SKILL_DIRS_ENV, value)
    directory_skills.reload_directory_skills()


def _route_rows():
    return {row["id"]: row for row in asyncio.run(skills_route())["skills"]}


@pytest.fixture(autouse=True)
def _fresh_skill_cache():
    directory_skills.reload_directory_skills()
    yield
    directory_skills.reload_directory_skills()


@pytest.fixture
def local_root(tmp_path, monkeypatch):
    root = tmp_path / "skills"
    root.mkdir()
    _use_roots(monkeypatch, str(root))
    return root


def test_local_skill_listed_with_source_and_readonly_tools(local_root):
    _write_skill(
        local_root,
        "resume-polish",
        NL.join([
            "name: resume-polish",
            "description: Polish resume wording",
            "tools: [get_profile, get_resume, update_profile, delete_resume]",
        ]),
    )
    directory_skills.reload_directory_skills()
    registered = {str(op.get("name")) for op in list_operations()}

    row = _route_rows()["resume_polish"]
    assert row["source"] == "local"
    assert row["group"] == "local"
    assert set(row["allowed_tools"]) == {"get_profile", "get_resume"} & registered
    assert row["confirmation_required_operations"] == []
    assert "instructions" not in row
    assert "resume_polish" not in {item["id"] for item in catalog()}
    assert "resume_polish" not in {skill.id for skill in _routable_skills()}


def test_resolve_skill_keeps_instructions_and_drops_write_tools(local_root):
    _write_skill(
        local_root,
        "resume-polish",
        NL.join(["description: Polish resume wording", "tools: [get_profile, update_profile]"]),
    )
    directory_skills.reload_directory_skills()

    skill = resolve_skill("/resume-polish")
    assert skill is not None
    assert skill.source == "local"
    assert skill.allowed_tools == frozenset({"get_profile"})
    assert skill.instructions == BODY


def test_write_only_declaration_falls_back_to_readonly_defaults(local_root):
    _write_skill(
        local_root,
        "writer",
        NL.join(["description: Writes things", "tools: [update_profile, delete_resume]"]),
    )
    directory_skills.reload_directory_skills()

    skill = resolve_skill("writer")
    assert skill is not None
    assert skill.allowed_tools == READONLY


def test_own_projection_dir_is_skipped(local_root):
    _write_skill(local_root, "offeru", NL.join(["name: projected-copy", "description: OfferU projection"]))
    directory_skills.reload_directory_skills()

    assert resolve_skill("projected_copy") is None
    assert directory_skills.scan_local_skills() == []


def test_builtin_id_collision_is_skipped(local_root):
    _write_skill(local_root, "discovery", "description: Shadow the builtin")
    directory_skills.reload_directory_skills()

    skill = resolve_skill("discovery")
    assert skill is not None
    assert skill.source == ""
    assert directory_skills.scan_local_skills() == []


def test_registry_sha256_ignores_local_skills(tmp_path, monkeypatch):
    operations = list_operations()
    _use_roots(monkeypatch, "")
    baseline = registry_snapshot(operations)

    root = tmp_path / "skills"
    _write_skill(root, "resume-polish", "description: Polish resume wording")
    _use_roots(monkeypatch, str(root))

    assert registry_snapshot(operations) == baseline
    payload = asyncio.run(skills_route())
    assert payload["sha256"] == baseline["sha256"]
    assert payload["skills"][: len(baseline["skills"])] == baseline["skills"]
    assert payload["skills"][-1]["id"] == "resume_polish"


def test_missing_root_is_tolerated(tmp_path, monkeypatch):
    root = tmp_path / "skills"
    _write_skill(root, "resume-polish", "description: Polish resume wording")
    _use_roots(monkeypatch, os.pathsep.join([str(tmp_path / "missing"), str(root)]))

    assert [skill.id for skill in directory_skills.scan_local_skills()] == ["resume_polish"]


def test_empty_env_means_no_roots(monkeypatch):
    _use_roots(monkeypatch, "")

    assert directory_skills.local_skill_roots() == []
    assert directory_skills.scan_local_skills() == []
