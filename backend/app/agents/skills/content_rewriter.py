# =============================================
# Skill 3: 内容改写器 (content_rewriter) — 重构版
# =============================================
# 功能（两合一）:
#   A) 经历改写 — 用 STAR 法重构经历描述
#      - 校招专精: 实习/课程项目/竞赛/社团
#      - 零幻觉原则: 仅改写措辞和结构，绝不编造数据/指标
#      - 借鉴 Resume Oracle: 只用用户已有经历
#
#   B) 关键词映射 — 将 missing_skills 映射到简历证据
#      - 从 Skill 2 的 missing_skills 中筛选可自然嵌入项
#      - 关键词映射而非注入：有证据的融入，无证据的标注缺失
#      - 借鉴 auto-resume keyword_injecting_agent + CVOptimizer
#
# 设计决策:
#   1. 合并经历改写 + 关键词映射为一次 LLM 调用
#   2. 严格零幻觉: Prompt 明确禁止编造数据/指标/量化数字
#   3. 每条建议带原文定位，供 HITL 前端逐条审核
#   4. 校招特殊: 把课程项目/竞赛/社团活动当正式经历对待
#   5. 按 section 类型给出差异化改写策略
#   6. 支持面经参考信息注入，让改写方向与面试考察点对齐
#   7. 输出结构化 JSON + HTML 描述（TipTap 兼容）
#   8. 三阶段改写工作流：事实锁定→基于事实改写→自然性验证
#   9. 质量护栏：检测机械式关键词堆砌、虚假因果、AI 生成特征
#
# 输出 Schema:
#   {
#     "section_title": "项目经历",
#     "section_type": "project",
#     "suggestions": [
#       {
#         "type": "rewrite" | "inject",
#         "item_label": "xxx项目（如有）",
#         "original": "原文片段",
#         "suggested": "<ul><li><strong>负责</strong>系统设计</li></ul>",
#         "reason": "改写理由（1句话）",
#         "injected_keywords": ["Docker"],
#         "matched_jd_requirements": ["匹配的JD要求"],
#         "interview_reference": "参考的面经考察点（如有）",
#         "diff": {
#           "deleted": ["原文片段"],
#           "added": ["<ul><li><strong>负责</strong>系统设计</li></ul>"]
#         }
#       }
#     ]
#   }
# =============================================

from __future__ import annotations

import difflib
import re
from typing import Any

from app.agents.llm import chat_completion, extract_json
from app.agents.skills.base import BaseSkill

# TipTap-compatible HTML tags whitelist
_ALLOWED_TAGS = {"ul", "ol", "li", "strong", "b", "em", "i", "u", "s", "p", "br"}
_ALLOWED_TAG_PATTERN = re.compile(r"</?([a-zA-Z][a-zA-Z0-9]*)[^>]*>")


def _clean_html(text: str) -> str:
    """Strip HTML tags not in the TipTap-compatible whitelist."""
    if not text or "<" not in text:
        return text

    def _replace_tag(match: re.Match) -> str:
        tag_name = match.group(1).lower()
        if tag_name in _ALLOWED_TAGS:
            return match.group(0)
        return ""

    return _ALLOWED_TAG_PATTERN.sub(_replace_tag, text)


SECTION_TYPE_GUIDANCE = """
### 按 section 类型的改写策略

**work_experience / experience（实习/工作经历）**:
- 优先改写：模糊描述 → STAR 结构
- 关键词映射：将 JD 要求的技术/工具映射到经历中的证据，自然融入职责描述
- 责任边界锁定：参与、协助、配合不能升级为负责、主导、独立完成
- 量化边界锁定：原文没有数字时，不添加数字或占位符
- 每条经历控制在 2-4 个 bullet point
- description 字段使用 HTML 格式：<ul><li>...</li></ul>

**project（项目经历）**:
- 突出技术栈与 JD 的匹配
- 只按原文已有证据呈现个人贡献，不改变参与程度或责任归属
- 只保留原文已有的技术选型理由，不根据 JD 反推候选人事实
- 项目成果用 Result 表达，即使没有数字也要体现价值
- description 字段使用 HTML 格式

**skill（技能清单）**:
- 将 JD 匹配的技能排前面
- JD 要求但简历缺失的技能只能列为能力缺口，禁止写入 suggested
- 合并同类技能分类
- 不要删除候选人已有的技能

**education（教育经历）**:
- 一般不改写，原样保留
- 如 JD 强调 GPA/排名，可建议补充（但用 reason 说明，不改写原文）
- 仅在描述完全为空时建议补充

**summary / custom（个人简介/补充亮点）**:
- 重写为针对目标岗位的定制版
- 融入 JD 关键词和核心要求
- 突出与岗位最匹配的 2-3 个亮点
- 保持简洁（3-4 句话）
- description 字段使用 HTML 格式"""

