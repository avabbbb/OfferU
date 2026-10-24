"""offeru start from a source checkout must serve frontend/dist, with JS served as JavaScript."""

import mimetypes

from fastapi.testclient import TestClient


def test_source_checkout_falls_back_to_frontend_dist():
    from app.runtime_paths import packaged_resource_dir, resume_frontend_dir

    if packaged_resource_dir() is None:
        assert resume_frontend_dir().parts[-2:] == ("frontend", "dist")


def test_workbench_mount_serves_index_and_js_mime(tmp_path, monkeypatch):
    web = tmp_path / "dist"
    (web / "assets").mkdir(parents=True)
    (web / "index.html").write_text('<script type="module" src="./assets/app.js"></script>', encoding="utf-8")
    (web / "assets" / "app.js").write_text("export {};", encoding="utf-8")
    # What a Windows registry often says; browsers then refuse to run module scripts.
    mimetypes.add_type("text/plain", ".js")

    import app.main as main

    monkeypatch.setenv("OFFERU_RUNTIME_MODE", "lite")
    monkeypatch.setattr("app.runtime_paths.resume_frontend_dir", lambda: web)
    routes = list(main.app.router.routes)
    try:
        main._mount_workbench()
        client = TestClient(main.app)
        root = client.get("/")
        assert root.status_code == 200 and "app.js" in root.text
        js = client.get("/assets/app.js")
        assert js.status_code == 200 and js.headers["content-type"].startswith("text/javascript")
    finally:
        main.app.router.routes[:] = routes
