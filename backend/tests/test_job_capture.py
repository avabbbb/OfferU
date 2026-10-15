"""粘贴岗位描述原文或链接 → 岗位草稿 → 用户确认后建岗位。"""

from __future__ import annotations

import asyncio
import json

import pytest

from app.ops import OPERATIONS
from app.routes import jobs as jobs_routes
from app.services import job_capture, web_search


JD_BODY = (
    "岗位职责：\n1. 负责推荐系统后端服务的设计与开发；\n2. 优化线上服务性能与稳定性；\n"
    "任职要求：\n1. 熟悉 Python/Go，至少一门；\n2. 了解分布式系统与缓存；\n3. 有大型项目实习经验优先。"
)


def test_labelled_paste_extracts_title_company_location():
    text = f"职位名称：后端开发实习生\n公司：示例科技\n工作地点：上海\n{JD_BODY}"
    result = asyncio.run(job_capture.draft_job_posting(text))
    assert result["status"] == "ready"
    assert result["source_kind"] == "text"
    assert result["draft"]["title"] == "后端开发实习生"
    assert result["draft"]["company"] == "示例科技"
    assert result["draft"]["location"] == "上海"
    assert result["draft"]["jd_text"].startswith("职位名称")
    assert result["missing"] == []


def test_heading_line_splits_company_and_role():
    fields = job_capture.extract_job_fields_from_text(f"示例科技 - 后端开发工程师\n{JD_BODY}")
    assert fields["company"] == "示例科技"
    assert fields["title"] == "后端开发工程师"


def test_heading_line_splits_space_separated_company_and_role():
    fields = job_capture.extract_job_fields_from_text(f"字节跳动 后端开发实习生（抖音电商）\n{JD_BODY}")
    assert fields["company"] == "字节跳动"
    assert fields["title"] == "后端开发实习生（抖音电商）"


def test_unlabelled_paste_is_incomplete_not_guessed():
    result = asyncio.run(job_capture.draft_job_posting(JD_BODY))
    assert result["status"] == "incomplete"
    assert "company" in result["missing"]
    assert result["draft"]["company"] == ""


def test_paste_with_link_keeps_link_but_never_fetches(monkeypatch):
    async def explode(*_args, **_kwargs):  # pragma: no cover - must not run
        raise AssertionError("pasted text must not trigger a fetch")

    monkeypatch.setattr(web_search, "fetch_public_html", explode)
    text = f"职位：数据分析师\n公司：示例\nhttps://jobs.example.com/123\n{JD_BODY}"
    result = asyncio.run(job_capture.draft_job_posting(text))
    assert result["draft"]["url"] == "https://jobs.example.com/123"
    assert result["source_kind"] == "text"


@pytest.mark.parametrize(
    "url",
    [
        "https://www.zhipin.com/job_detail/abc.html",
        "https://www.xiaohongshu.com/explore/1",
        "https://www.linkedin.com/jobs/view/1",
        "https://www.liepin.com/job/1.shtml",
    ],
)
def test_login_walled_sites_ask_for_text_without_any_request(monkeypatch, url):
    async def no_network(*_args, **_kwargs):  # pragma: no cover - must not run
        raise AssertionError("restricted sites must be refused before DNS/HTTP")

    monkeypatch.setattr(web_search, "_assert_public_destination", no_network)
    result = asyncio.run(job_capture.draft_job_posting(url))
    assert result["status"] == "needs_text"
    assert result["draft"]["url"] == url
    assert "不会替你抓取" in result["message"]


def test_private_or_unreachable_links_ask_for_text():
    result = asyncio.run(job_capture.draft_job_posting("http://127.0.0.1:8766/jobs/1"))
    assert result["status"] == "needs_text"


