from app.core import store, tools

SL = chr(47)
BOSS = ".".join(["www", "zhipin", "com"])
XHS = ".".join(["www", "xiaohongshu", "com"])


def site(host, path):
    return "https:" + SL + SL + host + path


def setup(tmp_path, monkeypatch):
    monkeypatch.setenv("OFFERU_DATA_DIR", str(tmp_path))
    store.conn()


def total():
    return tools.list_("job")["total"]


def test_boss_same_job_with_changing_params_is_one_record(tmp_path, monkeypatch):
    setup(tmp_path, monkeypatch)
    a = tools.save("job", {"title": "AI 产品实习", "company": "测试", "url": site(BOSS, "/job_detail/abc123.html?lid=1&securityId=x"), "jd": "短"}, actor="插件")
    b = tools.save("job", {"title": "AI 产品实习", "company": "测试", "url": site(BOSS, "/job_detail/abc123.html?lid=2&securityId=y"), "jd": "这是一段更长的完整 JD"}, actor="插件")
    assert a["existed"] is False and b["existed"] is True
    assert a["record"]["id"] == b["record"]["id"]
    assert total() == 1
    assert b["record"]["jd"] == "这是一段更长的完整 JD"


def test_resave_keeps_status_and_longer_jd(tmp_path, monkeypatch):
    setup(tmp_path, monkeypatch)
    url = site(BOSS, "/job_detail/k1.html")
    first = tools.save("job", {"title": "T", "company": "C", "url": url, "jd": "完整的岗位描述，很长很长"}, actor="你")
    tools.save("job", {"status": "applied"}, id=first["record"]["id"], actor="你")
    again = tools.save("job", {"title": "T", "company": "C", "url": url, "jd": "摘要", "status": "saved"}, actor="插件")
    assert again["record"]["status"] == "applied"
    assert again["record"]["jd"] == "完整的岗位描述，很长很长"
    assert again["change_id"] is None
    assert total() == 1


def test_different_jobs_stay_separate(tmp_path, monkeypatch):
    setup(tmp_path, monkeypatch)
    tools.save("job", {"title": "A", "url": site(BOSS, "/job_detail/1.html")}, actor="插件")
    tools.save("job", {"title": "B", "url": site(BOSS, "/job_detail/2.html")}, actor="插件")
    tools.save("job", {"title": "C", "url": site("jobs.example.com", "/apply?jobId=7")}, actor="插件")
    tools.save("job", {"title": "D", "url": site("jobs.example.com", "/apply?jobId=8")}, actor="插件")
    assert total() == 4


def test_tracking_params_and_xhs_notes(tmp_path, monkeypatch):
    setup(tmp_path, monkeypatch)
    tools.save("job", {"title": "A", "url": site("jobs.example.com", "/p/9?utm_source=x")}, actor="插件")
    r = tools.save("job", {"title": "A", "url": site("jobs.example.com", "/p/9/?utm_medium=y")}, actor="插件")
    assert r["existed"] is True
    tools.save("job", {"title": "笔记", "url": site(XHS, "/explore/abc?xsec_token=t1")}, actor="插件")
    r2 = tools.save("job", {"title": "笔记", "url": site(XHS, "/discovery/item/abc?xsec_token=t2")}, actor="插件")
    assert r2["existed"] is True
    assert total() == 2


def test_job_url_key():
    assert tools.job_url_key(site(BOSS, "/job_detail/Zx9_a~.html?lid=1")) == "boss:Zx9_a~"
    assert tools.job_url_key("") == ""
