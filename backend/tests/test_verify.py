"""改写结果核对：数字追不到来源 block；动词越级、约数词被删、普及度说法 warn；来源空就明说没检查。纯函数，不调模型。"""

from app.core.verify import check, known_numbers

SOURCES = """[实习 / 工作] 某公司 · 运营实习 2023.06 – 2023.09
参与公众号运营，粉丝从 2,000 涨到 8000
（用户 2026-11-04 亲口说：大概让处理时间缩短了三成左右）
- 协助策划校园活动，来了 300 人"""


def test_numbers_normalize_commas_units_and_dates():
    known = known_numbers(SOURCES)
    assert {"2000", "8000", "2023", "6", "9", "300", "三成"} <= known
    assert "20000" in known_numbers("涨粉 2万")


def test_traced_numbers_pass_and_list_marks_are_not_numbers():
    body = "# 张三\n1. 运营实习 2023.06 – 2023.09\n- 参与公众号运营，粉丝从 2000 涨到 8,000\n- 协助策划校园活动，来了 300 人"
    out = check(body, SOURCES)
    assert out == {"block": [], "warn": [], "unchecked": ""}


def test_untraced_number_blocks():
    out = check("- 参与公众号运营，粉丝从 2000 涨到 2 万", SOURCES)
    assert [b["kind"] for b in out["block"]] == ["number"]
    assert "2 万" in out["block"][0]["detail"]


def test_verb_escalation_dropped_hedge_and_claims_only_warn():
    body = "- 主导公众号运营，处理时间缩短三成\n- 策划全网爆款校园活动，来了 300 人"
    out = check(body, SOURCES)
    assert out["block"] == []
    kinds = sorted(w["kind"] for w in out["warn"])
    assert kinds == ["claim", "hedge", "verb"]
    assert "全网" in next(w for w in out["warn"] if w["kind"] == "claim")["detail"]


def test_kept_hedge_is_fine():
    out = check("- 参与公众号运营，处理时间缩短约三成", SOURCES)
    assert out["warn"] == [] and out["block"] == []


def test_empty_sources_say_unchecked():
    out = check("- 粉丝涨到 8000", "  ")
    assert out["block"] == [] and out["warn"] == [] and "没检查" in out["unchecked"]
