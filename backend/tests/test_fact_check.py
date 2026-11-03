"""改写后的事实核对：档案、记忆、原简历里有的不报；新冒出来的机构、日期、数字、英文词报出来；换写法的日期和全角不误报。"""

from app.core import fact_check

SOURCES = [
    "name: 张三\nschool: 某大学",
    "[实习] 字节后端实习 2025.06 – 2025.09\n接口 QPS 提升 30%，用 Go 和 Redis",
    "# 张三\n## 教育经历\n### 某大学 | 计算机 | 2022.09 – 2026.06",
]


def test_supported_facts_pass():
    body = ("# 张三\n138 · a@b.com\n\n## 实习经历\n### 字节 | 后端 | 2025年6月 – 2025-09\n"
            "- 接口 ＱＰＳ 提升 30.0%，用 Go、redis\n## 教育经历\n### 某大学 | 计算机 | 2022.09 – 2026.06\n")
    assert fact_check.check(body, SOURCES) == []


def test_unsupported_facts_listed():
    body = "# 张三\n\n## 实习经历\n### 腾讯 | 后端 | 2024.07 – 2024.09\n- 延迟降低 45%，用 Kubernetes and Go\n"
    found = [(x["kind"], x["text"]) for x in fact_check.check(body, SOURCES)]
    assert found == [("机构", "腾讯"), ("日期", "2024.07"), ("日期", "2024.09"), ("数字", "45"), ("英文词", "Kubernetes")]


def test_header_block_skipped_and_capped():
    body = "# 李四\n139 · x@y.com\n\n## 技能\n" + "\n".join(f"- 指标 {n}" for n in range(100, 200))
    found = fact_check.check(body, SOURCES)
    assert len(found) == fact_check.LIMIT and all(x["kind"] == "数字" for x in found)
