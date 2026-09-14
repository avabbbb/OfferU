"""生成 HTML 简历模板的预览图。

template_seeder 声明的 preview_image=/templates/*.png 需要真实图片资产，
放在 runtime_uploads_dir("templates")（开发态即 backend/uploads/templates/）。
本脚本用与 Resume PDF 相同的管理型 Chromium（headless）渲染模板 HTML 并截图，
产出的预览图与模板真实样式一致，而不是手绘占位图。

用法（在 backend 目录下）：
    .venv312\\Scripts\\python.exe scripts\\seed\\generate_template_previews.py
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(BACKEND_DIR))

from jinja2 import Template  # noqa: E402
from playwright.async_api import async_playwright  # noqa: E402
from sqlalchemy import select  # noqa: E402

from app.database import async_session  # noqa: E402
from app.models.html_resume import HtmlResumeTemplate  # noqa: E402
from app.runtime_paths import runtime_uploads_dir  # noqa: E402

# 预览图按缩略图比例截取模板顶部区域（A4 宽 794px 等比）。
VIEWPORT_WIDTH = 794
VIEWPORT_HEIGHT = 1123
THUMBNAIL_HEIGHT = 620
# sections 必须是模板契约的形状（theme + bullets[].content），与
# generate_html_resume 的输出保持一致，否则模板只会渲染出空壳段落。
# 全部为示例文案，不含任何真实候选人数据。
SAMPLE_PROFILE = {
    "name": "示例候选人",
    "email": "candidate@example.com",
    "phone": "138-0000-0000",
    "location": "深圳",
    "summary": "示例摘要：仅用于渲染模板预览图，不代表真实候选人数据。",
    "sections": [
        {
            "section_type": "workExperiences",
            "theme": "工作经历",
            "bullets": [
                {"content": "示例科技有限公司 · 后端工程师 · 2023.06 - 至今"},
                {"content": "负责示例服务的接口设计与性能优化，压测 QPS 提升约 40%。"},
            ],
            "sort_order": 0,
        },
        {
            "section_type": "projects",
            "theme": "项目经历",
            "bullets": [
                {"content": "示例数据平台 · 核心开发"},
                {"content": "搭建示例数据管道，覆盖离线与在线两条链路。"},
            ],
            "sort_order": 1,
        },
        {
            "section_type": "education",
            "theme": "教育经历",
            "bullets": [{"content": "示例大学 · 计算机科学与技术 · 本科"}],
            "sort_order": 2,
        },
        {
            "section_type": "skills",
            "theme": "技能清单",
            "bullets": [{"content": "Python / Go / PostgreSQL / Redis"}],
            "sort_order": 3,
        },
    ],
    "target_roles": ["后端工程师"],
}


async def main() -> int:
    out_dir = runtime_uploads_dir("templates")
    out_dir.mkdir(parents=True, exist_ok=True)

    async with async_session() as db:
        templates = (await db.execute(select(HtmlResumeTemplate))).scalars().all()
        # 模板在会话结束后仍要被渲染，先把需要的字段取出来。
        payloads = [
            (tpl.name, tpl.preview_image, tpl.html_template or "", tpl.design_tokens or {})
            for tpl in templates
        ]

    if not payloads:
        print("数据库里没有 HTML 简历模板，先运行应用完成 seed。")
        return 1

    written: list[Path] = []
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        try:
            page = await browser.new_page(
                viewport={"width": VIEWPORT_WIDTH, "height": VIEWPORT_HEIGHT}
            )
            for name, preview_image, html_template, design_tokens in payloads:
                if not preview_image:
                    print(f"[skip] {name}: preview_image 为空")
                    continue
                target = out_dir / Path(preview_image).name
                html = Template(html_template).render(
                    profile=SAMPLE_PROFILE,
                    design_tokens=design_tokens,
                )
                await page.set_viewport_size(
                    {"width": VIEWPORT_WIDTH, "height": VIEWPORT_HEIGHT}
                )
                await page.set_content(html, wait_until="load")
                await page.screenshot(
                    path=str(target),
                    clip={
                        "x": 0,
                        "y": 0,
                        "width": VIEWPORT_WIDTH,
                        "height": THUMBNAIL_HEIGHT,
                    },
                )
                written.append(target)
                print(f"[ok] {name} -> {target}")
        finally:
            await browser.close()

    print(f"完成，共写入 {len(written)} 张预览图。")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
