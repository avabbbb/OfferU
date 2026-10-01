import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from app.services import resume_export


def test_upload_path_boundary(tmp_path):
    (tmp_path / "photo.png").write_bytes(b"fixture")
    with patch.object(resume_export, "runtime_uploads_dir", return_value=tmp_path):
        assert resume_export.local_resume_image("http://127.0.0.1:8766/uploads/photo.png") == tmp_path / "photo.png"
        for url in ("https://example.com/uploads/photo.png", "http://127.0.0.1:8766/uploads/../outside.png", "http://127.0.0.1:8766/uploads/%2e%2e/outside.png", "http://127.0.0.1:8766/uploads/config.json"):
            assert resume_export.local_resume_image(url) is None


def test_renderer_failure_is_visible_without_degraded_pdf():
    fixture = SimpleNamespace(id=1, user_name="测试", title="简历", photo_url="/uploads/photo.png", summary="", contact_json={}, style_config={}, sections=[])
    with patch.object(resume_export, "render_resume_snapshot_pdf", AsyncMock(side_effect=RuntimeError("image unavailable"))):
        with pytest.raises(RuntimeError, match="未生成降级版本"):
            asyncio.run(resume_export.render_resume_pdf(fixture))


def test_route_and_agent_share_renderer():
    from app.routes.resume import _render_resume_pdf_with_playwright
    fixture = SimpleNamespace(id=1, user_name="测试", title="简历", photo_url="/uploads/photo.png", summary="", contact_json={"schoolLogoUrl": "/uploads/logo.png"}, style_config={"bodySize": "10.5"}, sections=[])
    with patch.object(resume_export, "render_resume_snapshot_pdf", AsyncMock(return_value=b"%PDF-fixture")) as render:
        agent_pdf, renderer = asyncio.run(resume_export.render_resume_pdf(fixture))
        route_pdf = asyncio.run(_render_resume_pdf_with_playwright(1, fixture))
        assert agent_pdf == route_pdf
        assert renderer == "react-preview"
        assert render.call_args.args[0]["photo_url"] == fixture.photo_url
        assert render.call_args.args[0]["contact_json"]["schoolLogoUrl"] == "/uploads/logo.png"


def test_bundled_frontend_paths_are_confined(tmp_path):
    (tmp_path / "index.html").write_text("fixture", encoding="utf-8")
    (tmp_path / "config.json").write_text("{}", encoding="utf-8")
    assert resume_export.local_frontend_asset(tmp_path, "http://127.0.0.1:7410/") == tmp_path / "index.html"
    for url in ("https://example.com/index.html", "http://127.0.0.1:7410/%2e%2e/outside.html",
                "http://127.0.0.1:7410/..%5coutside.html", "http://127.0.0.1:7410/config.json"):
        assert resume_export.local_frontend_asset(tmp_path, url) is None


def test_packaged_export_never_requires_a_live_frontend(tmp_path):
    with patch.object(resume_export, "packaged_resource_dir", return_value=tmp_path), \
         patch.object(resume_export, "resume_frontend_dir", return_value=tmp_path), \
         patch.object(resume_export.httpx, "AsyncClient", side_effect=AssertionError("packaged export must not contact a server")):
        with pytest.raises(RuntimeError, match="缺少简历排版资源"):
            asyncio.run(resume_export.export_frontend_assets())
        (tmp_path / "index.html").write_text("fixture", encoding="utf-8")
        assert asyncio.run(resume_export.export_frontend_assets()) == tmp_path
