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
