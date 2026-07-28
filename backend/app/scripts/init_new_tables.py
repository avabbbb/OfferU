"""
数据库初始化脚本：创建新表并预置简历模板
运行方式：python -m app.scripts.init_new_tables
"""

import asyncio
import sys
from pathlib import Path

# 添加项目根目录到 Python 路径
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from sqlalchemy import text
from app.database import engine, async_session
from app.models.models import Base


# =============================================
# 预置简历模板
# =============================================

BUILTIN_TEMPLATES = [
    {
        "name": "简约单栏 - ATS 友好",
        "thumbnail_url": "/templates/simple-single-column.png",
        "css_variables": {
            "primaryColor": "#2563EB",
            "accentColor": "#3B82F6",
            "textColor": "#1F2937",
            "headingColor": "#111827",
            "bodySize": "14px",
            "h1Size": "28px",
            "h2Size": "18px",
            "h3Size": "16px",
            "lineHeight": "1.6",
            "pageMargin": "20mm",
            "sectionGap": "24px",
            "fontFamily": "'PingFang SC', 'Microsoft YaHei', sans-serif",
        },
        "html_layout": """
<div class="resume-container">
    <header class="resume-header">
        <h1>{{ resume.user_name }}</h1>
        <div class="contact-info">
            {% if resume.contact_json.phone %}
            <span class="contact-item">📱 {{ resume.contact_json.phone }}</span>
            {% endif %}
            {% if resume.contact_json.email %}
            <span class="contact-item">✉️ {{ resume.contact_json.email }}</span>
            {% endif %}
            {% if resume.contact_json.github %}
            <span class="contact-item">🔗 {{ resume.contact_json.github }}</span>
            {% endif %}
        </div>
        {% if resume.summary %}
        <div class="summary">{{ resume.summary|safe }}</div>
        {% endif %}
    </header>

    {% for section in sections %}
    {% if section.visible %}
    <section class="resume-section">
        <h2 class="section-title">{{ section.title }}</h2>
        
        {% if section.section_type == 'education' %}
        <div class="education-list">
            {% for item in section.content_json %}
            <div class="education-item">
                <div class="item-header">
                    <div>
                        <div class="item-title">{{ item.school }}</div>
                        <div class="item-subtitle">{{ item.degree }} - {{ item.major }}</div>
                    </div>
                    <div class="item-date">{{ item.startDate }} - {{ item.endDate }}</div>
                </div>
                {% if item.description %}
                <div class="item-description">{{ item.description|safe }}</div>
                {% endif %}
            </div>
            {% endfor %}
        </div>
        
        {% elif section.section_type == 'experience' %}
        <div class="experience-list">
            {% for item in section.content_json %}
            <div class="experience-item">
                <div class="item-header">
                    <div>
                        <div class="item-title">{{ item.position }}</div>
                        <div class="item-subtitle">{{ item.company }}</div>
                    </div>
                    <div class="item-date">{{ item.startDate }} - {{ item.endDate }}</div>
                </div>
                {% if item.description %}
                <div class="item-description">{{ item.description|safe }}</div>
                {% endif %}
            </div>
            {% endfor %}
        </div>
        
        {% elif section.section_type == 'project' %}
        <div class="project-list">
            {% for item in section.content_json %}
            <div class="project-item">
                <div class="item-header">
                    <div>
                        <div class="item-title">{{ item.name }}</div>
                        {% if item.role %}
                        <div class="item-subtitle">{{ item.role }}</div>
                        {% endif %}
                    </div>
                    <div class="item-date">{{ item.startDate }} - {{ item.endDate }}</div>
                </div>
                {% if item.description %}
                <div class="item-description">{{ item.description|safe }}</div>
                {% endif %}
            </div>
            {% endfor %}
        </div>
        
        {% elif section.section_type == 'skill' %}
        <div class="skills-grid">
            {% for item in section.content_json %}
            <div class="skill-category">
                <div class="skill-category-name">{{ item.category }}</div>
                <div class="skill-items">{{ item.items|join(', ') }}</div>
            </div>
            {% endfor %}
        </div>
        
        {% else %}
        <div class="custom-content">
            {% for item in section.content_json %}
            {% if item.subtitle %}
            <h3>{{ item.subtitle }}</h3>
            {% endif %}
            {% if item.description %}
            <div>{{ item.description|safe }}</div>
            {% endif %}
            {% endfor %}
        </div>
        {% endif %}
    </section>
    {% endif %}
    {% endfor %}
</div>
""",
        "is_builtin": True,
    },
    {
        "name": "现代双栏 - 视觉突出",
        "thumbnail_url": "/templates/modern-two-column.png",
        "css_variables": {
            "primaryColor": "#10B981",
            "accentColor": "#34D399",
            "textColor": "#374151",
            "headingColor": "#111827",
            "bodySize": "13px",
            "h1Size": "26px",
            "h2Size": "17px",
            "h3Size": "15px",
            "lineHeight": "1.5",
            "pageMargin": "15mm",
            "sectionGap": "20px",
            "fontFamily": "'PingFang SC', 'Microsoft YaHei', sans-serif",
        },
        "html_layout": """
<style>
.resume-two-column {
    display: grid;
    grid-template-columns: 280px 1fr;
    gap: 30px;
}
.left-sidebar {
    background: #F9FAFB;
    padding: 20px;
    border-radius: 8px;
}
</style>

<div class="resume-container">
    <header class="resume-header">
        <h1>{{ resume.user_name }}</h1>
        <div class="contact-info">
            {% if resume.contact_json.email %}<span>{{ resume.contact_json.email }}</span>{% endif %}
            {% if resume.contact_json.phone %}<span>{{ resume.contact_json.phone }}</span>{% endif %}
        </div>
    </header>

    <div class="resume-two-column">
        <aside class="left-sidebar">
            {% for section in sections %}
            {% if section.visible and section.section_type in ['skill', 'custom'] %}
            <section class="sidebar-section">
                <h2 class="section-title">{{ section.title }}</h2>
                {% if section.section_type == 'skill' %}
                {% for item in section.content_json %}
                <div class="skill-block">
                    <strong>{{ item.category }}</strong>
                    <div>{{ item.items|join(', ') }}</div>
                </div>
                {% endfor %}
                {% endif %}
            </section>
            {% endif %}
            {% endfor %}
        </aside>

        <main class="main-content">
            {% for section in sections %}
            {% if section.visible and section.section_type not in ['skill'] %}
            <section class="resume-section">
                <h2 class="section-title">{{ section.title }}</h2>
                {% if section.section_type == 'experience' %}
                {% for item in section.content_json %}
                <div class="experience-item">
                    <div class="item-header">
                        <div>
                            <div class="item-title">{{ item.position }}</div>
                            <div class="item-subtitle">{{ item.company }}</div>
                        </div>
                        <div class="item-date">{{ item.startDate }} - {{ item.endDate }}</div>
                    </div>
                    <div class="item-description">{{ item.description|safe }}</div>
                </div>
                {% endfor %}
                {% endif %}
            </section>
            {% endif %}
            {% endfor %}
        </main>
    </div>
</div>
""",
        "is_builtin": True,
    },
    {
        "name": "极简黑白 - 专业干练",
        "thumbnail_url": "/templates/minimal-bw.png",
        "css_variables": {
            "primaryColor": "#000000",
            "accentColor": "#4B5563",
            "textColor": "#1F2937",
            "headingColor": "#000000",
            "bodySize": "14px",
            "h1Size": "32px",
            "h2Size": "16px",
            "h3Size": "14px",
            "lineHeight": "1.7",
            "pageMargin": "25mm",
            "sectionGap": "28px",
            "fontFamily": "'PingFang SC', 'Helvetica Neue', Arial, sans-serif",
        },
        "html_layout": """
<style>
.minimal-header h1 {
    font-weight: 300;
    letter-spacing: 0.5px;
}
.minimal-section-title {
    text-transform: uppercase;
    font-size: 12px;
    letter-spacing: 2px;
    font-weight: 600;
    border-bottom: 1px solid #000;
    padding-bottom: 8px;
    margin-bottom: 16px;
}
</style>

<div class="resume-container">
    <header class="minimal-header">
        <h1>{{ resume.user_name }}</h1>
        <div class="contact-info">
            {% if resume.contact_json.email %}{{ resume.contact_json.email }}{% endif %}
            {% if resume.contact_json.phone %} | {{ resume.contact_json.phone }}{% endif %}
        </div>
    </header>

    {% for section in sections %}
    {% if section.visible %}
    <section class="resume-section">
        <h2 class="minimal-section-title">{{ section.title }}</h2>
        
        {% if section.section_type == 'experience' %}
        {% for item in section.content_json %}
        <div class="experience-item">
            <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
                <strong>{{ item.position }}</strong>
                <span style="color: #6B7280;">{{ item.startDate }} - {{ item.endDate }}</span>
            </div>
            <div style="color: #6B7280; margin-bottom: 8px;">{{ item.company }}</div>
            <div class="item-description">{{ item.description|safe }}</div>
        </div>
        {% endfor %}
        {% endif %}
    </section>
    {% endif %}
    {% endfor %}
</div>
""",
        "is_builtin": True,
    },
]


