"""内置 Agent 系统提示里的面试准备规则：面经可信度、面试类型侧重、Gap 质疑题、自我介绍、考点去重、模拟面试从调研出题。"""

from app.core import agent


def test_research_interview_rules(tmp_path, monkeypatch):
    monkeypatch.setenv("OFFERU_DATA_DIR", str(tmp_path))
    prompt = agent.system_prompt()
    assert "2 个以上独立来源" in prompt and "单一来源" in prompt and "近 18 个月" in prompt
    assert "不写薪资" in prompt
    assert "业务面" in prompt and "HR 面" in prompt
    assert "Gap 质疑题" in prompt and "最多 3 道" in prompt and "承认差距" in prompt
    assert "1 分钟和 3 分钟" in prompt
    assert "同一个考点只出一次" in prompt


def test_mock_interview_uses_research_first(tmp_path, monkeypatch):
    monkeypatch.setenv("OFFERU_DATA_DIR", str(tmp_path))
    prompt = agent.system_prompt()
    assert "模拟面试出题前先 get 这个岗位的调研" in prompt
