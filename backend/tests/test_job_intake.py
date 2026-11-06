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

    async def extract(text, known=None):
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


def test_posting_evidence_and_collaborators():
    """evidence 只留指向保留下来的 hard_reqs 的条目，按 hard_reqs 顺序、每条一条；collaborators 去重去空。"""
    parsed = {
        "title": "x",
        "hard_reqs": ["1. 3 年以上 To B 营销经验", "本科及以上"],
        "evidence": [
            {"req": "本科及以上", "need": "学历证明"},
            {"req": "- 3 年以上 To B 营销经验", "need": "一段完整的 To B 产品上市项目"},
            {"req": "3 年以上 To B 营销经验", "need": "重复的只留第一条"},
            {"req": "熟悉区块链", "need": "不在 hard_reqs 里，丢掉"},
            {"req": "本科及以上", "need": ""},
            "不是字典",
        ],
        "collaborators": ["产品经理", "产品经理", "销售团队", ""],
    }
    p = job_intake.normalize(parsed)["posting"]
    assert p["evidence"] == [
        {"req": "3 年以上 To B 营销经验", "need": "一段完整的 To B 产品上市项目"},
        {"req": "本科及以上", "need": "学历证明"},
    ]
    assert p["collaborators"] == ["产品经理", "销售团队"]


def test_posting_evidence_needs_hard_reqs():
    out = job_intake.normalize({"title": "x", "evidence": [{"req": "a", "need": "b"}]})
    assert "posting" not in out


def test_normalize_tags_and_auto_tags():
    out = job_intake.normalize({"title": "产品实习", "city": "北京市、上海", "hire_type": "实习",
                                "tags": ["#产品", "产品", "大厂", "  ", "一个特别特别长的标签名字"]})
    assert out["tags"] == ["产品", "大厂", "一个特别特别长的"]
    assert job_intake.auto_tags(out) == ["实习", "北京", "产品", "大厂", "一个特别特别长的"]
    assert job_intake.auto_tags({"city": "Remote / 远程办公地点很长"}, "x.com/campus/intern/1") == ["实习", "Remote"]


def test_merge_auto_tags_keeps_user_and_muted():
    from app.core.tools import merge_auto_tags

    assert merge_auto_tags(None, ["实习", "北京"]) == {"tags": ["实习", "北京"], "auto_tags": ["实习", "北京"]}
    prev = {"tags": ["内推", "实习", "北京"], "auto_tags": ["实习", "北京"], "tags_muted": ["大厂"]}
    assert merge_auto_tags(prev, ["实习", "上海", "大厂", "内推"]) == {"tags": ["内推", "实习", "上海"], "auto_tags": ["实习", "上海"]}
    assert merge_auto_tags({"tags": ["内推"]}, []) == {"tags": ["内推"], "auto_tags": None}
