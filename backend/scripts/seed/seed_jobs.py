"""
插入 3 个针对示例候选人背景的 mock JD（AIGC/AI产品方向）
"""
import hashlib
import json
import urllib.request

BASE = "http://127.0.0.1:8765"

def api(method, path, data=None):
    body = json.dumps(data, ensure_ascii=False).encode() if data else None
    req = urllib.request.Request(
        f"{BASE}{path}",
        data=body,
        headers={"Content-Type": "application/json"} if body else {},
        method=method,
    )
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())

def make_hash(title, company, url):
    return hashlib.md5(f"{title}|{company}|{url}".encode()).hexdigest()

# 先创建一个池
print("=== 创建岗位池 ===")
pool = api("POST", "/api/pools/", {"name": "AIGC方向", "description": "AI视频/AIGC产品相关岗位"})
print(f"  Pool ID: {pool['id']}, Name: {pool['name']}")

JOBS = [
    {
        "title": "AIGC产品经理",
        "company": "字节跳动",
        "location": "深圳",
        "source": "boss",
        "url": "https://www.zhipin.com/job_detail/example1.html",
        "apply_url": "https://www.zhipin.com/job_detail/example1.html",
        "salary_text": "25-40K·15薪",
        "salary_min": 25000,
        "salary_max": 40000,
        "education": "本科",
        "experience": "1-3年",
        "job_type": "全职",
        "company_size": "10000人以上",
        "company_industry": "互联网/AI",
        "is_campus": False,
        "raw_description": """岗位职责：
1. 负责AIGC视频生成类产品的需求分析、产品设计与项目管理
2. 深入理解AI视频生成技术（Sora/Veo/WAN等），将技术能力转化为用户价值
3. 与算法团队紧密合作，定义模型评测标准和迭代方向
4. 通过数据分析驱动产品优化，提升用户留存与创作效率
5. 跟踪AIGC行业最新动态，输出竞品分析报告

任职要求：
1. 本科及以上学历，计算机/软件工程/设计相关专业优先
2. 1年以上产品经理或技术项目管理经验
3. 熟悉主流AI视频生成工具（ComfyUI/Runway/Pika等），有实际使用经验
4. 具备良好的数据分析能力和逻辑思维能力
5. 有AI视频制作或短视频创作经验者优先
6. 善于沟通，能与技术团队高效协作
""",
    },
    {
        "title": "AI应用研发工程师（视频方向）",
        "company": "腾讯",
        "location": "深圳",
        "source": "boss",
        "url": "https://www.zhipin.com/job_detail/example2.html",
        "apply_url": "https://www.zhipin.com/job_detail/example2.html",
        "salary_text": "30-50K·16薪",
        "salary_min": 30000,
        "salary_max": 50000,
        "education": "本科",
        "experience": "1-3年",
        "job_type": "全职",
        "company_size": "10000人以上",
        "company_industry": "互联网/AI",
        "is_campus": False,
        "raw_description": """岗位职责：
1. 基于大语言模型和多模态模型，开发AI视频生成与编辑应用
2. 设计和实现AI Agent工作流，支持自动化视频制作pipeline
3. 优化AI生成内容的质量控制机制（人物一致性、动作连贯性等）
4. 与前端团队协作，打造流畅的创作工具用户体验
5. 参与AI视频技术方案的调研、选型和技术文档编写

任职要求：
1. 计算机/软件工程/人工智能相关专业，本科及以上
2. 熟悉Python，了解FastAPI/Flask等Web框架
3. 有LLM应用开发经验（Prompt Engineering、Agent编排、RAG等）
4. 熟悉ComfyUI或类似AI工作流工具，有实际项目经验优先
5. 了解视频生成模型（WAN/Stable Video Diffusion/Sora等）
6. 有开源项目贡献或个人技术博客等加分
""",
    },
    {
        "title": "AI短视频产品运营",
        "company": "快手",
        "location": "深圳",
        "source": "zhilian",
        "url": "https://www.zhaopin.com/job_detail/example3.html",
        "apply_url": "https://www.zhaopin.com/job_detail/example3.html",
        "salary_text": "20-35K·14薪",
        "salary_min": 20000,
        "salary_max": 35000,
        "education": "本科",
        "experience": "0-1年",
        "job_type": "全职",
        "company_size": "10000人以上",
        "company_industry": "短视频/社交",
        "is_campus": False,
        "raw_description": """岗位职责：
1. 负责AI短视频创作工具的产品运营，制定运营策略提升DAU和创作量
2. 策划和执行AIGC创作者扶持计划，建设创作者社区生态
3. 联合产品和算法团队进行功能迭代，收集用户反馈推动优化
4. 制作产品教程和最佳实践案例，降低创作门槛
5. 分析竞品动态（即梦/可灵/Pika等），输出行业洞察报告

任职要求：
1. 本科及以上学历，不限专业
2. 有短视频平台运营经验或AIGC工具使用经验
3. 对AI视频生成技术有浓厚兴趣，熟悉主流AIGC工具
4. 优秀的内容策划能力，有爆款内容创作经验优先
5. 数据驱动思维，熟练使用数据分析工具
6. 有社交媒体运营经验（小红书/B站/抖音等）优先
""",
    },
]

print("\n=== 通过 /ingest 批量写入 JD ===")
# 给每个 job 加上 hash_key
for jd in JOBS:
    jd["hash_key"] = make_hash(jd["title"], jd["company"], jd["url"])

ingest_resp = api("POST", "/api/jobs/ingest", {
    "jobs": JOBS,
    "batch_id": "mock-aigc-2026",
    "source": "manual",
    "keywords": ["AIGC", "AI视频", "产品经理"],
    "location": "深圳",
})
print(f"  Created: {ingest_resp['created']}, Skipped: {ingest_resp['skipped']}")

# 获取写入的 job IDs
jobs_resp = api("GET", "/api/jobs/")
job_ids = [j["id"] for j in jobs_resp["items"]]

# 把 jobs 分拣到 picked + 分配到池
for jid in job_ids:
    api("PATCH", f"/api/jobs/{jid}", {"triage_status": "picked", "pool_id": pool["id"]})

print(f"\n✅ 插入完成! Job IDs: {job_ids}")
print(f"  Pool: {pool['name']} (ID: {pool['id']})")
