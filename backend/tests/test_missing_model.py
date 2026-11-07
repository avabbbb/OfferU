"""工具内部要调模型、但没配模型：明确报错，不写任何数据；trace 里这次子模型调用标成失败。"""

import json

import pytest

from app.core import store, tools, trace

RESUME = "# 测试同学\n\n## 实习经历\n### 示例公司 | 数据分析实习 | 2025.07 – 2025.09\n- 做周报\n"


def _job() -> int:
    return tools.call("save", {"type": "job", "data": {"company": "测试公司", "title": "数据分析师",
                                                        "jd": "要求熟悉 SQL。"}}, actor="测试")["record"]["id"]


def test_evaluate_jobs_without_model_says_so_and_writes_nothing(tmp_path, monkeypatch):
    monkeypatch.setenv("OFFERU_TRACE_DIR", str(tmp_path / "traces"))
    job_id = _job()
    before = store.changes(200)
    run = trace.start("run_missingmodel0001", journey_id="test")
    with pytest.raises(ValueError, match="模型"):
        tools.call("evaluate_jobs", {"ids": [job_id]}, actor="助手")
    path = run.finish("failed", stop_reason="error", error="no model")
    trace.clear()
    assert store.changes(200) == before
    data = json.loads(path.read_text(encoding="utf-8"))
    call = data["tool_calls"][-1]
    assert call["tool"] == "evaluate_jobs" and not call["ok"] and "模型" in call["error"]
    assert data["terminal_state"] == "failed" and data["usage"] == {"prompt": None, "completion": None}


def test_tailor_without_model_says_so_and_leaves_resume(tmp_path):
    job_id = _job()
    doc = tools.call("save", {"type": "doc", "data": {"kind": "resume", "title": "主简历", "body": RESUME}},
                     actor="测试")["record"]
    before = store.changes(200)
    with pytest.raises(ValueError, match="模型"):
        tools.call("tailor_resume", {"id": doc["id"], "job_id": job_id}, actor="助手")
    assert store.changes(200) == before
    assert store.get("doc", doc["id"])["body"] == doc["body"]
