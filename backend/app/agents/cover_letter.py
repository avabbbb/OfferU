# =============================================
# Cover Letter Agent — AI 自动生成投递求职信
# =============================================
# 输入：岗位 JD + 简历内容
# 输出：针对该岗位定制的中英文求职信
# 使用统一 LLM 接口 (chat_completion)，tier=standard
# =============================================

import json
import logging

from app.agents.llm import chat_completion

_logger = logging.getLogger(__name__)

COVER_LETTER_PROMPT = """你是一位专业的求职信撰写助手。
根据提供的【岗位描述】和【求职者简历】，撰写一封针对性的求职信。

要求：
1. 开头说明对该岗位的兴趣和来源
2. 中间段落突出简历中与 JD 最匹配的 2-3 个亮点
3. 结尾表达面试意愿
4. 简洁专业，不超过 300 字
5. 根据岗位语言（中文/英文）自动匹配语言

请以 JSON 格式返回：
{{
  "cover_letter": "求职信完整内容",
  "language": "zh" 或 "en",
  "key_highlights": ["亮点1", "亮点2", "亮点3"]
}}

--- 岗位描述 ---
{jd}

--- 求职者简历 ---
{resume}
"""


async def generate_cover_letter(jd: str, resume: str) -> dict:
    """
    调用 LLM 生成针对特定岗位的求职信
    返回 { cover_letter, language, key_highlights }
    """
    prompt = COVER_LETTER_PROMPT.format(jd=jd[:3000], resume=resume[:3000])

    raw = await chat_completion(
        messages=[{"role": "user", "content": prompt}],
        json_mode=True,
        temperature=0.7,
        tier="standard",
    )

    if not raw:
        return {"cover_letter": "", "language": "zh", "key_highlights": []}

    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        _logger.warning(
            "Cover letter JSON decode failed; response_chars=%s",
            len(raw),
        )
        return {"cover_letter": "", "language": "zh", "key_highlights": []}
