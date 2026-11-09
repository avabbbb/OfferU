from app.core import job_eval

JOB = {"id": 1, "jd": "x"}


def test_score_is_sum_of_capped_breakdown():
    out = job_eval.normalize({"breakdown": {"hard": 30, "core": 20, "evidence": 15.4, "industry": -3, "expression": 8},
                              "score": 99, "reasons": [], "markdown": "# 结论\nx"}, JOB, "w")
    assert out["score"] == 25 + 20 + 15 + 0 + 8
    md = out["markdown"]
    assert "## 评分口径\n口径 v2：硬门槛 25/25、核心职责 20/30、证据强度 15/20、行业认知 0/15、表达 8/10，合计 68。" in md
    assert md.index("## 评分口径") < md.index("## 来源")


def test_missing_breakdown_falls_back_to_model_score_without_version():
    out = job_eval.normalize({"breakdown": {"hard": 20}, "score": 70, "markdown": "# 结论\nx"}, JOB, "w")
    assert out["score"] == 70 and "评分口径" not in out["markdown"]


def test_prompt_uses_fixed_rubric_and_four_tiers():
    assert '"breakdown"' in job_eval.PROMPT and "不要自己写 score" in job_eval.PROMPT
    for _, name, cap in job_eval.RUBRIC:
        assert f"{name} 0–{cap}" in job_eval.PROMPT
    assert sum(cap for *_, cap in job_eval.RUBRIC) == 100
    assert "强 / 中 / 弱 / 无" in job_eval.PROMPT and "命中 / 部分命中" not in job_eval.PROMPT
