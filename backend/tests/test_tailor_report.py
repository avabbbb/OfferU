"""tailor_report：JD 清洗、关键词覆盖、审稿、页数；都不调模型。"""

from app.core import tailor_report as tr

JD = ("公司简介：\n我们是一家做本地生活的公司\n岗位职责：\n1. 负责推荐系统后端开发\n任职要求：\n"
      "1. 熟悉 Python、Go 和 Redis\n2. 具备分布式系统设计经验者优先\n福利待遇：\n五险一金，下午茶\n简历投递：hr@example.com\n")


def test_clean_jd_drops_company_and_benefits():
    out = tr.clean_jd(JD)
    assert "推荐系统" in out and "Redis" in out
    assert "本地生活" not in out and "五险一金" not in out and "hr@example.com" not in out


def test_clean_jd_keeps_unstructured_text():
    assert tr.clean_jd("熟悉 Go") == "熟悉 Go"
    assert tr.clean_jd("") == ""


def test_keywords_and_coverage():
    assert tr.keywords(JD) == ["Python", "Go", "Redis", "分布式系统设计"]
    body = "# 张三\n\n## 项目经历\n### 推荐服务 | 后端\n- 用 python 和 Redis 做缓存，P99 延迟降 40%\n"
    assert tr.coverage(JD, body) == {"hit": ["Python", "Redis"], "missing": ["Go", "分布式系统设计"]}


def test_review_flags_vague_resultless_and_shallow():
    body = ("# 张三\n\n## 实习经历\n### 某公司 | 运营\n- 负责日常活动\n- 协助整理数据\n"
            "## 项目经历\n### 推荐服务 | 后端\n- 用 Redis 做缓存，P99 延迟降 40%\n")
    found = [(i["kind"], i["line"]) for i in tr.review(body)]
    assert ("动词", "负责日常活动") in found and ("结果", "协助整理数据") in found
    assert ("深度", "某公司 | 运营") in found
    assert not any(line.startswith("用 Redis") or line.startswith("推荐服务") for _, line in found)


def test_build_without_browser_and_over_page(monkeypatch):
    monkeypatch.setattr(tr, "page_count", lambda record: None)
    out = tr.build("# a\n\n## 技能\n- Go\n", "熟悉 Go", {})
    assert out["pages"] is None and out["over_page"] is False and out["coverage"]["hit"] == ["Go"]
    monkeypatch.setattr(tr, "page_count", lambda record: 1.3)
    assert tr.build("# a\n\n## 技能\n- Go\n", "熟悉 Go", {})["over_page"] is True
