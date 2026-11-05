"""posting 接进评估和改简历：有拆条用拆条，没有照旧用 JD 原文。"""

import pytest

JOB = {"id": 1, "type": "job", "company": "百度", "title": "AI产品营销经理", "jd": "负责 Agent 产品 GTM" + "。" * 5000,
       "posting": {"hire_type": "社招", "hard_reqs": ["3 年以上产品营销经验"], "keywords": ["GTM", "Agent"],
                   "essence": "AI 产品 GTM"}}
BARE = dict(JOB, posting={})


@pytest.fixture(autouse=True)
def data_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("OFFERU_DATA_DIR", str(tmp_path))


def test_job_text_prefers_posting():
    from app.core import job_eval

    text = job_eval.job_text(JOB)
    assert "招聘类型：社招" in text
    assert "硬性要求：\n1. 3 年以上产品营销经验" in text
    assert "关键词：GTM、Agent" in text
    assert "推断" in text
    assert len(text) < 2500


def test_job_text_falls_back_to_jd():
    from app.core import job_eval

    text = job_eval.job_text(BARE)
    assert "关键词" not in text and "推断" not in text
    assert text.count("。") == 3000 - len("负责 Agent 产品 GTM")


def test_tailor_jd_uses_posting():
    from app.core import tailor

    assert "### 拆好的要求和关键词" in tailor._jd(JOB)
    assert "拆好的" not in tailor._jd(BARE)
