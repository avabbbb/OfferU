"""真模型冒烟里发现的问题：邮件标题格式、无模型兜底、401 被吞。"""

import pytest

from app.agents.llm import LLMAuthError, _raise_if_auth
from app.core import job_intake
from app.core.tools import mail_subject

P = {"name": "张三", "school": "华东师范大学", "major": "软件工程", "grad_year": 2027}
J = {"title": "AI 产品实习生", "city": "上海"}


def test_subject_follows_jd_format_and_marks_missing():
    s, todo = mail_subject("简历请发送至 a@b.com，邮件标题：姓名-学校-岗位-到岗时间，附件为 PDF", P, J)
    assert s == "张三-华东师范大学-AI 产品实习生-[到岗时间]"
    assert todo == ["到岗时间"]


def test_subject_other_separators_and_fields():
    s, todo = mail_subject("邮件主题请注明「学校+专业+届别+姓名」", P, J)
    assert s == "华东师范大学+软件工程+2027届+张三"
    assert todo == []


def test_subject_profile_field_fills_custom_token():
    s, todo = mail_subject("邮件标题格式：姓名-到岗时间", {**P, "到岗时间": "11月中"}, J)
    assert (s, todo) == ("张三-11月中", [])


def test_subject_default_without_format():
    assert mail_subject("简历请发送至 a@b.com", P, J) == ("张三-华东师范大学-AI 产品实习生", [])


def test_guess_title_and_deadline():
    out = job_intake.guess("字节跳动 · AI 产品实习生 · 上海\n截止时间：2026年11月30日")
    assert out["title"] == "AI 产品实习生"
    assert out["deadline"] == "2026-11-30"
    one_line = job_intake.guess("AI 产品实习生，上海。熟悉 LLM 应用。简历请发送至 hr@example.com")
    assert one_line["title"] == "AI 产品实习生"
    assert "deadline" not in one_line


def _HttpError(status: int) -> Exception:
    exc = Exception("boom")
    exc.status_code = status  # type: ignore[attr-defined]
    return exc


def test_auth_errors_raise_instead_of_none():
    with pytest.raises(LLMAuthError, match="401"):
        _raise_if_auth(_HttpError(401), "deepseek", "hark")
    with pytest.raises(LLMAuthError, match="403"):
        _raise_if_auth(_HttpError(403), "deepseek", "hark")
    _raise_if_auth(_HttpError(500), "deepseek", "hark")  # 其他错误照旧走原来的重试 / 日志