INTERVIEW_CONTEXT_TEMPLATE = """
### 面试经验参考
以下是该岗位/公司的面试高频问题，请在改写时考虑这些考察方向：

{interview_questions}

改写时注意：
- 如果面经强调某技术深度，在经历中突出相关技术的使用细节
- 如果面经有行为类问题（如"最大挑战"），确保经历中有对应的 STAR 故事
- 不要直接提及面经内容，只是让改写方向与面试考察点对齐
- 在每条受面经影响的建议中，用 interview_reference 字段说明参考了哪个考察点"""

RESEARCH_CONTEXT_TEMPLATE = """
### 已完成岗位调研（仅作为表达策略证据）
{research_lines}

使用边界：
- 调研信息只能决定内容排序、强调方向和能力缺口，不能成为候选人的经历、技能、成果或责任事实
- 每条调研结论保留证据等级和 source_refs；证据不足或冲突时，宁可不采用
- 面试题、团队氛围和参考简历模式不能被写成候选人亲历事实
- JD 或调研要求但候选人原文没有证据的能力，只能保留为缺口"""

THREE_STAGE_WORKFLOW = """
## 三阶段改写工作流（CRITICAL — 必须严格遵守）

### 阶段一：事实锁定
1. 识别原文中的事实要素（数据、经历、成果、时间线）
2. 将事实要素标记为「不可编造」
3. 列出 JD 关键词，逐个映射到简历中的证据

### 阶段二：基于事实改写
1. 只从已验证的声明中改写
2. 用 STAR 结构优化描述
3. 关键词自然融入上下文（映射而非注入）
4. 有证据的关键词：自然融入描述
5. 无证据的关键词：标注为"缺失"，不强行注入

### 阶段三：自然性验证
1. 检查是否有机械式关键词堆砌
2. 检查因果关系是否成立
3. 检查段落结构是否过于对称（AI 生成特征）
4. 如果发现问题，回退到阶段二重新改写
"""

ANTI_MECHANICAL_INJECTION_RULES = """
## 反机械关键词注入规则（CRITICAL）

1. 绝不编造经历、技能、数据、成果 — 如果原文没有证据，不要强行关联
2. 关键词必须融入上下文，而非堆砌 — 例如"奖学金"和"逻辑分析能力"没有因果关系，不要强行关联
3. 每条描述应是一个微型工作故事：情境→行动→结果，而非关键词列表
4. 如果某个 JD 要求在当前经历中找不到自然关联，宁可跳过也不要强行注入
5. 保留原文的限定词和自然表达，不要全部改成"完美"的 AI 语言
6. 如果缺少量化数据，保持非量化表达；禁止添加数字或"[待量化]"占位符
7. 关键词映射而非注入：先列出 JD 关键词，逐个映射到简历中的证据
8. 有证据的：自然融入描述
9. 无证据的：标注为"缺失"，建议用户补充，不要强行注入
10. 单条 bullet 中出现 3+ 个 JD 关键词时，检查是否过于机械
11. 不要建立虚假因果关系（如"奖学金→逻辑分析能力"）
12. 段落结构不要过于对称（AI 生成特征）
"""

