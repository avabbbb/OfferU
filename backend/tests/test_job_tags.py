"""岗位标签：job.tags 存在岗位上，list 按 tag 过滤，格式不对直接报错，改动能撤销。"""


def test_job_tags_over_http(tmp_path, monkeypatch):
    monkeypatch.setenv("OFFERU_DATA_DIR", str(tmp_path))
    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app, base_url="http:" + "//" + "127.0.0.1:8766") as client:
        def tool(name, args):
            return client.post("/api/tools/" + name, json=args)

        a = tool("save", {"type": "job", "data": {"company": "飞书", "title": "产品实习", "tags": ["大厂", "内推"]}}).json()["record"]
        tool("save", {"type": "job", "data": {"company": "米哈游", "title": "策划", "tags": ["游戏"]}})
        assert a["tags"] == ["大厂", "内推"]
        assert [j["id"] for j in tool("list", {"type": "job", "tag": "内推"}).json()["items"]] == [a["id"]]

        for bad in ("内推", [" 内推"], ["a", "a"], [""], ["abcdefghijklmnopqrstu"], [1]):
            assert tool("save", {"type": "job", "id": a["id"], "data": {"tags": bad}}).status_code == 400, bad

        changed = tool("save", {"type": "job", "id": a["id"], "data": {"tags": ["大厂"]}}).json()
        tool("undo", {"change_id": changed["change_id"]})
        assert tool("get", {"type": "job", "id": a["id"]}).json()["record"]["tags"] == ["大厂", "内推"]
        assert "tags" not in tool("save", {"type": "job", "id": a["id"], "data": {"tags": None}}).json()["record"]


def test_auto_tags_survive_user_edits(tmp_path, monkeypatch):
    """add_job 自动打 类型/城市/方向/公司属性；用户删掉的 Agent 标签记进 tags_muted，重拆 JD 不再加回，手打的保留。"""
    monkeypatch.setenv("OFFERU_DATA_DIR", str(tmp_path))
    from app.core import job_intake, store, tools

    async def extract(text, known=None):
        return {"company": "字节跳动", "title": "产品经理实习", "city": "北京市",
                "posting": {"hire_type": "实习"}, "tags": ["产品", "大厂"]}

    monkeypatch.setattr(job_intake, "available", lambda: True)
    monkeypatch.setattr(job_intake, "extract", extract)
    monkeypatch.setattr(tools, "_is_job_name", lambda text: False)
    text = "字节跳动 产品经理实习 北京\n岗位职责：\n1. 负责产品需求分析和竞品调研\n任职要求：本科及以上，每周实习 4 天"
    job = tools.add_job(text, actor="你")["record"]
    assert job["tags"] == ["实习", "北京", "产品", "大厂"]
    assert job["auto_tags"] == ["实习", "北京", "产品", "大厂"]

    # 前端删「大厂」、手打「内推」时写的就是这三项
    tools.call("save", {"type": "job", "id": job["id"], "data": {
        "tags": ["实习", "北京", "产品", "内推"], "auto_tags": ["实习", "北京", "产品"], "tags_muted": ["大厂"]}}, actor="你")
    tools.enrich_jobs(redo=True, actor="你")
    got = store.get("job", job["id"])
    assert got["tags"] == ["内推", "实习", "北京", "产品"]
    assert got["auto_tags"] == ["实习", "北京", "产品"]
    assert got["tags_muted"] == ["大厂"]

    for bad in ("大厂", [""], [1]):
        try:
            tools.call("save", {"type": "job", "id": job["id"], "data": {"tags_muted": bad}}, actor="你")
        except ValueError:
            continue
        raise AssertionError(bad)
