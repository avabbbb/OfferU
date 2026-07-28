# =============================================
# Skill 5: AI 痕迹去除器 (humanizer)
# =============================================
# 功能:
#   检测并替换改写后简历中的 AI 生成特征词和句式，
#   让最终输出读起来像人写的，而非 AI 生成的。
#
# 设计决策:
#   1. 纯规则匹配 + 替换，不调 LLM（零延迟、零成本）
#   2. 双语规则: 英文 AI 高频词 + 中文 AI 常见句式
#   3. 只做替换，不改语义（保留原意，只换措辞）
#   4. 检测不替换: 只标记不修改（保守模式）
#   5. 在 Pipeline 中位于 ContentRewriter 之后
#
# 检测模式:
#   英文: spearheaded, leveraged, orchestrated, utilized, 
#         responsible for, played a key role, comprehensive,
#         streamlined, spearheaded, fostered
#   中文: 负责、主导、推动、优化、助力、赋能、
#         全方位、深度参与、积极推动
#   句式: 破折号滥用、句长过于统一、动词开头过多
# =============================================

from __future__ import annotations

import re
from collections import Counter

from app.agents.skills.base import BaseSkill


# ---- 英文 AI 高频词 → 自然替代 ----
_EN_REPLACEMENTS: list[tuple[str, str]] = [
    (r"\bspearheaded\b", "led"),
    (r"\bleveraged\b", "used"),
    (r"\borchestrated\b", "coordinated"),
    (r"\butilized\b", "used"),
    (r"\bfacilitated\b", "helped"),
    (r"\bstreamlined\b", "improved"),
    (r"\bfostered\b", "built"),
    (r"\bchampioned\b", "drove"),
    (r"\bpioneered\b", "started"),
    (r"\bspearheaded\b", "led"),
    (r"\bcomprehensive\b", "full"),
    (r"\butilize\b", "use"),
    (r"\butilizing\b", "using"),
    (r"\bleveraging\b", "using"),
    (r"\bresponsible for\b", "handled"),
    (r"\bplayed a key role\b", "helped"),
    (r"\bplayed a crucial role\b", "helped"),
    (r"\bin charge of\b", "managed"),
    (r"\btasked with\b", "did"),
    (r"\bspearheaded\b", "led"),
    (r"\bDeliver(?:ed|ing)?\b", "shipped"),
]

# ---- 中文 AI 高频词 → 自然替代 ----
_ZH_REPLACEMENTS: list[tuple[str, str]] = [
    ("赋能", "支持"),
    ("助力", "帮助"),
    ("全方位", "多方面"),
    ("深度参与", "参与"),
    ("积极推动", "推进"),
    ("牵头负责", "负责"),
    ("主导推动", "推动"),
    ("深入参与", "参与"),
    ("全面负责", "负责"),
    ("核心驱动", "推动"),
    ("有效提升", "提升"),
    ("显著优化", "优化"),
    ("顺利完成", "完成"),
    ("高质量完成", "完成"),
]

# ---- AI 句式检测模式（只标记不替换） ----
_AI_SENTENCE_PATTERNS: list[tuple[str, str]] = [
    (r"—{2,}", "破折号滥用（连续破折号）"),
    (r"(?:^|\n)\s*[•·]\s*.{20,}\n\s*[•·]\s*.{20,}\n\s*[•·]\s*.{20,}\n\s*[•·]\s*.{20,}", "列表项过多（4+连续 bullet）"),
]


class HumanizerSkill(BaseSkill):
    """AI 痕迹去除 — 检测并替换改写后内容中的 AI 生成特征"""

    @property
    def name(self) -> str:
        return "humanizer"

    async def execute(self, context: dict) -> dict:
        """
        对 ContentRewriter 的改写建议做后处理：
        1. 替换 AI 高频词为自然替代
        2. 检测 AI 句式特征（只标记）
        3. 检测句长方差（过于统一 = AI 特征）

        context 需要:
          - content_rewrite: ContentRewriterSkill 的输出（含 suggestions）
        """
        content_rewrite = context.get("content_rewrite", {})
        if not isinstance(content_rewrite, dict):
            return {"applied": False, "reason": "no content_rewrite"}

        suggestions = content_rewrite.get("suggestions", [])
        if not isinstance(suggestions, list) or not suggestions:
            return {"applied": False, "reason": "no suggestions"}

        replaced_count = 0
        flagged_patterns: list[dict] = []

        for suggestion in suggestions:
            if not isinstance(suggestion, dict):
                continue
            suggested = suggestion.get("suggested", "")
            if not isinstance(suggested, str) or not suggested:
                continue

            # 1. 替换英文 AI 高频词
            new_text = suggested
            for pattern, replacement in _EN_REPLACEMENTS:
                new_text = re.sub(pattern, replacement, new_text, flags=re.IGNORECASE)

            # 2. 替换中文 AI 高频词
            for pattern, replacement in _ZH_REPLACEMENTS:
                new_text = new_text.replace(pattern, replacement)

            if new_text != suggested:
                suggestion["suggested"] = new_text
                suggestion["humanized"] = True
                replaced_count += 1

            # 3. 检测 AI 句式（只标记）
            for pattern, label in _AI_SENTENCE_PATTERNS:
                if re.search(pattern, suggested):
                    flagged_patterns.append({
                        "pattern": label,
                        "snippet": suggested[:80],
                    })

            # 4. 检测句长方差（中文按句号/分号分句）
            sentences = re.split(r"[。；.!！?？\n]", suggested)
            sentences = [s.strip() for s in sentences if len(s.strip()) > 5]
            if len(sentences) >= 4:
                lengths = [len(s) for s in sentences]
                avg = sum(lengths) / len(lengths)
                variance = sum((l - avg) ** 2 for l in lengths) / len(lengths)
                std_dev = variance ** 0.5
                # 句长标准差 < 3 且 4+ 句 = 过于统一
                if std_dev < 3 and avg > 15:
                    flagged_patterns.append({
                        "pattern": f"句长过于统一（平均{avg:.0f}字，标准差{std_dev:.1f}）",
                        "snippet": suggested[:80],
                    })

        return {
            "applied": replaced_count > 0,
            "replaced_count": replaced_count,
            "total_suggestions": len(suggestions),
            "flagged_patterns": flagged_patterns,
            "flagged_count": len(flagged_patterns),
        }
