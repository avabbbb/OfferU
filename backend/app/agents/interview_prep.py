# =============================================
# Interview Prep Agent — 面经提炼 + 回答思路生成
# =============================================
# 从面经原文中提炼结构化问题（tier=standard）
# 基于用户 Profile Bullet 生成推荐回答思路（tier=premium）
# =============================================

from __future__ import annotations

import json
import logging
from typing import Optional

from app.agents.llm import chat_completion, extract_json

_logger = logging.getLogger(__name__)

EXTRACT_PROMPT = """你是一位资深的校招面试辅导专家。
请从以下面经原文中提炼出所有面试问题，并结构化输出。

要求：
1. 每个问题独立一条
2. 判断所属面试轮次：hr（HR面）、department（业务/技术面）、final（终面）
3. 判断问题类型：behavioral（行为类）、technical（技术/专业类）、case（情景/案例类）、motivation（动机类）
4. 评估难度 1-5（1=简单常规，5=极难刁钻）
5. 如果面经提到了面试官的关注点，也请提取

以 JSON 格式返回：
{{
  "rounds": ["提到的面试轮次，如 HR面、二面、终面"],
  "questions": [
    {{
      "question_text": "面试官问的原始问题",
      "round_type": "hr / department / final",
      "category": "behavioral / technical / case / motivation",
      "difficulty": 3
    }}
  ]
}}

--- 面经原文 ---
公司：{company}
岗位：{role}

{raw_text}
"""

ANSWER_PROMPT = """你是一位校招面试辅导教练。
请根据求职者的个人经历，为以下面试问题生成推荐回答思路。

要求：
1. 使用 STAR 法则（Situation-Task-Action-Result）组织回答
2. 尽量引用求职者自身的真实经历（来自下方 Profile）
3. 如果 Profile 中没有直接相关经历，给出通用回答框架 + 提示求职者可以用什么经历
4. 控制在 300 字以内
5. 用中文回答

面试问题：{question}
问题类型：{category}
难度：{difficulty}/5

--- 求职者 Profile 要点 ---
{profile_bullets}
"""


async def extract_questions(
    company: str,
    role: str,
    raw_text: str,
) -> Optional[dict]:
    """
    LLM 提炼面经原文 → 结构化问题列表

    返回: {"rounds": [...], "questions": [{question_text, round_type, category, difficulty}]}
    """
    prompt = EXTRACT_PROMPT.format(
        company=company,
        role=role,
        raw_text=raw_text[:6000],
    )

    raw = await chat_completion(
        messages=[{"role": "user", "content": prompt}],
        json_mode=True,
        tier="standard",
        temperature=0.2,
    )

    if not raw:
        _logger.warning("extract_questions: LLM returned no content")
        return None

    result = extract_json(raw)
    if not result or "questions" not in result:
        _logger.warning(
            "extract_questions: invalid JSON structure; response_chars=%s",
            len(raw),
        )
        return None

    return result


async def generate_answer_hint(
    question: str,
    category: str,
    difficulty: int,
    profile_bullets: str,
) -> Optional[str]:
    """
    基于用户 Profile 生成面试问题的推荐回答思路

    返回: 纯文本回答思路
    """
    prompt = ANSWER_PROMPT.format(
        question=question,
        category=category,
        difficulty=difficulty,
        profile_bullets=profile_bullets[:4000],
    )

    return await chat_completion(
        messages=[{"role": "user", "content": prompt}],
        tier="premium",
        temperature=0.5,
        max_tokens=1024,
    )
