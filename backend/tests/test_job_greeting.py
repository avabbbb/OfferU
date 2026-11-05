from app.core import job_eval


def test_greeting_trimmed_and_optional():
    """评估结果里的打招呼语：去首尾空白、限 300 字；模型没给就是空串，不影响评估。"""
    job = {"id": 1, "jd": "x"}
    out = job_eval.normalize({"score": 80, "reasons": ["a", "b", "c"], "greeting": "  您好，我是…… ",
                              "markdown": "# 结论\nx"}, job, "用户粘贴")
    assert out["greeting"] == "您好，我是……"
    long = job_eval.normalize({"score": 80, "reasons": [], "greeting": "嗨" * 400, "markdown": "# 结论\nx"}, job, "w")
    assert len(long["greeting"]) == 300
    none = job_eval.normalize({"score": 70, "reasons": ["a"], "markdown": "# 结论\nx"}, job, "w")
    assert none["greeting"] == "" and none["score"] == 70
