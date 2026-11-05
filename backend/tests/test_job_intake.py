from app.core import job_intake

TEXT = ("百度搭子 AI产品营销经理（J102408）北京\n岗位职责：\n1. 负责 Agent 产品 GTM\n"
        "任职要求：本科及以上，3 年以上 To B 营销经验，熟悉 LLM")


def test_posting_keeps_only_source_facts():
    parsed = {
        "company": "百度", "title": "AI产品营销经理", "city": "北京", "jd": TEXT,
        "team": "百度搭子", "hire_type": "社招", "years": "3 年以上", "education": "本科及以上",
        "job_code": "J102408", "posted_at": "2026-10-30",
        "responsibilities": ["1. 负责 Agent 产品 GTM", "负责 Agent 产品 GTM", ""],
        "hard_reqs": ["- 3 年以上 To B 营销经验"],
        "keywords": ["LLM", "GTM", "区块链"],
        "essence": "给百度搭子做企业侧上市和增长",
    }
    out = job_intake.normalize(parsed, TEXT)
    assert (out["company"], out["title"], out["city"]) == ("百度", "AI产品营销经理", "北京")
    p = out["posting"]
    assert p["responsibilities"] == ["负责 Agent 产品 GTM"]
    assert p["hard_reqs"] == ["3 年以上 To B 营销经验"]
    assert p["keywords"] == ["LLM", "GTM"]
    assert (p["hire_type"], p["job_code"], p["posted_at"], p["team"]) == ("社招", "J102408", "2026-10-30", "百度搭子")


def test_posting_drops_out_of_range_values():
    parsed = {"title": "产品经理", "hire_type": "全职", "posted_at": "上周", "job_code": "J999",
              "keywords": "LLM", "responsibilities": None, "deadline": "尽快"}
    assert job_intake.normalize(parsed, "产品经理 负责需求") == {"title": "产品经理"}


def test_posting_keeps_years_like_lines():
    """行首是数字的要求（「3 年以上…」）不能被当成序号削掉。"""
    out = job_intake.normalize({"title": "x", "hard_reqs": ["3 年以上经验", "2、本科"]})
    assert out["posting"]["hard_reqs"] == ["3 年以上经验", "本科"]


def test_enrich_jobs_fills_posting_only(tmp_path, monkeypatch):
    """插件存的岗位补 posting：只补空字段，不覆盖公司、不动状态；没 JD 的跳过；补过的不重拆。"""
    monkeypatch.setenv("OFFERU_DATA_DIR", str(tmp_path))
    from app.core import store, tools

    async def extract(text):
        assert "GTM" in text
        return {"company": "别的公司", "city": "北京", "posting": {"keywords": ["GTM"], "hire_type": "社招"}}

    monkeypatch.setattr(job_intake, "available", lambda: True)
    monkeypatch.setattr(job_intake, "extract", extract)
    job = tools.call("save", {"type": "job", "data": {"company": "百度", "title": "AI产品营销经理", "jd": "负责 Agent 产品 GTM"}}, actor="插件")["record"]
    tools.call("save", {"type": "job", "data": {"title": "没有 JD"}}, actor="你")
    out = tools.enrich_jobs(actor="你")
    assert out["count"] == 1 and len(out["change_ids"]) == 1
    got = store.get("job", job["id"])
    assert (got["company"], got["city"], got["status"]) == ("百度", "北京", "saved")
    assert got["posting"] == {"keywords": ["GTM"], "hire_type": "社招"}
    assert tools.enrich_jobs(actor="你")["count"] == 0
