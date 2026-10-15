"""粘贴岗位描述原文或链接 → 岗位草稿 → 用户确认后建岗位。"""

from __future__ import annotations

import asyncio
import json

import pytest

from app.ops import OPERATIONS
from app.routes import jobs as jobs_routes
from app.services import job_capture, web_search


@pytest.fixture(autouse=True)
def _no_model(monkeypatch):
    """默认没有可用模型，走规则兜底；LLM 用例单独打桩。"""
    from app.agents import llm

    async def unavailable(*_args, **_kwargs):
        return None

    monkeypatch.setattr(llm, "chat_completion", unavailable)


def _model_returns(monkeypatch, payload: dict):
    from app.agents import llm

    seen: list[list[dict]] = []

    async def fake(messages, **_kwargs):
        seen.append(messages)
        return json.dumps(payload, ensure_ascii=False)

    monkeypatch.setattr(llm, "chat_completion", fake)
    return seen


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
    assert "llm" in op.side_effects
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


def test_model_fields_must_be_verbatim_from_source(monkeypatch):
    _model_returns(
        monkeypatch,
        {"title": "推荐系统后端", "company": "字节跳动", "location": "", "description_start": "", "description_end": ""},
    )
    text = "我们在招推荐系统后端，团队在示例科技。\n" + JD_BODY
    result = asyncio.run(job_capture.draft_job_posting(text))
    assert result["extractor"] == "llm"
    assert result["draft"]["title"] == "推荐系统后端"
    # 原文里没有「字节跳动」，模型编的公司名必须丢掉，交给用户填。
    assert result["draft"]["company"] == ""
    assert "company" in result["missing"]
    # 用户自己粘贴的原文整段保留，不被模型裁剪。
    assert result["draft"]["jd_text"] == text


def test_page_body_is_sliced_from_original_by_anchors(monkeypatch):
    noise_before = "首页 职位 登录 注册\n热门推荐：前端 / 测试 / 运维\n"
    noise_after = "\n相似岗位：Java 开发 / 数据开发\n版权所有"
    html = f"<html><head><title>后端开发 - 示例科技招聘</title></head><body><main>{noise_before}{JD_BODY}{noise_after}</main></body></html>"

    async def fake_fetch(url, **_kwargs):
        return url, html

    monkeypatch.setattr(web_search, "fetch_public_html", fake_fetch)
    _model_returns(
        monkeypatch,
        {
            "title": "后端开发",
            "company": "示例科技",
            "location": "",
            "description_start": "岗位职责：",
            "description_end": "有大型项目实习经验优先。",
        },
    )
    result = asyncio.run(job_capture.draft_job_posting("https://jobs.example.com/be"))
    assert result["extractor"] == "llm"
    assert result["draft"]["title"] == "后端开发"
    assert result["draft"]["company"] == "示例科技"
    body = result["draft"]["jd_text"]
    assert body.startswith("岗位职责：") and body.endswith("有大型项目实习经验优先。")
    assert "热门推荐" not in body and "相似岗位" not in body


def test_rewritten_anchors_fall_back_to_full_page(monkeypatch):
    html = f"<html><body><main>{JD_BODY}</main></body></html>"

    async def fake_fetch(url, **_kwargs):
        return url, html

    monkeypatch.setattr(web_search, "fetch_public_html", fake_fetch)
    _model_returns(
        monkeypatch,
        {"title": "", "company": "", "location": "", "description_start": "负责设计开发推荐后端", "description_end": ""},
    )
    result = asyncio.run(job_capture.draft_job_posting("https://jobs.example.com/x"))
    assert "岗位职责" in result["draft"]["jd_text"]
    assert "任职要求" in result["draft"]["jd_text"]


def test_model_failure_falls_back_to_rules(monkeypatch):
    from app.agents import llm

    async def boom(*_args, **_kwargs):
        raise RuntimeError("provider down")

    monkeypatch.setattr(llm, "chat_completion", boom)
    text = f"职位：后端开发实习生\n公司：示例科技\n{JD_BODY}"
    result = asyncio.run(job_capture.draft_job_posting(text))
    assert result["extractor"] == "rules"
    assert result["draft"]["company"] == "示例科技"


def test_structured_posting_is_cross_checked_by_the_model(monkeypatch):
    async def fake_fetch(url, **_kwargs):
        return url, _job_posting_html()

    monkeypatch.setattr(web_search, "fetch_public_html", fake_fetch)
    seen = _model_returns(
        monkeypatch,
        {"title": "Frontend Engineer", "company": "", "location": "", "description_start": "", "description_end": ""},
    )
    result = asyncio.run(job_capture.draft_job_posting("https://careers.example.com/j/7"))
    assert len(seen) == 1
    assert result["extractor"] == "structured+llm"
    assert result["conflicts"] == []
    assert result["draft"]["company"] == "Example Inc"


def test_structured_and_model_disagreement_is_surfaced(monkeypatch):
    async def fake_fetch(url, **_kwargs):
        return url, _job_posting_html()

    monkeypatch.setattr(web_search, "fetch_public_html", fake_fetch)
    # 模型给出的标题必须出现在原文或提示里才会被采纳；这里用原文里存在的词。
    _model_returns(
        monkeypatch,
        {"title": "hiring teams", "company": "", "location": "", "description_start": "", "description_end": ""},
    )
    result = asyncio.run(job_capture.draft_job_posting("https://careers.example.com/j/7"))
    assert result["draft"]["title"] == "Frontend Engineer"
    assert result["conflicts"] == [{"field": "title", "structured": "Frontend Engineer", "llm": "hiring teams"}]
    assert "不一致" in result["message"]
