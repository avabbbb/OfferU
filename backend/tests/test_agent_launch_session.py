import asyncio

import pytest

from app.services import agent_connection as c
from app.services import agent_launch

CID = "0123456789abcdef0123456789abcdef"


class _Adapter:
    def __init__(self, status):
        self.status = status

    def inspect(self):
        return {"skill_status": self.status, "expected_skill_hash": "h"}


@pytest.fixture
def wired(monkeypatch, tmp_path):
    calls = {"probe": 0, "install": [], "launch": [], "recorded": []}

    async def probe(provider_id):
        calls["probe"] += 1
        c._CHECKS[provider_id] = {"challenge_id": CID, "executable": "/bin/codex", "error": "armed"}
        return {}

    async def connect(provider_id, action):
        calls["install"].append(action)
        return await probe(provider_id)

    async def record(provider_id, check):
        calls["recorded"].append(dict(check))

    async def snapshot():
        return {"providers": []}

    def launch(provider_id, executable, prompt, cwd, **_kw):
        calls["launch"].append((provider_id, executable, prompt))
        return {"launched": True, "command": "codex ...", "error": ""}

    monkeypatch.setattr(c, "probe_agent_connection", probe)
    monkeypatch.setattr(c, "connect_agent_integration", connect)
    monkeypatch.setattr(c, "record_connection_check", record)
    monkeypatch.setattr(c, "get_agent_connections", snapshot)
    monkeypatch.setattr(agent_launch, "launch", launch)
    monkeypatch.setattr("app.runtime_paths.runtime_data_path", lambda *_a: tmp_path)
    c._CHECKS.clear()
    return calls


def _set_status(monkeypatch, status):
    monkeypatch.setattr(c.integration_manager, "adapter", lambda _pid: _Adapter(status))


def test_installed_skill_probes_then_launches_with_fresh_challenge(monkeypatch, wired):
    _set_status(monkeypatch, "INSTALLED")
    out = asyncio.run(c.launch_agent_session("codex"))
    assert wired["probe"] == 1 and wired["install"] == []
    (pid, exe, prompt), = wired["launch"]
    assert (pid, exe) == ("codex", "/bin/codex") and CID in prompt
    assert out["launch"]["launched"] is True
    assert wired["recorded"][-1]["challenge_id"] == CID


@pytest.mark.parametrize("status, action", [("OUTDATED", "update"), ("NOT_INSTALLED", "install")])
def test_missing_or_outdated_skill_installs_first(monkeypatch, wired, status, action):
    _set_status(monkeypatch, status)
    asyncio.run(c.launch_agent_session("codex"))
    assert wired["install"] == [action] and len(wired["launch"]) == 1


def test_unsupported_provider_is_rejected_before_any_side_effect(monkeypatch, wired):
    _set_status(monkeypatch, "INSTALLED")
    with pytest.raises(ValueError):
        asyncio.run(c.launch_agent_session("external"))
    assert wired["probe"] == 0 and wired["launch"] == []


def test_launch_does_not_overwrite_a_newer_challenge(monkeypatch, wired):
    _set_status(monkeypatch, "INSTALLED")

    def launch(provider_id, executable, prompt, cwd, **_kw):
        c._CHECKS[provider_id] = {"challenge_id": "f" * 32}  # user re-probed meanwhile
        return {"launched": False, "command": "codex ...", "error": "no terminal"}

    monkeypatch.setattr(agent_launch, "launch", launch)
    out = asyncio.run(c.launch_agent_session("codex"))
    assert out["launch"]["error"] == "no terminal"
    assert wired["recorded"] == [] and c._CHECKS["codex"]["challenge_id"] == "f" * 32
