# =============================================
# PII 自动脱敏模块
# =============================================
# 在发送简历文本到云端 LLM 之前，自动替换敏感信息：
#   - 手机号码（中国 11 位 / 国际格式）
#   - 邮箱地址
#   - 身份证号码（18 位）
#   - 银行卡号
# 脱敏后保留占位符，LLM 分析完成后还原
# 仅对云端 Provider（DeepSeek / OpenAI）生效，Ollama 本地不脱敏
# =============================================

from __future__ import annotations

import re
import secrets
from typing import Tuple

# ---- 正则模式 ----
# 中国手机号：1 开头 11 位
_PHONE_CN = re.compile(r'(?<!\d)1[3-9]\d{9}(?!\d)')
# 国际电话：+开头，后跟数字和可选横杠/空格
_PHONE_INTL = re.compile(r'\+\d{1,3}[\s-]?\d{6,14}')
# 邮箱
_EMAIL = re.compile(r'[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}')
# 中国身份证号（18 位，最后一位可能是 X）
_ID_CARD = re.compile(r'(?<!\d)\d{17}[\dXx](?!\d)')
# 银行卡号（16-19 位纯数字，可能含空格）
_BANK_CARD = re.compile(r'(?<!\d)\d{4}[\s]?\d{4}[\s]?\d{4}[\s]?\d{4}[\s]?\d{0,3}(?!\d)')


def desensitize(text: str) -> Tuple[str, dict]:
    """
    对文本中的 PII 进行脱敏替换

    返回:
        (脱敏后文本, 还原映射 {占位符: 原始值})
    """
    mapping: dict[str, str] = {}  # placeholder -> original
    counter = {"phone": 0, "email": 0, "id": 0, "bank": 0}
    # Per-call random nonce so placeholders are globally unique and cannot
    # accidentally collide with text that the LLM might generate on its own.
    nonce = secrets.token_hex(4)

    def _replace(match: re.Match, prefix: str) -> str:
        original = match.group(0)
        # 避免重复脱敏同一个值
        for placeholder, orig in mapping.items():
            if orig == original:
                return placeholder
        counter[prefix] += 1
        placeholder = f"[__PII_{prefix.upper()}_{counter[prefix]}_{nonce}__]"
        mapping[placeholder] = original
        return placeholder

    # 按长度从长到短替换，避免短模式误匹配长模式的子串
    # 银行卡（16-19位）在身份证（18位）之后处理，利用 lookbehind/ahead 区分
    result = _ID_CARD.sub(lambda m: _replace(m, "id"), text)
    result = _EMAIL.sub(lambda m: _replace(m, "email"), result)
    result = _PHONE_INTL.sub(lambda m: _replace(m, "phone"), result)
    result = _PHONE_CN.sub(lambda m: _replace(m, "phone"), result)
    result = _BANK_CARD.sub(lambda m: _replace(m, "bank"), result)
    # TODO: 地址/学校/公司等命名实体需要 NLP (spaCy / LLM) 识别
    # 正则无法可靠匹配"北京大学""字节跳动"等专有名词
    # 后续迭代引入 NER 模型处理

    return result, mapping


def restore(text: str, mapping: dict) -> str:
    """将脱敏占位符还原为原始值

    使用精确的占位符字符串替换。由于占位符包含每调用唯一的随机
    nonce（如 ``[__PII_PHONE_1_a3f2b1c7__]``），LLM 输出中不太可能
    意外产生相同的字符串，因此 ``str.replace`` 是安全的。
    """
    result = text
    for placeholder, original in mapping.items():
        if placeholder in result:
            result = result.replace(placeholder, original)
    return result
