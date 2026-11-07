"""脱敏占位符被模型改写后仍能还原（实测 s4：邮件草稿收件人存成了占位符）。"""

import json

from app.agents.desensitize import desensitize, restore

U2 = "_" + "_"


def test_exact_placeholder_restores():
    masked, mapping = desensitize("投递邮箱 hr-test@example.com")
    assert "hr-test@example.com" not in masked
    assert restore(masked, mapping) == "投递邮箱 hr-test@example.com"


def test_rewritten_placeholder_restores():
    _, mapping = desensitize("hr-test@example.com")
    placeholder = next(iter(mapping))
    variants = [
        placeholder.replace(U2 + "]", "]"),  # 实测：丢结尾下划线
        placeholder.replace("[" + U2, "["),
        placeholder.strip("[]"),
        placeholder.strip("[]").strip("_"),
    ]
    for v in variants:
        assert restore("收件人： " + v, mapping) == "收件人： hr-test@example.com", v


def test_tool_args_json_restores():
    _, mapping = desensitize("hr-test@example.com")
    placeholder = next(iter(mapping)).replace(U2 + "]", "]")
    args = json.dumps({"body": "收件人： " + placeholder}, ensure_ascii=False)
    assert json.loads(restore(args, mapping))["body"] == "收件人： hr-test@example.com"


def test_other_nonce_untouched():
    _, mapping = desensitize("hr-test@example.com")
    stranger = "[PII_EMAIL_1_00000000]"
    assert restore(stranger, mapping) == stranger