SYSTEM_PROMPT = f"""你是一名专业的校招简历内容优化师。你的任务是改写候选人的经历描述，同时将缺失的关键词映射到简历证据中。

## 核心原则

### 零幻觉规则（最高优先级）
- 绝对禁止编造任何数据、指标、百分比、数字
- 绝对禁止添加候选人简历中不存在的经历/项目/技术
- 只能改写措辞、优化结构、调整表达方式
- 如果原文是"参与了xx项目"，不能凭空改成"主导了xx项目，提升30%效率"
- 如果原文没有提到具体数据，改写后也不能出现具体数据

### 改写规则
1. **STAR 法则**: 把模糊描述重构为 Situation-Task-Action-Result 结构
2. **校招特殊**: 实习/课程项目/竞赛/社团活动 = 正式经历，同等重视
3. **动作澄清**: 在不改变责任边界的前提下让动作更具体；参与、协助不能升级为负责、主导或独立完成
4. **细化拆分**: 一句笼统描述 → 拆成 2-3 个具体动作点
5. **量化引导**: 如果原文有模糊暗示（如"大量"），可以改为"多个/若干"，但不能编数字

### 关键词映射规则（替代"注入"）
1. 先列出 JD 关键词，逐个映射到简历中的证据
2. 有证据的关键词：自然融入经历描述句子中，不是单独列出
3. 无证据的关键词：只能作为能力缺口保留在分析结果中，不得出现在 suggested 或 injected_keywords
4. 每条经历最多映射 1-2 个关键词，不要过度堆砌
5. 如果没有合适的映射位置，不要强行映射

{THREE_STAGE_WORKFLOW}

{ANTI_MECHANICAL_INJECTION_RULES}

{SECTION_TYPE_GUIDANCE}

## 输入
你会收到:
1. 候选人简历全文
2. JD 分析结果（岗位要求）
3. 匹配分析结果（已匹配/缺失技能、各段评分）
4. 面试经验参考（如有）
5. 已完成的岗位调研证据（如有，仅用于表达策略）

## 输出要求
输出结构化 JSON，包含 section 信息和改写建议列表。

每条建议必须包含:
- type: "rewrite"（纯改写）或 "inject"（映射关键词+改写）
- item_label: 具体条目标识（如项目名/公司名/活动名，无法确定则为空字符串）
- original: 原文完整片段（必须来自简历原文）
- suggested: 改写后的文本，使用 TipTap 兼容的 HTML 格式
  - 列表项用 <ul><li>...</li></ul>
  - 加粗用 <strong>...</strong>
  - 斜体用 <em>...</em>
  - 不要使用 <p> 标签，直接用 <ul><li> 结构
- reason: 为什么这样改（1句话中文，需说明匹配了 JD 的什么要求）
- injected_keywords: 映射的关键词列表（仅 inject 类型有内容，rewrite 类型为空数组）
- matched_jd_requirements: 本次改写匹配了 JD 的哪些要求（字符串列表）
- interview_reference: 参考的面经考察点（如有，否则为空字符串）
- diff: 差异信息
  - deleted: 被删除/替换的文本片段列表
  - added: 新增的文本片段列表

返回严格 JSON:
{{
  "section_title": "段落名",
  "section_type": "段落类型",
  "suggestions": [
    {{
      "type": "rewrite",
      "item_label": "条目名或空",
      "original": "原文",
      "suggested": "<ul><li>参与系统设计并完成原文已证实的工作</li></ul>",
      "reason": "理由（需说明匹配了JD的什么要求）",
      "injected_keywords": [],
      "matched_jd_requirements": ["匹配的JD要求"],
      "interview_reference": "",
      "diff": {{
        "deleted": ["原文"],
        "added": ["<ul><li><strong>负责</strong>系统设计</li></ul>"]
      }}
    }}
  ]
}}

注意:
- 只输出确实需要改写的条目，无需改写的不要输出
- 最多输出 10 条建议（优先改写评分最低的段落）
- 每条 original 必须是简历中真实存在的文本片段
- reason 必须说明本次改写匹配了 JD 的什么具体要求
- suggested 字段必须使用 HTML 格式（TipTap 兼容）
- diff 必须准确反映原文到改写的变化"""


