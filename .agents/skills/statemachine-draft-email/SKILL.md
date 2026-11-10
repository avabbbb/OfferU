---
name: statemachine-draft-email
description: 改投递邮件草稿（draft_email、kind=email 文档、发送后岗位状态）前读。缺失的状态和已知问题。
---

# 投递邮件草稿

draft_email（backend/app/core/tools.py:1201-1241）按岗位 upsert 一份 kind=email 的 doc：to、subject、body、attachment（起草时导出简历 PDF，tools.py:1223-1230）、rules（JD 里的邮件要求）。不发送，用户自己发。DOC_KIND 在 tools.py:32。

状态：只有 drafted，没有 status 字段，sent 从不记录。

| 事件 | 谁触发 | 转移 | 代码 |
|---|---|---|---|
| draft_email | 用户、Agent（工具在 tools.py:1308） | 无 -> drafted；drafted -> drafted（覆盖同一份 doc） | tools.draft_email 1201-1241；按 job_id 找已有 email doc 并原地写 1235-1238 |
| 撤销 | 用户、Agent | 按 statemachine-change-undo，回到上一版草稿或删掉 | store.undo 172-200 |

副作用：起草会导出简历 PDF（export_resume_pdf），没装浏览器时草稿照存，只回 attach_error（tools.py:1226-1230）。

## 已知问题

1. draft-email#1 没有 drafted -> sent -> 岗位 applied：用户在邮箱发完后岗位仍是 saved，要等邮件回执（mail.apply）或手动改。整条链路没有 sent 字段。
2. draft-email#2 重新起草覆盖同一份 doc（tools.py:1235-1238），没有版本状态，只能靠最近改动撤销。
3. draft-email#3 附件是起草那一刻的 PDF（tools.py:1228），之后改了简历不会跟着变。

## 验证

还没有模型测试：draft_email 要导出 PDF（Chromium），不便宜。修 #1 时把 PDF 导出 monkeypatch 掉，在 backend/tests/test_statemachine_models.py 加 sent -> applied 的测试。
