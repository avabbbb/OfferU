---
name: statemachine-job-pipeline
description: 改 job.status、mail.apply、applied_at、投递阶段或 draft_email 收尾前读。core 岗位状态机：状态、事件、守卫、不变式、已知问题、怎么验证。
---

# job.status

状态：saved 想投 / applied 已投递 / test 笔试测评 / interview 面试中 / offer / rejected 未通过 / closed 不投了。定义 backend/app/core/tools.py:22 JOB_STATUS；前端镜像 frontend/src/lib/core.ts:9-13，改一边要改另一边。

## 事件

| 事件 | 谁触发 | 转移 | 代码 |
|---|---|---|---|
| 新建 | 用户、Agent、邮件 | 无 -> saved（默认），也可直接带任意 status | tools.save；mail.apply |
| save status | 用户（工作台） | 任意 -> 任意，只校验 one_of | tools._check、tools.save |
| save status | Agent（save 工具） | 只按 JOB_ORDER 前进；非冻结 -> rejected；JOB_FROZEN 冻结 | tools._check_status_forward、tools.status_move_error |
| mail.apply | 邮件同步（后台服务或 Agent email_sync） | 和 Agent 同一套规则；mail.ORDER 就是 tools.JOB_ORDER | mail._forward |
| 重复存同一 URL | 用户、Agent | 只补空字段，不动 status、applied_at | tools.save 的去重分支 |
| 撤销 | 用户、Agent undo | 回到改动前（见 statemachine-change-undo） | store.undo |

副作用：变成 applied（新建或更新）且没给 applied_at 时补今天；已经有 applied_at 的不覆盖。

邮件事项：同一岗位同一阶段（event.mail_stage）还没到、未完成的事项又来一封信，当改期改 at；已过去的轮次照常新建。event.done 只能是 bool。

## 守卫和不变式

- 顺序规则只有一份：tools.JOB_ORDER / JOB_FROZEN / status_move_error，Agent 和邮件共用。
- 同一 mail_id 只处理一次，撤销后也不会被下次同步写回（mail.seen，有意为之）。
- 非用户路径单调不减（rejected 除外）；status 永远在 JOB_STATUS 里。
- status 为 applied 及之后的岗位有 applied_at。

## 已知问题

1. job-pipeline#1 已修：新建即 applied 也补 applied_at，再存 applied 保留原日期。
2. job-pipeline#2 部分修：Agent 不能回退了；用户仍可任意改（有意为之，用来纠错）。状态检查在 store._lock 外读，并发写仍有 TOCTOU。
3. 用户路径没有终态。岗位已 rejected / closed / offer 时未完成的事项还会报「处理逾期」。
4. draft_email 不推进状态（见 statemachine-draft-email）。
5. 旧服务里还有两套平行阶段：triage_status inbox/picked、application_progress saved/preparing/ready/applied/unknown，和 JOB_STATUS 不一致；email_sync 还会另写一份 application_progress。属 legacy，只修 bug 或删。
6. overview 的阶段被 profile.stage 自由文本覆盖，不校验。

## 验证

```
cd backend
.venv/Scripts/python.exe -m pytest tests/test_statemachine_models.py -q -k "mail or status or applied"
```

穷举 7 个状态 × 8 个邮件阶段（test_mail_moves_job_forward_only）和 7 × 7 用户转移；#1、#2 已是普通测试。改期、过去轮次、done 类型、applied_at 保留各有一条回归测试。
