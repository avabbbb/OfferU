"""Static showcase bridge: a browser origin still needs the loopback pairing token."""

from fastapi.testclient import TestClient


def test_showcase_bridge_requires_pairing_token(tmp_path, monkeypatch):
    monkeypatch.setenv("OFFERU_DATA_DIR", str(tmp_path))
    from app.main import app

    with TestClient(app, base_url="http://127.0.0.1:8766") as client:
        token = client.get("/api/pairing").json()["token"]
        assert len(token) >= 24
        origin = {"Origin": "https://offeru.avabbbb.com"}

        denied = client.post("/api/tools/overview", json={}, headers=origin)
        assert denied.status_code == 403

        allowed = client.post(
            "/api/tools/overview",
            json={},
            headers={**origin, "X-OfferU-Pairing": token},
        )
        assert allowed.status_code == 200
        assert allowed.headers["access-control-allow-origin"] == "https://offeru.avabbbb.com"

        preflight = client.options(
            "/api/tools/overview",
            headers={
                **origin,
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type,x-offeru-pairing",
                "Access-Control-Request-Private-Network": "true",
            },
        )
        assert preflight.status_code == 200
        assert preflight.headers["access-control-allow-private-network"] == "true"
