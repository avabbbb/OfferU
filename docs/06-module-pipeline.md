# 06 · 模块：投递进展

> 状态：**当前设计权威** · 取代 owner-career-journey §7、career-operations-loop §14–15 与 §22、current-product「Progress sync」等
> 用户入口：「岗位」的看板视图（PROPOSAL）；邮件和日历在「设置 → 信号源」 · 主要代码：`backend/app/services/application_*`、`email_sync.py`、`automation.py`；`frontend/src/app/applications/`、`app/email/`、`app/calendar/`

## 1. 目的

用一条可解释、可审计的时间线回答：「我投了哪些岗位，每个走到了哪一步，下一步该做什么」。投递状态只有一份，「今天」、看板和岗位工作区都只是它的投影。

## 2. 领域对象

| 对象 | 含义 |
| --- | --- |
| `Application` | 用户与某个岗位的投递关系 |
| `ApplicationAttempt` | 一次真实的投递；重新投递会产生新的 Attempt |
| `ExternalProgressSignal` | 一封邮件、一条平台消息、一个日历事件等**可能**意味着进展的信号，属于证据，不是阶段本身 |
| `ApplicationProgressCandidate` | 对信号的进展解读，等待审核或安全策略的判定 |
| `ApplicationStageEvent` | 已确认的阶段变化，是持久事件 |

阶段（语义层）：`已投递 → 有回应 → 面试中 → 已拒绝 / 已拿到 offer`。阶段由事件推导，或者由正式的 Operation 更新；**React 不维护第二份状态**。

## 3. 信号到阶段的唯一路径

```text
邮件 / 日历 / 平台 / 扩展回执
  → 分类 + 关联到正确的岗位和投递
  → ApplicationProgressCandidate
  → 用户或策略审核
  → ApplicationStageEvent
  → 看板 / 今天 / 岗位时间线 / 面试准备 同步更新
```

- 未关联、模糊或冲突的信号留在「需要你处理」，并显示为人能读懂的卡片（「字节跳动发来面试邀请，周四 15:00，要记入吗？」），**不出现** IMAP、UID、cursor 之类的术语。
- 多次同步不会产生重复的投递、面试或事件（以候选 ID 和来源指纹作为幂等键）。
- 点击提交、或 Agent 声称「已投递」，都**不算**回执。阶段推进需要可追溯的成功证据。
- `INTERVIEW_INVITED` 等事件必须一致地投影到「今天」、看板、岗位、时间线和面试准备。

## 4. 信号源

| 来源 | 接入时机 | 规则 |
| --- | --- | --- |
| 浏览器扩展回执 | 用户自己提交后 | 见 [04 §3](./04-module-job-workspace.md#3-浏览器扩展只做三件事) |
| 邮箱（Gmail OAuth / IMAP 只读） | 用户第一次需要进展同步时，在功能内说明收益、授权和撤销方式 | 只读；完整邮件正文不进入 Agent 的通用上下文 |
| 日历 | 同上 | 面试日程是前瞻记忆，带到期时间 |
| 已授权的平台（如 BOSS） | 高级用户 | 逐项核对能力；招聘方下载候选人简历 ≠ 求职者读取自己的简历 |

## 5. 跟进与重新联系

- 到期跟进、简历有重大更新时，生成**重新联系候选**，附 `why_now`、最新材料和历史沟通，并遵守冷却期、去重、上次联系时间和不打扰的约束。
- 当前默认只**准备**候选或草稿，由用户自己发送（L3）。新岗位打招呼和旧岗位跟进是两回事，不能混在一起。
- 任何未来的自动发送都需要单独的产品授权：有边界的名单、频率限制、去重、拒绝或冷却规则、审计、暂停开关。不能因为用户海投，就推断获得了无限授权。

## 6. 看板交互

- 列 = 语义阶段；卡片 = 岗位 + 公司 + 最近事件 + 下一步。
- 拖拽卡片改变阶段 = 用户的明确操作 → 通过 Operation 写入 `ApplicationStageEvent`，并且可以撤销。
- 卡片上「需要你处理」的标记来自待审的进展候选，点击后在卡片内就地处理，不跳转页面。
- 表格视图的横向滚动只限于表格区域内。

## 7. 与其他模块的接口

← [04](./04-module-job-workspace.md) 投递事件 · → [07](./07-module-interview.md) 面试邀请触发准备 · → [03](./03-module-profile.md) 结果进入情景学习 · → 「今天」投影下一步

## 8. 已知技术债（待核实）

- 数据模型中，`Application` / `ApplicationAttempt` 与 `ApplicationTable` / `ApplicationRecord` / `ApplicationTableRecord` 并存。需要确认后者是否是旧的表格功能留下的平行投递状态；如果是，迁移后移除，以满足「只有一份投递状态」的要求。
- `app/applications/page.tsx` 约 2092 行，应拆分为看板、表格、卡片详情三个组件。

