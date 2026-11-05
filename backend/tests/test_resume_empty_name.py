"""没填名字的简历：to_markdown 写出光秃秃的 #，要能原样读回、能拿去改写。

真实用户的简历就是这样：以前读回时 # 变成联系方式，再写出就是双 #；
模型照抄 # 时改写报「不是简历格式」。
"""
from app.core import resume_model as rm
from app.core import tailor

BASE = {
    "basics": {"name": "", "target": "", "contacts": []},
    "sections": [{"id": "s1", "type": "education", "title": "教育经历", "hidden": False, "items": [
        {"title": "某大学", "subtitle": "软件工程", "location": "", "date": "2021-09 – 2025-07",
         "text": "", "bullets": ["要点"]}]}],
}


def test_empty_name_round_trips():
    md = rm.to_markdown(BASE)
    assert md.startswith("#\n")
    back = rm.from_markdown(md)
    assert back["basics"]["name"] == ""
    assert back["basics"]["contacts"] == []
    assert rm.to_markdown(back) == md


def test_tailor_accepts_resume_without_name():
    md = rm.to_markdown(BASE).strip()
    assert tailor.clean(md) == md + "\n"


def test_tailor_still_rejects_non_resume():
    for bad in ("#标题\n\n## 节", "没有标题\n\n## 节", "# 名字\n没有分节"):
        try:
            tailor.clean(bad)
        except ValueError:
            continue
        raise AssertionError(bad)
