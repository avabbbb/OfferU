---
name: statemachine-job-pipeline
description: 改 job.status、mail.apply、applied_at、投递阶段或 draft_email 收尾前读。core 岗位状态机：状态、事件、守卫、不变式、已知问题、怎么验证。
---

# job.status

状态：saved 想投 / applied 已投递 / test 笔试测评 / interview 面试中 / offer / rejected 未通过 / closed 不投了。定义 backend/app/core/tools.py:22 JOB_STATUS；前端镜像 frontend/src/lib/core.ts:12-14，改一边要改另一边。

## 事件

| 事件 | 谁触发 | 转移 | 代码 |
|---|---|---|---|
| 新建 | 用户、Agent、邮件 | 无 -> saved（默认），也可直接带任意 status | tools.save 331；默认 saved 在 357-358；校验在 tools._check 161-167；mail.apply 165 |
| save status | 用户（工作台） | 任意 -> 任意，只校验 one_of | tools._check 161-167、tools.save |
| save status | Agent（save 工具） | 只按 JOB_ORDER 前进；非冻结态 -> rejected / closed；JOB_FROZEN 冻结 | tools._check_status_forward 326-328、tools.status_move_error 313-324；调用点 tools.py:355-356 |
| mail.apply | 邮件同步（后台服务或 Agent email_sync） | 和 Agent 同一套规则；mail.ORDER 就是 tools.JOB_ORDER | mail.py:26；新建 177-181；_forward 148-150,182-183 |
| 重复存同一 URL | 用户、Agent | 只补空字段，JD 更长才换，tags / auto_tags 整对替换；不动 status、applied_at | tools.merge_saved_job 271-284；去重分支 tools.py:335-338 |
| 撤销 | 用户、Agent undo | 回到改动前（见 statemachine-change-undo） | store.undo 172-200 |

副作用：变成 applied（新建或更新）且记录上还没有 applied_at 时补今天；已经有 applied_at 的不覆盖（tools.py:352-354）。注意：邮件直接把新岗位建成 test / interview / offer 时不经过 applied，所以这类岗位没有 applied_at。

邮件事项：同一岗位同一阶段（event.mail_stage）还没到、未完成的事项又来一封信，当改期改 at；已过去的轮次照常新建（mail.py:185-198）。event.done 只能是 bool（tools.py:184-185）。

## 守卫和不变式

- 顺序规则只有一份：tools.JOB_ORDER / JOB_FROZEN / status_move_error（tools.py:309-324），Agent 和邮件共用；mail.py 只引用。
- 同一 mail_id 只处理一次；撤销后也不会被下次同步写回（mail.seen 同时查 records 和 changes 的 before/after，mail.py:123-128，有意为之，有测试）。
- 非用户路径在 JOB_ORDER 里只前进；rejected / closed 随时可进；进入 JOB_FROZEN（offer / rejected / closed）后非用户不能再改。
- status 永远在 JOB_STATUS 里（tools._check 161-167）。
- overview 不再催 rejected / closed 岗位的未完成事项（tools.py:508-510）；offer 保留（可能还有截止）。

## 已知问题

1. job-pipeline#1 已修：新建即 applied（用户或邮件）也补 applied_at，再存 applied 保留原日期。代码 tools.py:352-354；测试 test_applied_at_set_when_created_applied、test_resave_applied_keeps_applied_at（backend/tests/test_statemachine_models.py:89,239），不再是 xfail。
2. job-pipeline#2 部分修：Agent 和邮件都不能回退了（tools.py:309-324）；用户仍可任意改（有意为之，用来纠错）。剩下的问题：状态检查在 store._lock 外读（tools.py:356 读，store.save 111 才加锁），并发写仍有 TOCTOU。
3. 用户路径没有终态：rejected / closed 也能被用户改回 saved。
4. draft_email 不推进状态（见 statemachine-draft-email）。
5. 旧服务里还有平行状态：jobs 表的 triage_status inbox/picked（backend/app/models/models.py:64；ops.py:2764-2770 仍暴露），application_progress 服务和候选表（models.py:874-877）。email_sync 现在只走 core mail.apply（backend/app/services/email_sync.py:1098），不再另写一份。属 legacy，只修 bug 或删。
6. overview 的阶段被 profile.stage 自由文本覆盖，不校验（tools.py:556；profile 的字段不在 _check 里校验）。

## 验证

```
cd backend
.venv/Scripts/python.exe -m pytest tests/test_statemachine_models.py -q -k "mail or status or applied"
```

穷举 7 个状态 × 8 个邮件阶段（test_mail_moves_job_forward_only，test_statemachine_models.py:56）和 7 × 7 用户转移（test_user_save_reaches_any_status:65）；applied_at 的两条、改期、过去轮次、done 类型、撤销后不重放各有一条回归测试。
