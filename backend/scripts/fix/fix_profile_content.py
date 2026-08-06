"""
修复 profile sections 的 content_json
使用 PUT /api/profile/sections/{id} 更新，
content_json 的值放在 root level 使 _pick_value 通过 alias 匹配
"""
import json
import urllib.request

BASE = "http://localhost:8765"

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


# Section 1: education (id=1)
print("=== 修复 Section 1: 教育经历 ===")
api("PUT", "/api/profile/sections/1", {
    "content_json": {
        "school": "华南师范大学",
        "degree": "本科",
        "major": "软件工程",
        "start_date": "2021-09",
        "end_date": "2025-06",
        "gpa": "3.8",
        "description": "全日制本科，211/双一流高校。大学英语六级532分。",
        "bullet": "华南师范大学 | 软件工程（本科）| 2021.09-2025.06 | 大学英语六级532分",
    },
})
print("  ✅ 教育经历 updated")

# Section 2: experience (id=2)
print("=== 修复 Section 2: 工作经历 ===")
exp_bullets = [
    "40+员工绩效考核中获最高等级（Top 2），入职不到半年成为多个项目骨干技术人员",
    "独立负责佛山某电视台主持人AIGC数字人项目，中途接手并成功交付，获甲方好评",
    "作为技术负责人主导公司年会领导宣传片AI视频项目（3分钟古装短片），年会播出引起巨大反响，被邀请到广东省公司交流",
    "宣传片现于佛山公司大堂每日循环播放，各兄弟单位交流频繁，为此总结技术规范流程形成标准解决方案",
    "利用春节假期完成公司电话彩铃AI视频项目，配合总公司要求",
    "受邀为佛山某镇制作文化旅游宣传AI视频短片，运用自研解决方案一周内交付",
]
api("PUT", "/api/profile/sections/2", {
    "content_json": {
        "company": "中国电信股份有限公司佛山分公司",
        "position": "云中台软研中心研发工程师",
        "start_date": "2025-07",
        "end_date": "至今",
        "description": "\n".join(f"• {b}" for b in exp_bullets),
        "bullet": "中国电信佛山 | 云中台软研中心研发工程师 | 2025.07至今 | 绩效Top2，主导AIGC数字人/AI视频等多个项目交付",
    },
})
print("  ✅ 工作经历 updated")

# Section 3: project (id=3)
print("=== 修复 Section 3: AI视频解决方案项目 ===")
proj1_bullets = [
    "设计「L1资产增强-L2动作迁移-L3首尾衔接」分层技术栈，摒弃单一模型依赖",
    "L1层：MidJourney出图 + Nano Banana Pro二次编辑，建立可复用数字人资产库",
    "L2层：Wan Animate + Scail骨架驱动与动作迁移，实现素人到专业动作的精准映射",
    "L3层：Wan 2.2+Qwen3 + Google Veo3生成超现实场景，首尾帧技术控制时空连贯性",
    "RLHF思维迭代：基于反馈调整负向提示词和工作流，修正AI幻觉行为，实现高人物一致性",
    "将3分钟AI视频制作周期从数周压缩到1周（含前期影像采集和后期剪辑）",
]
api("PUT", "/api/profile/sections/3", {
    "content_json": {
        "name": "企业级AI视频制作解决方案",
        "role": "技术负责人 & 项目执行人",
        "start_date": "2025-11",
        "end_date": "至今",
        "description": "\n".join(f"• {b}" for b in proj1_bullets),
        "bullet": "企业级AI视频方案 | 技术负责人 | L1-L2-L3分层技术栈 | 3分钟视频制作周期从数周压缩到1周",
    },
})
print("  ✅ AI视频方案 updated")

# Section 4: project (id=4)
print("=== 修复 Section 4: AI短剧SaaS ===")
proj2_bullets = [
    "针对AI短剧赛道「门槛高」与「二次编辑难」的痛点，设计垂直SaaS平台方案",
    "创新设计「一键图层拆分」的剧情白板，将生成画面自动解构为人物/背景/道具独立图层",
    "支持用户像拼积木一样拖拽替换，将单镜头修改从「抽卡半小时」降低至「拖拽3秒」",
    "设计「制作流封装」共享交易社区：创作者打包提示词+参数+图层逻辑为「剧情模版」流通",
    "生态策略：大神造模版 + 小白用模版的共生生态，抹平技术鸿沟",
]
api("PUT", "/api/profile/sections/4", {
    "content_json": {
        "name": "AI短剧垂直创作SaaS平台",
        "role": "产品设计者 & 技术架构师",
        "description": "\n".join(f"• {b}" for b in proj2_bullets),
        "bullet": "AI短剧SaaS | 产品+技术 | 一键图层拆分+剧情白板 | 单镜头修改从30min降至3秒",
    },
})
print("  ✅ AI短剧SaaS updated")

# Section 5: skill (id=5)
print("=== 修复 Section 5: 技能 ===")
skill_items = [
    "ComfyUI工作流", "Dify智能体编排", "Cursor Vibe Coding",
    "LLM/MCP/Skill应用", "Prompt Engineering",
    "剪映/Photoshop", "产品需求文档(PRD)",
    "WAN/Veo/MidJourney",
]
api("PUT", "/api/profile/sections/5", {
    "content_json": {
        "category": "核心技能",
        "items": skill_items,
        "bullet": "、".join(skill_items),
    },
})
print("  ✅ 技能 updated")

# 验证
print("\n=== 验证修复结果 ===")
profile = api("GET", "/api/profile/")
for s in profile.get("sections", []):
    cj = s.get("content_json", {})
    bullet = cj.get("bullet", "")
    normalized = cj.get("normalized", {})
    has_content = any(v for v in normalized.values() if v)
    status = "✅" if has_content else "❌ STILL EMPTY"
    print(f"  [{s['section_type']}] {s['title']}")
    print(f"    bullet: {bullet[:80]}{'...' if len(bullet) > 80 else ''}")
    print(f"    normalized filled: {status}")

print("\n✅ 修复完成")