class ContentRewriterSkill(BaseSkill):
    """内容改写 + 关键词映射 — STAR 法改写经历 + 自然映射缺失关键词"""

    @property
    def name(self) -> str:
        return "content_rewrite"

    async def execute(self, context: dict) -> dict:
        """
        改写简历经历描述 + 映射缺失关键词

        context 需要:
          - resume_text: 简历纯文本
          - jd_analysis: Skill 1 的输出
          - match_analysis: Skill 2 的输出
          - interview_questions: (可选) 面经参考信息

        返回: 改写建议列表
        """
        resume_text = context.get("resume_text", "")
        jd_analysis = context.get("jd_analysis", {})
        match_analysis = context.get("match_analysis", {})

        if not resume_text.strip():
            return {"error": "简历文本为空"}

        missing_skills = match_analysis.get("missing_skills", [])
        section_scores = match_analysis.get("section_scores", [])
        required_skills = jd_analysis.get("required_skills", [])
        is_campus = jd_analysis.get("is_campus", True)

        analysis_context = self._build_context(
            jd_analysis, missing_skills, section_scores, is_campus
        )

        interview_context = self._build_interview_context(context)
        research_context = self._build_research_context(context)

        user_parts = [
            f"## 候选人简历\n\n{resume_text}",
            f"## 分析上下文\n\n{analysis_context}",
        ]
        if interview_context:
            user_parts.append(interview_context)
        if research_context:
            user_parts.append(research_context)

        messages = [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": "\n\n".join(user_parts)},
        ]

        raw = await chat_completion(
            messages=messages,
            temperature=0.3,
            json_mode=True,
            max_tokens=4096,
            tier="premium",
        )

        if not raw:
            return {"error": "LLM 调用失败"}

        result = extract_json(raw)
        if not result or "suggestions" not in result:
            return {"error": "LLM 返回格式异常", "raw": raw[:500]}

        # Apply quality guardrail
        result = _apply_quality_guardrail(result, missing_skills)

        # Clean HTML in suggestions
        for sug in result.get("suggestions", []):
            if isinstance(sug, dict):
                suggested = sug.get("suggested", "")
                if suggested:
                    sug["suggested"] = _clean_html(suggested)

        return result

    async def execute_single_section(
        self,
        context: dict,
        section_title: str,
        section_type: str,
        section_content: str,
        extra_instruction: str = "",
    ) -> dict:
        jd_analysis = context.get("jd_analysis", {})
        match_analysis = context.get("match_analysis", {})

        if not section_content.strip():
            return {"error": "section 内容为空"}

        missing_skills = match_analysis.get("missing_skills", [])
        required_skills = jd_analysis.get("required_skills", [])
        is_campus = jd_analysis.get("is_campus", True)

        analysis_context = self._build_context(
            jd_analysis, missing_skills, [], is_campus
        )

        interview_context = self._build_interview_context(context)
        research_context = self._build_research_context(context)

        single_section_prompt = f"""请只改写以下这一个 section：

## Section 信息
- 标题: {section_title}
- 类型: {section_type}
- 内容:
---SECTION_START---
{section_content}
---SECTION_END---

## 分析上下文
{analysis_context}
"""
        if interview_context:
            single_section_prompt += f"\n\n{interview_context}"
        if research_context:
            single_section_prompt += f"\n\n{research_context}"

        if extra_instruction:
            single_section_prompt += f"\n\n## 额外指令\n{extra_instruction}"

        messages = [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": single_section_prompt},
        ]

        raw = await chat_completion(
            messages=messages,
            temperature=0.3,
            json_mode=True,
            max_tokens=2048,
            tier="premium",
        )

        if not raw:
            return {"error": "LLM 调用失败"}

        result = extract_json(raw)
        if not result or "suggestions" not in result:
            return {"error": "LLM 返回格式异常", "raw": raw[:500]}

        # Ensure section metadata
        if "section_title" not in result:
            result["section_title"] = section_title
        if "section_type" not in result:
            result["section_type"] = section_type

        # Apply quality guardrail
        result = _apply_quality_guardrail(result, missing_skills)

        # Clean HTML and ensure diff information in each suggestion
        for sug in result.get("suggestions", []):
            if isinstance(sug, dict):
                # Clean HTML
                suggested = sug.get("suggested", "")
                if suggested:
                    sug["suggested"] = _clean_html(suggested)
                # Ensure diff
                if "diff" not in sug or not isinstance(sug.get("diff"), dict):
                    sug["diff"] = _compute_diff(
                        sug.get("original", ""),
                        sug.get("suggested", ""),
                    )

        return result

    def _build_context(
        self,
        jd_analysis: dict,
        missing_skills: list,
        section_scores: list,
        is_campus: bool,
    ) -> str:
        parts = []

        if jd_analysis.get("job_title"):
            parts.append(f"目标岗位: {jd_analysis['job_title']}")
        if is_campus:
            parts.append("岗位类型: 校招（实习/课程项目/竞赛都算正式经历）")

        if missing_skills:
            parts.append(f"缺失关键词（可尝试映射）: {', '.join(missing_skills[:10])}")

        required = jd_analysis.get("required_skills", [])
        if required:
            parts.append(f"JD 必须技能: {', '.join(required[:10])}")

        if section_scores:
            low_sections = [
                f"{s.get('title', s.get('section', '?'))}({s.get('score', '?')}分)"
                for s in section_scores
                if isinstance(s.get("score"), (int, float)) and s["score"] < 70
            ]
            if low_sections:
                parts.append(f"低分段落（优先改写）: {', '.join(low_sections)}")

        return "\n".join(parts) if parts else "（无额外分析上下文）"

    def _build_interview_context(self, context: dict) -> str:
        interview_questions = context.get("interview_questions", "")
        if isinstance(interview_questions, list):
            parts = []
            for q in interview_questions:
                if isinstance(q, dict):
                    question_text = q.get("question_text", "") or q.get("text", "")
                    category = q.get("category", "")
                    if question_text:
                        label = f"[{category}] " if category else ""
                        parts.append(f"{label}{question_text}")
                elif q:
                    parts.append(str(q))
            interview_questions = "\n".join(parts)
        if not isinstance(interview_questions, str) or not interview_questions.strip():
            return ""
        return INTERVIEW_CONTEXT_TEMPLATE.format(
            interview_questions=interview_questions
        )

    def _build_research_context(self, context: dict) -> str:
        research = context.get("research_context")
        if not isinstance(research, dict):
            return ""

        labels = {
            "role_requirements": "岗位要求",
            "resume_patterns": "参考简历表达模式",
            "interview_questions": "面试考察",
            "team_culture_signals": "团队氛围信号",
            "company_context": "公司与业务背景",
            "risks": "风险或未知项",
        }
        lines: list[str] = []
        for key, label in labels.items():
            items = research.get(key)
            if not isinstance(items, list):
                continue
            for item in items[:8]:
                if not isinstance(item, dict):
                    continue
                statement = str(item.get("statement") or "").strip()
                if not statement:
                    continue
                evidence_level = str(item.get("evidence_level") or "unknown")
                refs = [
                    str(ref).strip()
                    for ref in (item.get("source_refs") or [])
                    if str(ref).strip()
                ]
                lines.append(
                    f"- [{label}] {statement} "
                    f"(evidence={evidence_level}; source_refs={','.join(refs) or 'none'})"
                )

        gaps = [
            str(item).strip()
            for item in (research.get("gaps") or [])
            if str(item).strip()
        ]
        if gaps:
            lines.append(f"- [调研缺口] {'；'.join(gaps[:8])}")
        if not lines:
            return ""
        return RESEARCH_CONTEXT_TEMPLATE.format(research_lines="\n".join(lines))


