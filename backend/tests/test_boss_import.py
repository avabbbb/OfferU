"""boss-cli 导出文件解析：认外壳和裸 data，按投递状态映射，缺公司或岗位名的跳过。"""


import pytest

from app.services.boss_import import parse_boss_export

APPLIED = {"ok": True, "schema_version": "1", "data": {"cardList": [
    {"jobInfo": {"jobName": "后端开发实习生", "encryptJobId": "a1", "cityName": "北京", "salaryDesc": "200元/天"}, "brandInfo": {"brandName": "字节跳动"}, "deliverStatusDesc": "已投递"},
    {"jobInfo": {"jobName": "Java 实习", "encryptJobId": "a2"}, "brandInfo": {"brandName": "哔哩哔哩"}, "deliverStatusDesc": "不合适"},
    {"jobInfo": {"jobName": "没有公司"}},
]}}


def test_parse_applied_envelope():
    kind, rows = parse_boss_export(APPLIED)
    assert kind == "applied"
    assert [(r["job"]["company"], r["status"]) for r in rows] == [("字节跳动", "submitted"), ("哔哩哔哩", "rejected")]
    assert rows[0]["job"]["url"] == "https://www.zhipin.com/job_detail/a1.html"
    assert rows[0]["job"]["location"] == "北京"


def test_parse_bare_interviews_and_unknown():
    kind, rows = parse_boss_export({"interviewList": [{"jobName": "Go 后端", "brandName": "快手"}]})
    assert kind == "interviews" and rows[0]["status"] == "interview" and rows[0]["job"]["url"] == ""
    with pytest.raises(ValueError):
        parse_boss_export({"data": {"foo": []}})


def test_parse_keeps_security_id_for_detail():
    from app.services.boss_import import parse_boss_export

    _, rows = parse_boss_export({"cardList": [{"jobName": "数据分析实习生", "brandName": "美团", "encryptJobId": "g1", "securityId": "s1"}]})
    assert rows[0]["security_id"] == "s1"
