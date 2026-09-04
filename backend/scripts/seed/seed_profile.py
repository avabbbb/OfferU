"""
用匿名示例候选人的信息填充 Profile，通过 HTTP API 调用后端。
"""
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

# ======== 1. 更新 Profile 基本信息 ========
print("=== 1. 更新 Profile 基本信息 ===")
profile = api("PUT", "/api/profile/", {
    "name": "示例候选人",
    "headline": "示例大学 · 软件工程 · AI应用研发候选人",
    "exit_story": "有 AI 应用与内容自动化项目经验，希望加入成长型团队，继续做面向真实业务的 AI 产品与工程落地。",
    "cross_cutting_advantage": "软件工程背景 + AI 工作流实践 + 内容运营经验 + 项目交付协作能力",
    "base_info_json": {
        "full_name": "示例候选人",
        "phone": "13800000000",
        "email": "demo@example.com",
        "birth_date": "2000-01",
        "gender": "male",
        "location": "广东省广州市",
        "current_status": "求职中",
        "education_level": "本科",
        "university": "示例大学",
        "major": "软件工程",
        "gpa": "3.7",
        "english_level": "CET-6"
    },
})
print(f"  Profile ID: {profile['id']}, Name: {profile['name']}")

# ======== 2. 添加目标岗位 ========
print("\n=== 2. 添加目标岗位 ===")
roles = [
    {"role_name": "AIGC产品经理", "role_level": "初级", "fit": "primary"},
    {"role_name": "AI应用研发工程师", "role_level": "初级", "fit": "primary"},
    {"role_name": "视频技术产品经理", "role_level": "初级", "fit": "secondary"},
]
for r in roles:
    resp = api("POST", "/api/profile/target-roles", r)
    print(f"  Created role: {resp['role_name']} ({resp['fit']})")

# ======== 3. 添加教育经历 ========
print("\n=== 3. 添加教育经历 ===")
api("POST", "/api/profile/sections", {
    "section_type": "education",
    "title": "示例大学 - 软件工程（全日制本科）",
    "sort_order": 1,
    "content_json": {
        "field_values": {
            "school": "示例大学",
            "degree": "本科",
            "major": "软件工程",
            "start_date": "2021-09",
            "end_date": "2025-06",
            "gpa": "3.7",
            "tags": ["全日制", "软件工程"],
            "highlights": "具备良好的项目实践与团队协作基础"
        }
    },
    "source": "manual",
    "confidence": 1.0,
})
print("  Education added")

# ======== 4. 添加工作经历 ========
print("\n=== 4. 添加工作经历 ===")
api("POST", "/api/profile/sections", {
    "section_type": "experience",
    "title": "示例科技公司 - AI应用研发实习生",
    "sort_order": 2,
    "content_json": {
        "field_values": {
            "company": "示例科技公司",
            "position": "AI应用研发实习生",
            "start_date": "2024-07",
            "end_date": "2024-12",
            "entry_method": "实习",
            "department": "AI应用团队",
            "bullets": [
                "参与 AI 内容生成平台后端开发，协助完成接口设计与任务编排",
                "优化工作流执行链路，缩短批处理耗时并提升稳定性",
                "支持 Demo 级 AI 视频方案验证，配合产品与设计完成多轮迭代",
                "整理项目交付流程与技术文档，降低团队复用成本",
            ]
        }
    },
    "source": "manual",
    "confidence": 1.0,
})
print("  Experience added")

# ======== 5. 添加技术方案项目 ========
print("\n=== 5. 添加AI视频解决方案项目 ===")
api("POST", "/api/profile/sections", {
    "section_type": "project",
    "title": "AI视频生成工作流方案",
    "sort_order": 3,
    "content_json": {
        "field_values": {
            "project_name": "AI视频生成工作流方案",
            "role": "项目负责人",
            "start_date": "2024-10",
            "end_date": "2025-02",
            "bullets": [
                "设计分层 AI 视频生成流程，串联素材生成、动作控制与内容校验",
                "沉淀可复用提示词模板与工作流节点配置，提升生成一致性",
                "基于反馈持续迭代参数与流程，减少重复试错成本",
                "将 Demo 交付周期从多周压缩到数天，提高内部验证效率",
            ]
        }
    },
    "source": "manual",
    "confidence": 1.0,
})
print("  Project added")

# ======== 6. 添加个人项目 - AI短剧SaaS ========
print("\n=== 6. 添加AI短剧SaaS平台项目 ===")
api("POST", "/api/profile/sections", {
    "section_type": "project",
    "title": "AI创作工具平台（个人探索项目）",
    "sort_order": 4,
    "content_json": {
        "field_values": {
            "project_name": "AI创作工具平台",
            "role": "产品设计者 & 技术架构设计",
            "bullets": [
                "围绕 AI 创作门槛高与二次编辑困难的问题，设计工作台型 SaaS 方案",
                "规划剧情白板、工作流模板与素材复用机制，降低创作试错成本",
                "将复杂生成流程拆成可视化模块，提升非技术用户可操作性",
                "设计创作者模板共享机制，促进内容复用与经验沉淀",
            ]
        }
    },
    "source": "manual",
    "confidence": 1.0,
})
print("  Side project added")

# ======== 7. 添加技能 ========
print("\n=== 7. 添加技能 ===")
api("POST", "/api/profile/sections", {
    "section_type": "skill",
    "title": "专业技能",
    "sort_order": 5,
    "content_json": {
        "field_values": {
            "skills": [
                {"name": "ComfyUI工作流", "level": "熟练", "category": "AIGC"},
                {"name": "Dify智能体编排", "level": "熟练", "category": "AI"},
                {"name": "Cursor Vibe Coding", "level": "熟练", "category": "开发"},
                {"name": "LLM/MCP/Skill应用", "level": "熟悉", "category": "AI"},
                {"name": "Prompt Engineering", "level": "丰富经验", "category": "AI"},
                {"name": "剪映/Photoshop", "level": "熟练", "category": "创作"},
                {"name": "产品需求文档(PRD)", "level": "良好", "category": "产品"},
                {"name": "WAN/Veo/MidJourney", "level": "熟练", "category": "AIGC"},
            ],
            "achievements": [
                "具备 AI 内容生产与分发的实操经验",
                "能够独立完成从需求梳理到项目交付的闭环推进",
                "有跨产品、研发、内容协作的项目经历",
            ]
        }
    },
    "source": "manual",
    "confidence": 1.0,
})
print("  Skills added")

# ======== 验证 ========
print("\n=== 验证 Profile 完整性 ===")
full = api("GET", "/api/profile/")
print(f"  Name: {full['name']}")
print(f"  Headline: {full['headline']}")
print(f"  Target Roles: {len(full.get('target_roles', []))}")
print(f"  Sections: {len(full.get('sections', []))}")
for s in full.get("sections", []):
    print(f"    - [{s['section_type']}] {s['title']}")

print("\n✅ Profile 创建完成!")
