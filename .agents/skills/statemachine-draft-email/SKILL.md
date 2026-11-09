---
name: statemachine-draft-email
description: 改投递邮件草稿（draft_email、kind=email 文档、发送后岗位状态）前读。缺失的状态和已知问题。
---

# 投递邮件草稿

draft_email（backend/app/core/tools.py:1130 起）按岗位 upsert 一份 kind=email 的 doc：to、subject、body、attachment（起草时导出简历 PDF）。不发送，用户自己发。

状态：只有 drafted，没有 status 字段，sent 从不记录。

| 事件 | 谁触发 | 转移 |
|---|---|---|
| draft_email | 用户、Agent | 无 -> drafted；drafted -> drafted（覆盖同一份 doc） |
| 撤销 | 用户、Agent | 按 statemachine-change-undo |

## 已知问题

1. draft-email#1 没有 drafted -> sent -> 岗位 applied：用户在邮箱发完后岗位仍是 saved，要等邮件回执（mail.apply）或手动改。
2. draft-email#2 重新起草覆盖同一份 doc，没有版本状态（只能在最近改动撤销）。
3. draft-email#3 附件是起草那一刻的 PDF，之后改了简历不会跟着变。

## 验证

还没有模型测试：draft_email 要导出 PDF（Chromium），不便宜。修 #1 时把 PDF 导出 monkeypatch 掉，在 backend/tests/test_statemachine_models.py 加 sent -> applied 的测试。