# ---- Quality Guardrail ----

def _apply_quality_guardrail(result: dict, missing_skills: list[str]) -> dict:
    """后置事实与质量检查：不让 LLM 输出越过候选人证据边界。"""
    if not isinstance(result, dict):
        return result

    suggestions = result.get("suggestions", [])
    if not isinstance(suggestions, list):
        return result

    warnings: list[str] = []
    blocked: list[dict[str, Any]] = []
    accepted: list[dict[str, Any]] = []

    for sug in suggestions:
        if not isinstance(sug, dict):
            continue

        suggested = str(sug.get("suggested") or "")
        original = str(sug.get("original") or "")
        injected = sug.get("injected_keywords", [])
        block_reasons: list[str] = []

        # 1. 责任边界不能从参与/协助升级为负责/主导。
        source_is_supporting = re.search(
            r"(参与|协助|配合|支持|\bcontributed\b|\bassisted\b|\bsupported\b)",
            original,
            flags=re.IGNORECASE,
        )
        target_claims_ownership = re.search(
            r"(负责|主导|独立完成|\bowner\b|\bowned\b|\bled\b|\bspearheaded\b)",
            suggested,
            flags=re.IGNORECASE,
        )
        if source_is_supporting and target_claims_ownership:
            block_reasons.append("责任边界从参与或协助升级为负责、主导或独立完成")

        # 2. 不允许用占位符掩盖缺失的量化事实。
        if "[待量化]" in suggested:
            block_reasons.append("包含未经证实的量化占位符")

        # 3. 缺失技能没有原文证据时，不能进入建议文本或关键词字段。
        unsupported_skills = [
            skill
            for skill in missing_skills
            if (
                _mentions_skill(suggested, skill)
                or (
                    isinstance(injected, list)
                    and any(
                        str(value).strip().casefold() == str(skill).strip().casefold()
                        for value in injected
                    )
                )
            )
            and not _mentions_skill(original, skill)
        ]
        if unsupported_skills:
            block_reasons.append(
                f"缺失技能没有候选人原文证据：{', '.join(map(str, unsupported_skills[:5]))}"
            )

        if block_reasons:
            blocked.append({
                "item_label": str(sug.get("item_label") or ""),
                "original": original,
                "reasons": block_reasons,
            })
            continue

        # 4. 检测单条 bullet 中 3+ 个 JD 关键词
        if isinstance(injected, list) and len(injected) >= 3:
            warnings.append(
                f"⚠️ 「{sug.get('item_label', '')}」映射了 {len(injected)} 个关键词"
                f"（{', '.join(map(str, injected[:5]))}），可能过于机械"
            )

        # 5. 检测虚假因果关系
        false_causal_patterns = [
            (r"奖学金.*(?:逻辑|分析|创新|领导)", "奖学金与该能力无直接因果关系"),
            (r"成绩.*(?:团队|协作|沟通)", "成绩与该能力无直接因果关系"),
            (r"竞赛.*(?:领导力|管理)", "竞赛与领导力需有具体证据支撑"),
        ]
        for pattern, reason in false_causal_patterns:
            if re.search(pattern, suggested):
                warnings.append(
                    f"⚠️ 「{sug.get('item_label', '')}」可能存在虚假因果：{reason}"
                )

        # 6. 检测过于对称的段落结构（AI 生成特征）
        if _detect_symmetric_structure(suggested):
            warnings.append(
                f"⚠️ 「{sug.get('item_label', '')}」段落结构可能过于对称（AI 生成特征）"
            )

        sug["diff"] = _compute_diff(original, suggested)
        accepted.append(sug)

    result["suggestions"] = accepted
    if warnings:
        result["_quality_warnings"] = warnings
    if blocked:
        result["_guardrail_blocked"] = blocked

    return result


