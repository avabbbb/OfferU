# OfferU Internal Beta

## 目标

一个不了解代码结构的内测用户，应能独立启动 OfferU，建立 Career Profile，保存一个目标岗位，让系统自动完成主要准备工作，查看 Pipeline，完成一次针对岗位的模拟面试，并把面试学习作为候选更新回到 Profile。

核心入口只有：

```text
Today → Pipeline → Job / Opportunity → Profile
```

Agent 是全局能力；Memory 是 Profile 的演进机制；Role Intelligence、材料和 Interview 都属于 Job 上下文。

## 推荐 Golden Path

```text
启动
↓
Welcome / 建立 Profile
↓
Opportunity / 保存目标岗位
↓
选择本地准备（Replay）
↓
Today 显示自动工作与待处理事项
↓
Job Detail 显示 Role Intelligence、Evidence Gap、材料候选
↓
审核材料候选并生成 Resume Version
↓
Pipeline 显示目标岗位和下一动作
↓
开始专项面试并提交回答
↓
查看基于真实回答的 Debrief
↓
Profile / 职业模型 / 记忆收件箱接受 Learning Candidate
```

确认学习候选后，Interview 报告、Profile 职业模型和收件箱状态应一致；候选接受前不会成为 Career Truth。

## 验收清单

| 区域 | 通过条件 |
| --- | --- |
| 启动 | 文档命令可启动前端 7410、后端 8765，Doctor 能区分核心和可选 Provider |
| Onboarding | 新用户不读工程 README 也知道建立 Profile 和保存第一个岗位 |
| Demo / Fixture | Showcase 提供虚构 IndexedDB 工作区；正常内测可用 Job 保存后的 Replay/Fixture 链路；清除 Showcase 站点数据即可重置 |
| Today | 展示已完成工作、待决策、下一动作、失败/阻塞任务；不维护第二套状态 |
| Pipeline | Job、Application、Event 同源；目标岗位不会伪装成已投递 |
| Job | 情报、Evidence Gap、材料、Interview、Timeline 聚合在岗位上下文 |
| Role Intelligence | Replay/Fixture 有来源、样本量、数据模式和可展开证据；统计由 Runtime 计算 |
| Resume | Candidate → Review → Resume Version；不静默覆盖正式简历 |
| Interview | Focus → Interviewer Mode → Debrief → Learning Candidate |
| Profile | Memory Inbox 可接受、拒绝、稍后；接受后明确写入分层模型 |
| 失败 | Provider 401、超时、取消和无效候选可见、可解释，不返回假成功或无限空白加载 |
| 重启 | 已完成 Interview、已接受候选、阻塞任务和岗位准备状态重启后仍存在 |
| 重复 | 重复保存岗位不会增加 Job、JOB_SAVED Event 或 CareerTask |
| 数据安全 | Settings 可导出核心数据；默认 SQLite 可备份，恢复步骤有文档；日志不输出凭据和完整敏感内容 |
| 浏览器 | 新用户路径和失败路径从真实 UI 操作完成，不直接改数据库跳步 |

## Provider 规则

至少一个可用 Runtime Provider 就能完成核心内测路径。当前本地链路使用 Replay/Fixture；Codex OAuth、Gmail OAuth 和 DSH 属于外部或实验性能力。外部认证失败必须显示为 `Blocked — authentication required` 类似的明确状态，不阻塞本地核心路径。

## 运行验收

在仓库根目录执行：

```powershell
backend\.venv312\Scripts\python.exe -m pytest backend\tests -q
npm --prefix frontend run typecheck
npm --prefix frontend run build
```

然后按上面的 Golden Path 使用隔离 SQLite 数据库执行浏览器验收。完整结果写入仓库根目录 `STATUS.md`；不能用测试数量代替真实浏览器路径。

## 不属于本轮

面经社区、Feed、Like、Follow、云同步、企业租户、计费、登录、多租户、全量 Python→TypeScript 重写、全自研 Agent Harness 均不属于 Internal Beta 核心完成条件。
