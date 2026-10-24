"""设置页「扫码登录」的接口存在，并转到对应的 boss_login 操作。"""

from fastapi.testclient import TestClient


def test_boss_login_routes_forward_to_operations(monkeypatch):
    import app.main as main
    import app.routes.main_agent as main_agent

    calls = []

    async def fake_execute(name, args, **kwargs):
        calls.append(name)
        return {"ok": True, "outputs": {"status": "idle", "op": name}}

    monkeypatch.setattr(main_agent, "execute_operation", fake_execute)
    client = TestClient(main.app, base_url="http://127.0.0.1:8766")

    got = client.get("/api/applications/boss-login")
    assert got.status_code == 200, got.text
    assert got.json()["op"] == "get_boss_login"

    for action, op in (("start", "start_boss_login"), ("cancel", "cancel_boss_login"), ("logout", "logout_boss")):
        res = client.post(f"/api/applications/boss-login/{action}")
        assert res.status_code == 200, res.text
        assert res.json()["op"] == op

    assert client.post("/api/applications/boss-login/hack").status_code == 422
    assert calls == ["get_boss_login", "start_boss_login", "cancel_boss_login", "logout_boss"]
