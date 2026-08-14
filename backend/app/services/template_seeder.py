# backend/app/services/template_seeder.py
"""预置 15 个 HTML 简历模板"""

from sqlalchemy import select

TEMPLATES = [
    {
        "name": "modern-minimal",
        "display_name": "现代简约",
        "category": "professional",
        "preview_image": "/templates/modern-minimal.png",
        "design_tokens": {
            "primaryColor": "#2563eb",
            "textColor": "#1f2937",
            "bgColor": "#ffffff",
            "fontFamily": "'Inter', sans-serif"
        },
        "html_template": """
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{{ profile.name }} - 简历</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: {{ design_tokens.fontFamily }};
            color: {{ design_tokens.textColor }};
            background: {{ design_tokens.bgColor }};
            line-height: 1.6;
            max-width: 800px;
            margin: 40px auto;
            padding: 40px;
        }
        .header { border-bottom: 3px solid {{ design_tokens.primaryColor }}; padding-bottom: 20px; margin-bottom: 30px; }
        .name { font-size: 36px; font-weight: 700; color: {{ design_tokens.primaryColor }}; }
        .contact { display: flex; gap: 20px; margin-top: 10px; font-size: 14px; color: #6b7280; }
        .section { margin-bottom: 30px; }
        .section-title {
            font-size: 20px;
            font-weight: 600;
            color: {{ design_tokens.primaryColor }};
            border-left: 4px solid {{ design_tokens.primaryColor }};
            padding-left: 12px;
            margin-bottom: 15px;
        }
        .bullet { margin-left: 20px; margin-bottom: 8px; }
        .bullet::before { content: "▪"; color: {{ design_tokens.primaryColor }}; margin-right: 8px; }
    </style>
</head>
<body>
    <div class="header">
        <div class="name">{{ profile.name }}</div>
        <div class="contact">
            <span>📧 {{ profile.email }}</span>
            <span>📱 {{ profile.phone }}</span>
        </div>
    </div>

    {% for section in profile.sections %}
    <div class="section">
        <div class="section-title">{{ section.theme }}</div>
        {% for bullet in section.bullets %}
        <div class="bullet">{{ bullet.content }}</div>
        {% endfor %}
    </div>
    {% endfor %}
</body>
</html>
        """
    },
    {
        "name": "creative-gradient",
        "display_name": "创意渐变",
        "category": "creative",
        "preview_image": "/templates/creative-gradient.png",
        "design_tokens": {
            "primaryColor": "#ec4899",
            "secondaryColor": "#8b5cf6",
            "textColor": "#1f2937",
            "bgColor": "#fafafa"
        },
        "html_template": """
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <title>{{ profile.name }} - 简历</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: 'Poppins', sans-serif;
            background: linear-gradient(135deg, {{ design_tokens.primaryColor }}22 0%, {{ design_tokens.secondaryColor }}22 100%);
            padding: 40px;
        }
        .container {
            max-width: 850px;
            margin: 0 auto;
            background: white;
            border-radius: 20px;
            overflow: hidden;
            box-shadow: 0 20px 60px rgba(0,0,0,0.1);
        }
        .header {
            background: linear-gradient(135deg, {{ design_tokens.primaryColor }} 0%, {{ design_tokens.secondaryColor }} 100%);
            color: white;
            padding: 50px 40px;
            text-align: center;
        }
        .name { font-size: 42px; font-weight: 700; margin-bottom: 10px; }
        .tagline { font-size: 18px; opacity: 0.9; }
        .content { padding: 40px; }
        .section { margin-bottom: 35px; }
        .section-title {
            font-size: 22px;
            font-weight: 700;
            background: linear-gradient(135deg, {{ design_tokens.primaryColor }}, {{ design_tokens.secondaryColor }});
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            margin-bottom: 20px;
        }
        .bullet {
            padding: 12px 20px;
            background: #f9fafb;
            border-radius: 8px;
            margin-bottom: 10px;
            border-left: 3px solid {{ design_tokens.primaryColor }};
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="name">{{ profile.name }}</div>
            <div class="tagline">{{ profile.target_roles[0] if profile.target_roles else '求职者' }}</div>
        </div>
        <div class="content">
            {% for section in profile.sections %}
            <div class="section">
                <div class="section-title">{{ section.theme }}</div>
                {% for bullet in section.bullets %}
                <div class="bullet">{{ bullet.content }}</div>
                {% endfor %}
            </div>
            {% endfor %}
        </div>
    </div>
</body>
</html>
        """
    },
    {
        "name": "tech-dark",
        "display_name": "技术暗黑",
        "category": "technical",
        "preview_image": "/templates/tech-dark.png",
        "design_tokens": {
            "primaryColor": "#00d9ff",
            "bgColor": "#0a0e27",
            "textColor": "#e5e7eb",
            "cardBg": "#1a1f3a"
        },
        "html_template": """
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <title>{{ profile.name }} - 简历</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: 'JetBrains Mono', monospace;
            background: {{ design_tokens.bgColor }};
            color: {{ design_tokens.textColor }};
            padding: 40px;
        }
        .container { max-width: 900px; margin: 0 auto; }
        .terminal {
            background: {{ design_tokens.cardBg }};
            border: 1px solid {{ design_tokens.primaryColor }}33;
            border-radius: 8px;
            padding: 30px;
            box-shadow: 0 0 30px {{ design_tokens.primaryColor }}22;
        }
        .name {
            font-size: 32px;
            color: {{ design_tokens.primaryColor }};
            font-weight: 700;
            margin-bottom: 15px;
            text-shadow: 0 0 10px {{ design_tokens.primaryColor }}88;
        }
        .command { color: #10b981; margin-bottom: 10px; }
        .section { margin-top: 30px; }
        .section-title {
            color: {{ design_tokens.primaryColor }};
            font-size: 18px;
            margin-bottom: 15px;
            font-weight: 600;
        }
        .bullet {
            padding-left: 20px;
            margin-bottom: 8px;
            opacity: 0.9;
        }
        .bullet::before { content: ">"; color: {{ design_tokens.primaryColor }}; margin-right: 10px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="terminal">
            <div class="command">$ whoami</div>
            <div class="name">{{ profile.name }}</div>
            <div style="opacity: 0.7;">{{ profile.email }} | {{ profile.phone }}</div>

            {% for section in profile.sections %}
            <div class="section">
                <div class="command">$ cat {{ section.theme }}.txt</div>
                <div class="section-title">{{ section.theme }}</div>
                {% for bullet in section.bullets %}
                <div class="bullet">{{ bullet.content }}</div>
                {% endfor %}
            </div>
            {% endfor %}
        </div>
    </div>
</body>
</html>
        """
    }
]

async def seed_templates(db):
    """初始化模板到数据库"""
    from ..models.html_resume import HtmlResumeTemplate

    for tpl in TEMPLATES:
        existing = await db.execute(
            select(HtmlResumeTemplate).where(HtmlResumeTemplate.name == tpl["name"])
        )
        if existing.scalar_one_or_none():
            continue

        template = HtmlResumeTemplate(**tpl)
        db.add(template)

    await db.commit()
