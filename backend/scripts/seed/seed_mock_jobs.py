"""
Mock 数据生成脚本 — 生成测试岗位数据
运行: cd backend && python -m scripts.seed_mock_jobs
"""
from __future__ import annotations

import hashlib
import json
import random
import sys

import httpx

API_BASE = "http://127.0.0.1:8765"

# ---- 模拟数据池 ----
COMPANIES = [
    ("腾讯", "互联网", "10000人以上"),
    ("阿里巴巴", "电商/互联网", "10000人以上"),
    ("字节跳动", "互联网/短视频", "10000人以上"),
    ("米哈游", "游戏", "1000-9999人"),
    ("鹰角网络", "游戏", "500-999人"),
    ("叠纸游戏", "游戏", "500-999人"),
    ("百度", "AI/搜索引擎", "10000人以上"),
    ("美团", "本地生活", "10000人以上"),
    ("京东", "电商", "10000人以上"),
    ("网易", "游戏/互联网", "10000人以上"),
    ("华为", "通信/ICT", "10000人以上"),
    ("小红书", "社交/电商", "1000-9999人"),
    ("哔哩哔哩", "视频/社区", "1000-9999人"),
    ("拼多多", "电商", "10000人以上"),
    ("蚂蚁集团", "金融科技", "10000人以上"),
    ("快手", "短视频", "10000人以上"),
    ("OPPO", "智能硬件", "10000人以上"),
    ("大疆创新", "无人机/机器人", "5000-9999人"),
    ("商汤科技", "AI", "1000-4999人"),
    ("深势科技", "AI for Science", "100-499人"),
]

TITLES = [
    "前端开发工程师（校招）",
    "后端开发实习生",
    "算法工程师-2026届校招",
    "产品经理（春招）",
    "数据分析师实习",
    "Python 后端开发-秋招",
    "游戏客户端开发（校园招聘）",
    "UI/UX 设计师实习",
    "运维工程师-应届生",
    "测试开发工程师（校招）",
    "NLP 算法实习生",
    "推荐算法工程师-管培生",
    "iOS 开发（暑期实习）",
    "安卓开发工程师-26届",
    "机器学习工程师（校招）",
    "全栈工程师-实习",
    "大数据开发工程师（秋招）",
    "云计算工程师-2026届",
    "安全工程师（校园招聘）",
    "图形渲染工程师-校招",
    "C++ 开发实习生",
    "Java 后端高级开发",
    "DevOps 工程师",
    "技术美术 TA（校招）",
    "量化研究员-实习",
]

LOCATIONS = ["北京", "上海", "深圳", "杭州", "广州", "成都", "武汉", "南京", "西安", "苏州"]
SOURCES = ["boss", "zhilian", "linkedin", "shixiseng", "maimai", "corporate"]
EDUCATIONS = ["本科", "硕士", "博士", "不限"]
EXPERIENCES = ["应届", "1-3年", "3-5年", "不限", "在校生"]
JOB_TYPES = ["全职", "实习", "校招", "兼职"]

SALARY_RANGES = [
    (None, None, ""),
    (5000, 8000, "5-8K"),
    (8000, 15000, "8-15K"),
    (10000, 20000, "10-20K"),
    (15000, 25000, "15-25K"),
    (15000, 30000, "15-30K·13薪"),
    (20000, 40000, "20-40K·16薪"),
    (25000, 50000, "25-50K·15薪"),
    (3000, 6000, "3-6K（实习日薪300-600）"),
]

KEYWORDS_POOL = [
    "Python", "Java", "Go", "C++", "Rust", "TypeScript", "React", "Vue",
    "机器学习", "深度学习", "NLP", "CV", "推荐系统", "大数据", "Spark",
    "Docker", "K8s", "AWS", "GCP", "Linux", "Git", "敏捷开发",
    "Unity", "Unreal", "OpenGL", "游戏开发", "图形渲染",
    "产品设计", "用户研究", "数据分析", "SQL", "Tableau", "A/B测试",
]

JD_TEMPLATES = [
    "岗位职责：\n1. 参与{team}团队的核心项目开发\n2. 负责{area}相关的技术方案设计与实现\n3. 与产品/设计团队紧密协作，推动产品迭代\n\n任职要求：\n1. {edu}及以上学历，计算机相关专业\n2. 熟悉{lang}编程语言\n3. 有{skill}相关经验者优先\n4. 良好的团队协作能力和沟通能力",
    "我们正在寻找优秀的{role}加入我们的团队。\n\n工作内容：\n- 负责{area}模块的开发与优化\n- 参与技术选型和架构设计\n- 编写高质量的代码和技术文档\n\n我们期望你：\n- {edu}学历，{exp}经验\n- 精通{lang}，了解{skill}\n- 对技术有热情，学习能力强",
]


def generate_jobs(count: int = 30) -> list[dict]:
    """生成 Mock 岗位数据"""
    jobs = []
    for i in range(count):
        company, industry, size = random.choice(COMPANIES)
        title = random.choice(TITLES)
        location = random.choice(LOCATIONS)
        source = random.choice(SOURCES)
        education = random.choice(EDUCATIONS)
        experience = random.choice(EXPERIENCES)
        job_type = random.choice(JOB_TYPES)
        sal_min, sal_max, sal_text = random.choice(SALARY_RANGES)
        keywords = random.sample(KEYWORDS_POOL, k=random.randint(3, 6))

        raw_desc = random.choice(JD_TEMPLATES).format(
            team=random.choice(["基础架构", "AI平台", "业务", "数据", "游戏引擎"]),
            area=random.choice(["后端服务", "前端交互", "算法模型", "数据流水线", "基础设施"]),
            edu=education,
            lang=random.choice(["Python", "Java", "Go", "C++", "TypeScript"]),
            skill=random.choice(["分布式系统", "机器学习", "全栈开发", "游戏开发", "数据分析"]),
            role=title.split("（")[0].split("-")[0],
            exp=experience,
        )

        raw = f"{title}-{company}-{i}-{random.random()}"
        hash_key = hashlib.md5(raw.encode()).hexdigest()

        jobs.append({
            "title": title,
            "company": company,
            "location": location,
            "url": f"https://example.com/jobs/{hash_key[:8]}",
            "apply_url": f"https://example.com/apply/{hash_key[:8]}",
            "source": source,
            "raw_description": raw_desc,
            "hash_key": hash_key,
            "summary": raw_desc[:100],
            "keywords": keywords,
            "salary_min": sal_min,
            "salary_max": sal_max,
            "salary_text": sal_text,
            "education": education,
            "experience": experience,
            "job_type": job_type,
            "company_size": size,
            "company_industry": industry,
            "company_logo": "",
            "is_campus": False,  # 将由后端 detect_campus 自动判定
        })
    return jobs


def main():
    count = int(sys.argv[1]) if len(sys.argv) > 1 else 30
    jobs = generate_jobs(count)

    print(f"生成 {len(jobs)} 条 Mock 岗位数据...")

    resp = httpx.post(
        f"{API_BASE}/api/jobs/ingest",
        json={"jobs": jobs},
        timeout=30,
    )
    result = resp.json()
    print(f"入库结果: 新增 {result.get('created', 0)} 条, 跳过 {result.get('skipped', 0)} 条")


if __name__ == "__main__":
    main()
