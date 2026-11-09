"""终稿留下的经历不能悄悄丢数字 / 强动词；整条没出现算按相关度删掉，只列标题。Route: fast-path。"""

from app.core.verify import omitted, retained

KEPT = {"id": 1, "kind": "experience", "title": "某公司", "body": "粉丝从 2万 涨到 8000\n2023.06 入职，主导公众号改版", "confirmed": True}
GONE = {"id": 2, "kind": "project", "title": "校园二手平台", "body": "日活 300"}  # 老记录：没 confirmed 算确认过
PREF = {"id": 3, "kind": "preference", "title": "某公司", "body": "不写 99 这个数", "confirmed": True}
DRAFT = {"id": 4, "kind": "experience", "title": "某公司", "body": "评分 5.8", "confirmed": False}
MEMORIES = [KEPT, GONE, PREF, DRAFT]


def test_facts_kept_in_other_forms_pass():
    body = "# 张三\n### 某公司 | 运营实习 | 2023年6月\n- 主导公众号改版，粉丝从 20000 涨到 8,000"
    assert retained(body, MEMORIES) == []


def test_flags_number_and_verb_dropped_from_kept_experience():
    body = "# 张三\n### 某公司 | 运营实习\n- 参与公众号改版，粉丝涨到 8000"
    assert retained(body, MEMORIES) == [{"memory_id": 1, "title": "某公司", "missing": ["2万", "2023.06", "主导"]}]


def test_fully_omitted_memory_is_listed_by_title_only():
    body = "# 张三\n### 某公司\n- 主导公众号改版，粉丝从 2万 涨到 8000，2023.06 入职"
    assert retained(body, MEMORIES) == []
    assert omitted(body, MEMORIES) == ["校园二手平台"]


def test_kept_memory_quote_numbers_count():
    memory = {"id": 9, "kind": "experience", "title": "某公司", "body": "做公众号", "quote": "粉丝大概涨了三成"}
    assert retained("# 张三\n### 某公司\n- 做公众号", [memory]) == [{"memory_id": 9, "title": "某公司", "missing": ["三成"]}]
