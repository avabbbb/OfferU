"""海投打分：只看岗位技能 / 标签有没有出现在简历里，学历年限类标签不算。"""

from app.services.boss_blast import score_job


def test_score_counts_skill_hits_and_ignores_requirements():
    job = {"skills": ["Python", "SQL", "Spark"], "jobLabels": ["本科", "1年以内", "数据分析"]}
    result = score_job(job, "熟悉 python 和 sql，做过数据分析项目")
    assert result["hits"] == ["Python", "SQL", "数据分析"]
    assert result["misses"] == ["Spark"]
    assert result["score"] == 75


def test_score_zero_without_terms():
    assert score_job({"skills": [], "jobLabels": ["本科"]}, "python")["score"] == 0
