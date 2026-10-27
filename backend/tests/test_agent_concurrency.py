def test_settings_api_controls_agent_concurrency(tmp_path, monkeypatch):
    monkeypatch.setenv("OFFERU_DATA_DIR", str(tmp_path))
    from fastapi.testclient import TestClient

    from app.config import get_settings
    from app.main import app

    with TestClient(app, base_url="http" + "://127.0.0.1:8766") as client:
        assert client.get("/api/config/").json()["max_concurrent_agent_runs"] == 3

        saved = client.put("/api/config/", json={"max_concurrent_agent_runs": 5})
        assert saved.status_code == 200
        assert client.get("/api/config/").json()["max_concurrent_agent_runs"] == 5
        assert get_settings().max_concurrent_agent_runs == 5

        for bad in (0, 11):
            rejected = client.put("/api/config/", json={"max_concurrent_agent_runs": bad})
            assert rejected.status_code == 422
        assert client.get("/api/config/").json()["max_concurrent_agent_runs"] == 5

        probe = client.get("/api/agent-runtime/status")
        if probe.status_code == 200:
            assert "5" in probe.text
