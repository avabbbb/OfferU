"""Generate job-eval parity fixtures from the Python backend.

Run from backend/:  python3 ../backend-ts/test/fixtures/gen_job_eval_parity.py
Writes job-eval-parity.json next to this file. The TS test feeds the same inputs
to packages/core/src/research and expects identical prompts and outputs.
"""

import asyncio
import json
from pathlib import Path

from app.agents import llm
from app.core import job_eval

PROFILE = {"name": "小林", "school": "浙江大学", "major": "计算机", "degree": "硕士", "grad_year": 2026,
           "city": "杭州", "target": "后端开发", "stage": "", "about": None}
MEMORIES = [
    {"kind": "experience", "title": "字节跳动 后端实习", "body": "负责推荐服务，QPS 提升 30%。" * 30},
    {"kind": None, "title": "", "body": "喜欢上海"},
    {"kind": "skill", "title": "Go", "body": None},
]
POSTING = {
    "hire_type": "校招", "team": "基础架构", "years": "", "education": "本科", "salary": "20-30K",
    "responsibilities": ["设计高并发服务", "  ", "维护 K8s 平台"], "hard_reqs": ["Go/Java", 3], "soft_reqs": [],
    "keywords": ["Go", "Kubernetes"], "collaborators": ["SRE", "产品"],
    "evidence": [{"req": "高并发", "need": "压测数据"}, {"req": "", "need": "x"}, "bad"],
    "essence": "做稳定的服务",
}

JOBS = [
    {"id": 1, "company": "字节跳动", "title": "后端开发", "city": "北京", "url": "https://jobs.bytedance.com/campus/position/1",
     "jd": "负责后端" * 800, "notes": "  内推  "},
    {"id": 2, "company": "某创业公司", "title": "Go 工程师", "url": "https://app.mokahr.com/apply/x/123", "jd": "Go", "posting": POSTING},
    {"id": 3, "company": "腾讯", "title": "产品", "url": "https://www.zhipin.com/job_detail/abc.html", "source": "BOSS", "jd": "产品"},
    {"id": 4, "company": "", "title": "运营", "jd": "运营", "source": "xhs"},
    {"id": 5, "company": "某公司", "title": "数据", "jd": "数据", "url": "https://User@Careers.Example.COM:8443/a"},
    {"id": 6, "title": "无名", "jd": "x", "posting": {}},
]

RAWS = [
    json.dumps({"breakdown": {"hard": 30, "core": 20, "evidence": 15.5, "industry": -3, "expression": 8.5},
                "score": 99, "reasons": ["最匹配：Go", "  ", "差距：没有 K8s" * 10, "第四条"],
                "greeting": "  您好，我是……  ", "markdown": "# 结论\n可以投 [inference]\n\n## 来源\n- 模型编的"}, ensure_ascii=False),
    "前言```json\n" + json.dumps({"score": "72.5", "reasons": "abc", "markdown": "  # 结论\nx\n## Sources\ny"}, ensure_ascii=False) + "\n```",
    "好的 {\"breakdown\": {\"hard\": 20}, \"score\": 64.5, \"reasons\": [1, null, true], \"greeting\": null, \"markdown\": \"# 结论\\n嗯\"} 结束",
    json.dumps({"score": 80, "markdown": "没有结论标题"}),
    json.dumps({"score": "abc", "markdown": "# 结论"}),
    json.dumps({"score": 150, "breakdown": None, "reasons": ["a"], "greeting": "嗨" * 400, "markdown": "# 结论\nok"}, ensure_ascii=False),
    "",
    "[1, 2]",
]


async def run_case(profile_text, job, raw):
    captured = {}

    async def fake(messages, **kwargs):
        captured["messages"] = messages
        captured["kwargs"] = kwargs
        return raw or None

    llm.chat_completion = fake
    result = await job_eval.evaluate(profile_text, job)
    return {"messages": captured["messages"], "options": captured["kwargs"], "result": result}


def main():
    profile_text = job_eval.candidate(PROFILE, MEMORIES)
    cases = []
    for index, job in enumerate(JOBS):
        for n, raw in enumerate(RAWS if index == 0 else RAWS[:1]):
            case = {"job": job, "raw": raw, **asyncio.run(run_case(profile_text, job, raw))}
            if n:  # same prompt as the first raw for this job; keep the fixture small
                del case["messages"]
            cases.append(case)
    empty = asyncio.run(run_case(job_eval.candidate(None, []), JOBS[3], RAWS[0]))
    out = {
        "profile": PROFILE, "memories": MEMORIES, "profile_text": profile_text,
        "empty_profile_text": job_eval.candidate(None, []),
        "cases": cases,
        "empty_case": {"job": JOBS[3], "raw": RAWS[0], **empty},
        "source_facts": [{"job": j, "fact": list(job_eval.source_fact(j))} for j in JOBS],
    }
    Path(__file__).with_name("job-eval-parity.json").write_text(json.dumps(out, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")


main()
