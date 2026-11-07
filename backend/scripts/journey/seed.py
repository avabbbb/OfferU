"""隔离评测的种子数据：一个虚构测试用户、三个测试岗位（j3 学历硬性不符）、一份旧主简历。

全部标「测试数据」，只写进 OFFERU_DATA_DIR 指向的隔离目录；指向真实数据目录时拒绝。
经历故意写得含糊、没有数字，留给 Agent 追问。岗位 url 是测试编号，不指向任何网页。
"""

from pathlib import Path

TEST_TAG = "测试数据"
SEED_ACTOR = "测试种子"
REAL_DATA = Path("H:/OfferU/data").resolve()

PROFILE = {
    "name": "林知远（测试用户）", "school": "示例大学", "major": "统计学", "degree": "本科",
    "grad_year": 2026, "city": "上海", "email": "linzhiyuan.test@example.com", "phone": "13800000000",
    "target": "数据分析 / 用户增长分析", "about": "测试数据：隔离评测用的虚构候选人，不是真实用户。",
}

MEMORIES = [
    {"kind": "experience", "title": "示例电商 · 数据分析实习", "mode": "实习",
     "body": "做过一些报表和分析，具体做了什么还没写清楚。", "tags": [TEST_TAG]},
    {"kind": "project", "title": "校园二手平台用户留存分析（课程项目）", "body": "做了留存相关的分析。",
     "tags": [TEST_TAG]},
    {"kind": "skill", "title": "SQL / Python（pandas）/ Excel", "body": "SQL 日常用；Python 会 pandas；Excel 透视表。",
     "tags": [TEST_TAG]},
    {"kind": "education", "title": "示例大学 · 统计学 · 本科", "mode": "全日制", "start": "2022-09",
     "end": "2026-06", "tags": [TEST_TAG]},
]

RESUME_BODY = """# 林知远

13800000000 | linzhiyuan.test@example.com | 上海

## 教育经历
### 示例大学 | 统计学 本科 | 2022.09 – 2026.06
- 主修课程：数理统计、回归分析、数据库原理

## 实习经历
### 示例电商 | 数据分析实习生 | 2025.07 – 2025.09
- 参与日常数据报表制作
- 支持运营同学的数据需求

## 项目经历
### 校园二手平台用户留存分析 | 课程项目 | 2025.03 – 2025.06
- 做了用户留存分析

## 技能
- SQL、Python（pandas）、Excel
"""

JOBS = {
    "j1": {
        "company": "示例科技（测试数据）", "title": "数据分析师（2026 届校招）", "city": "上海", "status": "saved",
        "url": "eval-test-j1-data-analyst", "source": "test", "tags": [TEST_TAG],
        "jd": ("岗位职责：\n1. 负责电商业务核心指标（GMV、转化、留存）的监控与周报；\n"
               "2. 设计并分析 A/B 实验，给出可落地的业务建议；\n3. 与产品、运营合作，搭建分析看板。\n"
               "任职要求：\n1. 2026 届本科及以上，统计、数学、计算机等相关专业；\n2. 熟练使用 SQL，会 Python 数据分析；\n"
               "3. 有 A/B 测试或增长分析经验者优先；会 Tableau 等 BI 工具优先。\n"
               "投递方式：简历发送至 hr-test@example.com，邮件标题格式「姓名-学校-岗位-最快到岗时间」，"
               "附件为 PDF，命名「姓名-岗位」。"),
    },
    "j2": {
        "company": "样例零售（测试数据）", "title": "用户增长分析实习生", "city": "上海", "status": "saved",
        "url": "eval-test-j2-growth-intern", "source": "test", "tags": [TEST_TAG],
        "jd": ("职责：分析拉新、促活活动效果，跟踪渠道转化漏斗，产出专题分析。\n"
               "要求：本科及以上在读或应届；熟悉 SQL；每周到岗 4 天以上，实习 6 个月以上；"
               "有用户留存 / 漏斗分析项目经验加分。"),
    },
    "j3": {
        "company": "演示资本（测试数据）", "title": "量化研究员（校招）", "city": "北京", "status": "saved",
        "url": "eval-test-j3-quant", "source": "test", "tags": [TEST_TAG],
        "jd": ("职责：因子研究与策略回测。\n"
               "任职要求（硬性）：硕士及以上学历，数学 / 统计 / 金融工程等专业；精通 Python 与 C++；"
               "有实盘或比赛经历。本科学历简历不予考虑。"),
    },
}


def seed(tools) -> dict:
    from app.runtime_paths import runtime_data_dir

    if runtime_data_dir() == REAL_DATA:
        raise SystemExit("拒绝：OFFERU_DATA_DIR 指向真实数据目录")

    def save(type_: str, data: dict) -> int:
        return tools.call("save", {"type": type_, "data": data}, actor=SEED_ACTOR)["record"]["id"]

    ids = {"profile": save("profile", PROFILE), "memories": [save("memory", m) for m in MEMORIES]}
    ids["main_resume"] = save("doc", {"kind": "resume", "title": "主简历（测试数据）", "body": RESUME_BODY})
    ids["jobs"] = {key: {"id": save("job", job), "company": job["company"], "title": job["title"]}
                   for key, job in JOBS.items()}
    return ids