def _mentions_skill(text: str, skill: Any) -> bool:
    candidate = str(skill or "").strip().casefold()
    if not candidate:
        return False
    plain = re.sub(r"<[^>]+>", " ", str(text or "")).casefold()
    if re.fullmatch(r"[a-z0-9_.+#/-]+", candidate):
        return bool(re.search(
            rf"(?<![a-z0-9]){re.escape(candidate)}(?![a-z0-9])",
            plain,
        ))
    return candidate in plain


def _detect_symmetric_structure(text: str) -> bool:
    """检测过于对称的段落结构（AI 生成特征）"""
    if not text:
        return False

    # Strip HTML tags for analysis
    plain = re.sub(r"<[^>]+>", "", text)
    lines = [line.strip() for line in plain.split("\n") if line.strip()]

    if len(lines) < 4:
        return False

    # Check if all lines have very similar length (within 30%)
    lengths = [len(line) for line in lines]
    if not lengths:
        return False

    avg_len = sum(lengths) / len(lengths)
    if avg_len == 0:
        return False

    # If all lines are within 30% of average length, it's suspicious
    all_similar = all(abs(l - avg_len) / avg_len < 0.30 for l in lengths)
    if all_similar and len(lines) >= 4:
        return True

    # Check if all lines start with the same pattern (e.g., "负责", "参与", "完成")
    prefixes = []
    for line in lines:
        match = re.match(r"^[\u4e00-\u9fa5]{2}", line)
        if match:
            prefixes.append(match.group())
    if len(prefixes) >= 3 and len(set(prefixes)) == 1:
        return True

    return False


def _compute_diff(original: str, suggested: str) -> dict:
    """计算原文到改写的差异，使用 difflib 生成词级/句级 diff"""
    deleted: list[str] = []
    added: list[str] = []

    # Strip HTML tags for comparison
    orig_clean = re.sub(r"<[^>]+>", "", original).strip()
    sugg_clean = re.sub(r"<[^>]+>", "", suggested).strip()

    if orig_clean == sugg_clean:
        return {"deleted": deleted, "added": added}

    # Use difflib to find differences at word/sentence level
    matcher = difflib.SequenceMatcher(None, orig_clean, sugg_clean)
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "replace":
            deleted.append(orig_clean[i1:i2])
            added.append(sugg_clean[j1:j2])
        elif tag == "delete":
            deleted.append(orig_clean[i1:i2])
        elif tag == "insert":
            added.append(sugg_clean[j1:j2])

    return {
        "deleted": deleted,
        "added": added,
    }
