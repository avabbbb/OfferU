# =============================================
# PDF 导出服务 - Playwright 高质量渲染
# =============================================
# 使用 Playwright + Chromium 渲染简历为 ATS 友好的 PDF
# 相比浏览器端 html2canvas，这种方式生成的是真实文本 PDF，
# 支持文本复制、搜索，且对 ATS 系统更友好。
# =============================================

import os
import tempfile
from pathlib import Path
from typing import Optional

from playwright.async_api import async_playwright


async def export_resume_to_pdf(
    resume_html: str,
    output_path: Optional[str] = None,
    page_size: str = "A4",
    margin: dict = None,
    print_background: bool = True,
) -> bytes:
    """
    使用 Playwright 将简历 HTML 渲染为 PDF
    
    参数:
        resume_html: 完整的 HTML 内容（包含样式）
        output_path: 输出文件路径，如果为 None 则只返回字节流
        page_size: 页面大小，默认 "A4"
        margin: 页边距，如 {"top": "0.5cm", "bottom": "0.5cm", "left": "1cm", "right": "1cm"}
        print_background: 是否打印背景色
    
    返回:
        PDF 文件的字节流
    """
    if margin is None:
        margin = {
            "top": "0.5cm",
            "bottom": "0.5cm",
            "left": "1cm",
            "right": "1cm"
        }

    async with async_playwright() as p:
        # 启动 Chromium 浏览器（headless 模式）
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page()

        # 设置视口大小（A4 纸张宽度约 794px）
        await page.set_viewport_size({"width": 794, "height": 1123})

        # 将 HTML 内容写入临时文件（避免 data URI 长度限制）
        with tempfile.NamedTemporaryFile(mode='w', suffix='.html', delete=False, encoding='utf-8') as f:
            f.write(resume_html)
            temp_html_path = f.name

        try:
            # 加载 HTML 文件
            await page.goto(f"file://{temp_html_path}", wait_until="networkidle")

            # 等待字体加载和渲染完成
            await page.wait_for_timeout(500)

            # 生成 PDF
            pdf_bytes = await page.pdf(
                format=page_size,
                print_background=print_background,
                margin=margin,
                prefer_css_page_size=False,
            )

            # 如果指定了输出路径，保存到文件
            if output_path:
                output_path = Path(output_path)
                output_path.parent.mkdir(parents=True, exist_ok=True)
                with open(output_path, 'wb') as f:
                    f.write(pdf_bytes)

            return pdf_bytes

        finally:
            # 清理临时文件
            await browser.close()
            if os.path.exists(temp_html_path):
                os.unlink(temp_html_path)


async def render_resume_html(
    resume_data: dict,
    sections_data: list[dict],
    template_html: str,
    template_css_vars: dict,
    style_overrides: dict = None,
) -> str:
    """
    将简历数据渲染为完整的 HTML
    
    参数:
        resume_data: 简历主信息字典
        sections_data: 简历段落列表
        template_html: Jinja2 模板 HTML
        template_css_vars: 模板的 CSS 变量
        style_overrides: 用户的样式覆盖
    
    返回:
        完整的 HTML 字符串
    """
    from jinja2 import Template

    # 合并 CSS 变量（用户覆盖优先）
    final_css_vars = {**template_css_vars, **(style_overrides or {})}

    # 生成 CSS 变量字符串
    css_vars_str = "\n".join([
        f"  --{key}: {value};"
        for key, value in final_css_vars.items()
    ])

    # 渲染模板
    template = Template(template_html)
    body_html = template.render(
        resume=resume_data,
        sections=sections_data
    )

    # 构建完整 HTML
    full_html = f"""
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{resume_data.get('title', '简历')}</title>
    <style>
        :root {{
{css_vars_str}
        }}
        
        * {{
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }}
        
        body {{
            font-family: var(--fontFamily, 'PingFang SC', 'Microsoft YaHei', sans-serif);
            font-size: var(--bodySize, 14px);
            line-height: var(--lineHeight, 1.6);
            color: var(--textColor, #333);
            background: #fff;
            padding: var(--pageMargin, 20mm);
        }}
        
        h1, h2, h3, h4, h5, h6 {{
            font-weight: 600;
            color: var(--headingColor, #000);
        }}
        
        h1 {{
            font-size: var(--h1Size, 24px);
            margin-bottom: 8px;
        }}
        
        h2 {{
            font-size: var(--h2Size, 20px);
            margin-bottom: 12px;
            padding-bottom: 4px;
            border-bottom: 2px solid var(--primaryColor, #3B82F6);
        }}
        
        h3 {{
            font-size: var(--h3Size, 16px);
            margin-bottom: 8px;
        }}
        
        section {{
            margin-bottom: var(--sectionGap, 20px);
        }}
        
        .contact-info {{
            display: flex;
            flex-wrap: wrap;
            gap: 12px;
            margin-bottom: 16px;
            font-size: 13px;
            color: #666;
        }}
        
        .contact-item {{
            display: flex;
            align-items: center;
            gap: 4px;
        }}
        
        .section-title {{
            color: var(--primaryColor, #3B82F6);
            font-weight: 600;
            font-size: var(--h2Size, 18px);
            margin-bottom: 12px;
            padding-bottom: 4px;
            border-bottom: 2px solid var(--primaryColor, #3B82F6);
        }}
        
        .experience-item, .education-item, .project-item {{
            margin-bottom: 16px;
            page-break-inside: avoid;
        }}
        
        .item-header {{
            display: flex;
            justify-content: space-between;
            align-items: baseline;
            margin-bottom: 4px;
        }}
        
        .item-title {{
            font-weight: 600;
            font-size: 15px;
            color: #000;
        }}
        
        .item-subtitle {{
            color: #666;
            font-size: 13px;
        }}
        
        .item-date {{
            font-size: 13px;
            color: #888;
            white-space: nowrap;
        }}
        
        .item-description {{
            margin-top: 6px;
            line-height: 1.7;
        }}
        
        .item-description ul {{
            list-style: none;
            padding-left: 0;
        }}
        
        .item-description li {{
            position: relative;
            padding-left: 18px;
            margin-bottom: 4px;
        }}
        
        .item-description li:before {{
            content: "•";
            position: absolute;
            left: 6px;
            color: var(--primaryColor, #3B82F6);
            font-weight: bold;
        }}
        
        .skills-grid {{
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 12px;
        }}
        
        .skill-category {{
            margin-bottom: 8px;
        }}
        
        .skill-category-name {{
            font-weight: 600;
            color: var(--primaryColor, #3B82F6);
            margin-bottom: 4px;
        }}
        
        .skill-items {{
            color: #666;
        }}
        
        @media print {{
            body {{
                margin: 0;
                padding: var(--pageMargin, 20mm);
            }}
            
            section {{
                page-break-inside: avoid;
            }}
        }}
    </style>
</head>
<body>
{body_html}
</body>
</html>
"""
    return full_html
