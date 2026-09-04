# =============================================
# Skills Pipeline 调度器
# =============================================
# 编排多个 Skill 按顺序执行，实现模块化 AI 简历优化
#
# 工作流:
#   1. 前端发起请求 → Pipeline.run()
#   2. 入口处统一 PII 脱敏（云端 LLM 时）
#   3. 依次执行注册的 Skill，前一步输出自动注入后一步 context
#   4. 出口处统一还原 PII
#   5. 返回聚合结果给前端
#
# 用法:
#   pipeline = SkillPipeline()
#   result = await pipeline.run(resume_text, resume_data, jd_text)
# =============================================

from __future__ import annotations

from typing import Optional, Callable, Awaitable

from app.agents.desensitize import desensitize, restore
from app.agents.skills.base import BaseSkill
from app.agents.skills.jd_analyzer import JDAnalyzerSkill
from app.agents.skills.resume_matcher import ResumeMatcherSkill
from app.agents.skills.content_rewriter import ContentRewriterSkill
from app.agents.skills.humanizer import HumanizerSkill
from app.agents.skills.section_reorder import SectionReorderSkill
from app.config import get_settings
from app.services.security_redaction import safe_error_message

import json


class SkillPipeline:
    """
    Skill 编排管道 — 按序执行注册的 Skill

    每个 Skill 的输出会合并到 context dict 中，
    作为下一个 Skill 的输入。
    """

    def __init__(self):
        # 按顺序注册 Skill（顺序即执行顺序）
        self._skills: list[BaseSkill] = [
            JDAnalyzerSkill(),
            ResumeMatcherSkill(),
            ContentRewriterSkill(),
            HumanizerSkill(),
            SectionReorderSkill(),
        ]

    _PROGRESS_LABELS: dict[str, str] = {
        "jd_analysis": "正在解析 JD 要求...",
        "match_analysis": "JD 解析完成，正在匹配简历...",
        "content_rewrite": "匹配完成，正在生成改写建议...",
        "humanizer": "正在去除 AI 痕迹...",
        "section_reorder": "正在优化章节排序...",
    }

    async def run(
        self,
        resume_text: str,
        resume_data: Optional[dict],
        jd_text: str,
        research_context: Optional[dict] = None,
        on_progress: Optional[Callable[[str, str], Awaitable[None]]] = None,
    ) -> dict:
        """
        执行完整的分析 Pipeline

        参数:
          resume_text: 简历文本
          resume_data: 简历结构化 JSON（可选）
          jd_text: 目标岗位描述全文
          research_context: 带引用的岗位调研策略；只能影响表达，不能成为候选人事实
          on_progress: 可选进度回调 async fn(skill_name, label)

        返回: 聚合的分析结果
        """
        # 截断过长内容防止 token 爆炸
        resume_safe = resume_text[:12000]
        jd_safe = jd_text[:6000]

        # 云端 Provider 自动脱敏 PII
        pii_mapping: dict = {}
        settings = get_settings()
        if settings.llm_provider != "ollama":
            resume_safe, pii_mapping = desensitize(resume_safe)

        # 构建初始 context
        context: dict = {
            "resume_text": resume_safe,
            "resume_data": resume_data,
            "jd_text": jd_safe,
            "research_context": research_context or {},
            "interview_questions": (
                (research_context or {}).get("interview_questions") or []
            ),
        }

        # 依次执行每个 Skill
        for skill in self._skills:
            label = self._PROGRESS_LABELS.get(skill.name, f"正在执行 {skill.name}...")
            if on_progress:
                await on_progress(skill.name, label)
            try:
                output = await skill.execute(context)
                if output:
                    context[skill.name] = output
            except Exception as e:
                context[skill.name] = {"error": safe_error_message(e)}

        # 从 context 中提取结果（移除原始输入）
        result = {
            k: v for k, v in context.items()
            if k not in (
                "resume_text",
                "resume_data",
                "jd_text",
                "research_context",
                "interview_questions",
            )
        }

        # 还原 PII 占位符
        if pii_mapping:
            result_str = json.dumps(result, ensure_ascii=False)
            result_str = restore(result_str, pii_mapping)
            result = json.loads(result_str)

        from app.services.resume_fact_gates import validate_generated_content
        fact_gates = validate_generated_content(
            resume_text,
            result.get("content_rewrite", {}) if isinstance(result, dict) else {},
        )
        result["fact_gates"] = fact_gates

        return result
