"""记忆注入：Agent 提示词只放记忆索引（不带正文），口径单列成规则、不当事实。Route: fast-path。"""

import pytest

from app.core import agent, tailor
from app.core.tools import USER_ACTOR, call


@pytest.fixture(autouse=True)
def _data_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("OFFERU_DATA_DIR", str(tmp_path))


def _memory(actor, title, kind="experience", body=""):
    data = {key: value for key, value in (("kind", kind), ("title", title), ("body", body)) if value}
    return call("save", {"type": "memory", "data": data}, actor=actor)["record"]


def test_index_line_is_id_kind_title_without_body():
    record = _memory(USER_ACTOR, title="某公司 运营实习", body="正文里的秘密细节 8000")
    prompt = agent.system_prompt()
    assert f"#{record['id']} [实习 / 工作] 某公司 运营实习\n" in prompt
    assert "正文里的秘密细节" not in prompt
    assert "get(type=memory" in prompt


def test_unconfirmed_memory_is_marked():
    record = _memory(agent.ACTOR, title="Agent 总结的经历")
    assert f"#{record['id']} [实习 / 工作] Agent 总结的经历 · 待确认" in agent.memory_index()


def test_index_caps_lines_newest_first_and_counts_omitted():
    ids = [_memory(USER_ACTOR, title=f"经历{n}")["id"] for n in range(agent.INDEX_LINES + 5)]
    lines = agent.memory_index().splitlines()
    assert len(lines) == agent.INDEX_LINES + 1
    assert lines[0].startswith(f"#{ids[-1]} ")
    assert not any(line.startswith(f"#{ids[0]} ") for line in lines)
    assert "还有 5 条" in lines[-1]


def test_index_caps_chars():
    for _ in range(10):
        _memory(USER_ACTOR, title="长" * 500)
    lines = agent.memory_index().splitlines()
    assert sum(len(line) + 1 for line in lines[:-1]) <= agent.INDEX_CHARS
    assert f"还有 {10 - (len(lines) - 1)} 条" in lines[-1]


def test_preference_is_a_rule_not_a_fact():
    _memory(USER_ACTOR, kind="preference", title="不突出学生会", body="以后简历里不写学生会经历")
    _memory(agent.ACTOR, kind="preference", title="未确认口径")
    _memory(USER_ACTOR, title="某公司实习", body="粉丝 8000")
    job = call("save", {"type": "job", "data": {"company": "百度", "title": "运营", "jd": "负责运营"}}, actor=USER_ACTOR)["record"]
    assert tailor.rules() == "- 不突出学生会：以后简历里不写学生会经历"
    facts = tailor._facts()
    assert "学生会" not in facts and "某公司实习" in facts
    doc = {"body": "# 张三"}
    for msgs in (tailor.messages(doc, job), tailor.review_messages(doc, job, "# 张三", None)):
        user = msgs[1]["content"]
        rules_at = user.index("## 用户的口径和偏好（必须遵守）\n- 不突出学生会：以后简历里不写学生会经历")
        assert rules_at < user.index("## 档案和经历")
        assert "未确认口径" not in user
    assert "口径和偏好" in tailor.PROMPT and "口径和偏好" in tailor.REVIEW_PROMPT
    prompt = agent.system_prompt()
    assert "以后简历里不写学生会经历" in prompt and "kind=preference" in prompt


def test_no_preferences_no_rules_section():
    _memory(USER_ACTOR, title="某公司实习")
    job = call("save", {"type": "job", "data": {"company": "百度", "title": "运营", "jd": "负责运营"}}, actor=USER_ACTOR)["record"]
    assert tailor.rules() == ""
    assert "口径和偏好" not in tailor.messages({"body": ""}, job)[1]["content"]


def test_memory_arm_controls_agent_prompt(monkeypatch):
    _memory(USER_ACTOR, "某公司实习", body="粉丝 8000 正文")
    _memory(USER_ACTOR, "不突出学生会", kind="preference", body="不写学生会")
    _memory(agent.ACTOR, "Agent 总结", body="待确认正文")
    monkeypatch.delenv("OFFERU_MEMORY_ARM", raising=False)
    assert "记忆索引" in agent.system_prompt()
    monkeypatch.setenv("OFFERU_MEMORY_ARM", "none")
    prompt = agent.system_prompt()
    assert "某公司实习" not in prompt and "不写学生会" not in prompt and "Agent 总结" not in prompt
    monkeypatch.setenv("OFFERU_MEMORY_ARM", "index")
    prompt = agent.system_prompt()
    assert "某公司实习" in prompt and "粉丝 8000 正文" not in prompt and "不写学生会" in prompt
    assert "Agent 总结 · 待确认" in prompt and "待确认正文" not in prompt
    monkeypatch.setenv("OFFERU_MEMORY_ARM", "full")
    prompt = agent.system_prompt()
    assert "粉丝 8000 正文" in prompt and "不写学生会" in prompt
    assert "Agent 总结 · 待确认\n待确认正文" in prompt
    monkeypatch.setenv("OFFERU_MEMORY_ARM", "bogus")
    with pytest.raises(ValueError, match="OFFERU_MEMORY_ARM"):
        agent.system_prompt()