async def init_tables():
    """创建新表"""
    async with engine.begin() as conn:
        # 创建新表
        print("创建新表...")
        await conn.run_sync(Base.metadata.create_all)
        print("[OK] 表创建成功")


async def insert_builtin_templates():
    """插入预置模板"""
    from app.models.models import ResumeTemplate
    from sqlalchemy import select
    import json
    
    async with async_session() as session:
        print("\n插入预置模板...")
        
        for template in BUILTIN_TEMPLATES:
            # 检查是否已存在
            result = await session.execute(
                select(ResumeTemplate).where(ResumeTemplate.name == template["name"])
            )
            existing = result.scalar_one_or_none()
            
            if existing:
                print(f"  [SKIP] 跳过已存在的模板: {template['name']}")
                continue
            
            # 插入新模板
            new_template = ResumeTemplate(
                name=template["name"],
                thumbnail_url=template["thumbnail_url"],
                css_variables=template["css_variables"],
                html_layout=template["html_layout"],
                is_builtin=template["is_builtin"],
            )
            session.add(new_template)
            print(f"  [OK] 插入模板: {template['name']}")
        
        await session.commit()
        print("[OK] 所有模板插入完成")


async def main():
    """主函数"""
    print("=" * 60)
    print("OfferU 数据库初始化")
    print("=" * 60)
    
    try:
        await init_tables()
        await insert_builtin_templates()
        
        print("\n" + "=" * 60)
        print("[SUCCESS] 初始化完成！")
        print("=" * 60)
        
    except Exception as e:
        print(f"\n[ERROR] 初始化失败: {e}")
        import traceback
        traceback.print_exc()
        return 1
    
    return 0


if __name__ == "__main__":
    exit_code = asyncio.run(main())
    sys.exit(exit_code)