def _job_posting_html() -> str:
    payload = {
        "@context": "https://schema.org",
        "@graph": [
            {"@type": "WebSite", "name": "Example"},
            {
                "@type": "JobPosting",
                "title": "Frontend Engineer",
                "hiringOrganization": {"@type": "Organization", "name": "Example Inc"},
                "jobLocation": {"@type": "Place", "address": {"addressLocality": "Shenzhen", "addressCountry": "CN"}},
                "description": "<p>" + "Build React and TypeScript interfaces for hiring teams. " * 3 + "</p>",
            },
        ],
    }
    return (
        "<html><head><title>Careers</title>"
        f"<script type=\"application/ld+json\">{json.dumps(payload)}</script>"
        "</head><body><nav>menu</nav></body></html>"
    )


def test_public_link_uses_schema_org_job_posting(monkeypatch):
    async def fake_fetch(url, **kwargs):
        assert kwargs["extra_restricted_domains"] == job_capture.CAPTURE_PASTE_ONLY_DOMAINS
        return "https://careers.example.com/jobs/7", _job_posting_html()

    monkeypatch.setattr(web_search, "fetch_public_html", fake_fetch)
    result = asyncio.run(job_capture.draft_job_posting("https://careers.example.com/j/7"))
    assert result["status"] == "ready"
    assert result["source_kind"] == "structured"
    draft = result["draft"]
    assert draft["title"] == "Frontend Engineer"
    assert draft["company"] == "Example Inc"
    assert draft["location"] == "Shenzhen, CN"
    assert draft["url"] == "https://careers.example.com/jobs/7"
    assert "<p>" not in draft["jd_text"]


def test_script_rendered_page_asks_for_text(monkeypatch):
    async def fake_fetch(url, **_kwargs):
        return url, "<html><head><title>Loading</title></head><body><div id=root></div></body></html>"

    monkeypatch.setattr(web_search, "fetch_public_html", fake_fetch)
    result = asyncio.run(job_capture.draft_job_posting("https://spa.example.com/job/1"))
    assert result["status"] == "needs_text"


def test_whole_page_fallback_warns_user_to_trim(monkeypatch):
    html = f"<html><head><meta property='og:title' content='产品经理'><meta property='og:site_name' content='示例公司招聘'></head><body><main>{JD_BODY}</main></body></html>"

    async def fake_fetch(url, **_kwargs):
        return url, html

    monkeypatch.setattr(web_search, "fetch_public_html", fake_fetch)
    result = asyncio.run(job_capture.draft_job_posting("https://jobs.example.com/pm"))
    assert result["source_kind"] == "page"
    assert result["draft"]["title"] == "产品经理"
    assert result["draft"]["company"] == "示例公司招聘"
    assert "删掉多余部分" in result["message"]


def test_draft_operation_is_registered_read_only_external():
    op = OPERATIONS["draft_job_posting"]
    assert "write" not in op.side_effects
    assert "external" in op.side_effects
    assert op.input_model is not None


def test_capture_route_creates_through_import_jd(monkeypatch):
    calls: list[tuple[str, dict]] = []

    async def fake_execute(name, args, **_kwargs):
        calls.append((name, args))
        return {"ok": True, "outputs": {"id": 42, "duplicate": False}}

    monkeypatch.setattr(jobs_routes, "execute_operation", fake_execute)
    response = asyncio.run(
        jobs_routes.create_job_capture(
            jobs_routes.JobCaptureCreateRequest(
                title="后端开发实习生",
                company="示例科技",
                jd_text=JD_BODY,
                url="https://jobs.example.com/1",
            )
        )
    )
    assert response == {"job_id": 42, "duplicate": False}
    name, args = calls[0]
    assert name == "import_jd"
    assert args["source"] == "user_paste"
    assert args["url"] == "https://jobs.example.com/1"


def test_fetch_readable_keeps_restricted_guidance():
    with pytest.raises(ValueError, match="authorized_research"):
        asyncio.run(web_search.fetch_readable("https://www.zhipin.com/job_detail/1"))
