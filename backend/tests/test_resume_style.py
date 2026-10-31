"""排版存在 doc.style：未知键、越界直接报错（不静默夹取）；预览接口和 PDF 同一个渲染函数，块带 data-line，排版变成 CSS 变量。"""


def test_resume_style_and_render(tmp_path, monkeypatch):
    monkeypatch.setenv("OFFERU_DATA_DIR", str(tmp_path))
    from fastapi.testclient import TestClient

    from app.core import resume
    from app.main import app

    body = "# 王五\n\n## 项目经历\n### OfferU | 前端 | 2025.03 – 2025.06\n- 块编辑器\n"
    style = {"template": "kami", "bodySize": 9.8, "margin": {"top": 12}, "accent": "#1B365D"}
    with TestClient(app, base_url="http://127.0.0.1:8766") as client:
        def save(data, id_=None):
            return client.post("/api/tools/save", json={"type": "doc", "data": data, **({"id": id_} if id_ else {})})

        doc = save({"kind": "resume", "title": "主简历", "body": body, "style": style}).json()["record"]
        assert doc["style"] == style
        for bad in ({"fontSize": 10}, {"bodySize": 30}, {"lineHeight": True}, {"accent": "red"},
                    {"margin": {"top": 1}}, {"margin": {"middle": 5}}, {"template": "fancy"}, {"photo": "yes"}, {"logo": "../x.png"}):
            assert save({"style": bad}, doc["id"]).status_code == 400, bad

        page = client.post("/api/resume/render", json={"body": body, "style": style}).text
        assert '<h3 data-path="sections.0.items.0.head">OfferU' in page and '<span class="r">2025.03 – 2025.06</span>' in page
        assert "--body-size: 9.8pt" in page and "--margin-top: 12mm" in page and "--margin-left: 13mm" in page
        assert "Songti SC" in page and 'class="resume t-kami"' in page
        assert client.post("/api/resume/render", json={"body": body, "style": {"bodySize": 30}}).status_code == 400
        assert doc["resume"]["sections"][0]["type"] == "project"
        assert "块编辑器" in client.post("/api/resume/render", json={"resume": doc["resume"], "style": style}).text
        assert client.post("/api/resume/render", json={"resume": {"sections": "x"}}).status_code == 400

    legacy = resume.resolve_style(None, "photo")
    assert legacy["template"] == "clear" and legacy["photo"] is True
    assert resume.resolve_style({"template": "compact"})["margin"] == {"top": 10, "right": 12, "bottom": 10, "left": 12}
