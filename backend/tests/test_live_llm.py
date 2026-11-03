"""真模型冒烟：默认跳过。OFFERU_LIVE_LLM=1 时用本机激活的模型配置，在临时目录把主线串一遍并打印每步耗时。

    OFFERU_LIVE_LLM=1 uv run --no-sync python -m pytest tests/test_live_llm.py -q -s
"""

import os
import time
from pathlib import Path

import pytest

pytestmark = pytest.mark.skipif(os.environ.get("OFFERU_LIVE_LLM") != "1", reason="真模型冒烟：设 OFFERU_LIVE_LLM=1 才跑")

JD = """字节跳动 · AI 产品实习生（企业 AI 方向）· 上海
岗位职责：参与企业级 AI 助手的需求调研与产品设计；搭建评测集，跟进大模型效果迭代。
任职要求：2027 届本科及以上；熟悉大模型应用，有 Agent 或 RAG 项目经验加分；每周 4 天以上。
投递方式：简历请发送至 ai-intern-hr@example.com，邮件标题：姓名-学校-岗位-到岗时间，附件为 PDF。截止 2026-11-30。"""
RESUME = "# 张三\n\n## 实习\n\n### 某电商公司 产品实习\n\n- 负责客服机器人意图识别需求文档\n\n## 项目\n\n### 求职 Agent 工作台\n\n- FastAPI + Next.js，接 LLM\n"


def test_live_main_flow(tmp_path, monkeypatch):
    from app.agents.llm import resolve_llm_client_config
    from app.llm_config_store import sync_runtime_settings_from_file

    # 先从真实数据目录读模型配置（Key 在系统钥匙串里），再把所有读写切到临时目录。
    monkeypatch.setenv("OFFERU_DATA_DIR", os.environ.get("OFFERU_LIVE_CONFIG_DIR") or str(Path(__file__).resolve().parents[1]))
    assert sync_runtime_settings_from_file(), "没读到 config.json"
    resolve_llm_client_config()
    monkeypatch.setenv("OFFERU_DATA_DIR", str(tmp_path))

    from app.core.tools import call

    def step(name, tool, args):
        t = time.time()
        out = call(tool, args, actor="你")
        print(f"\n[live] {name}: {time.time() - t:.1f}s")
        return out

    step("profile", "save", {"type": "profile", "data": {"name": "张三", "school": "华东师范大学", "major": "软件工程", "email": "zhangsan@example.com"}})
    step("memory", "save", {"type": "memory", "data": {"kind": "project", "title": "求职 Agent 工作台", "body": "独立开发，FastAPI + Next.js，接 DeepSeek 做 JD 解析和简历定制，prompt 缓存命中率从 20% 提到 70%。"}})
    job = step("add_job", "add_job", {"text": JD})["record"]
    assert job.get("company") == "字节跳动" and "实习" in job.get("title", "")
    events = call("get", {"type": "job", "id": job["id"]}, actor="你").get("events") or []
    assert any(e.get("kind") == "deadline" and e.get("at") == "2026-11-30" for e in events)

    ranked = step("evaluate_jobs", "evaluate_jobs", {"ids": [job["id"]]})["items"]
    assert ranked and 0 <= ranked[0]["score"] <= 100 and len(ranked[0]["reasons"]) == 3

    doc = step("copy resume", "save", {"type": "doc", "data": {"kind": "resume", "title": "主简历 · 字节", "body": RESUME, "job_id": job["id"]}})
    tailored = step("tailor_resume", "tailor_resume", {"id": doc["record"]["id"], "job_id": job["id"]})
    assert len(tailored.get("body") or "") > 50

    answer = step("apply_answer", "apply_answer", {"job_id": job["id"], "question": "介绍一个大模型相关项目"})
    assert len(answer.get("answer") or "") > 30

    mail = step("draft_email", "draft_email", {"job_id": job["id"]})
    assert mail["to"] == "ai-intern-hr@example.com"
    assert mail["subject"].endswith("-[到岗时间]") and mail["subject_todo"] == ["到岗时间"]
