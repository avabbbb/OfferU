# 09 · 质量与发布

> 状态：**当前设计权威** · 取代 docs/evals/*.md、RELIABILITY.md、QUALITY_SCORE.md、INTERNAL_BETA.md、STATUS.md、HANDOFF.md、GOAL.md 中的发布条款等
> 实时清单：根目录 `RELEASE_CHECKLIST.md`（发布门槛逐项状态）、`KNOWN_ISSUES.md`（唯一的严重度台账）——这两个文件由 `backend/scripts/release/*` 读取，**保持在根目录**。

## 1. 发布终点

唯一的发布终点是 `OFFERU_PUBLIC_RELEASE_READY`：一个陌生用户只拿到安装包，不需要开发者陪同，也不需要打开终端，就能独立完成：

```text
安装 → 建档 → 保存岗位 → 查看研究与证据缺口 → 审阅、编辑并导出定制简历
→ 维护真实的投递阶段 → 针对性模拟面试与复盘 → 审核学习候选 → 档案持续演进
```

产品还必须可以安装、升级、迁移、备份、恢复、诊断、失败、重试、审计和卸载。**代码能跑、构建通过、跑通一次 E2E、Replay 或 Fixture 闭环，都不等于可以发布。**

## 2. 证据分层

| 层 | 必须证明 | 首选证据 | 能否只靠模型判定 |
| --- | --- | --- | --- |
| 安全不变量 | 没有越权写入、泄密、静默成功 | 状态差异、审计、显式错误 | 否 |
| Operation 契约 | Registry、schema、提案、确认、幂等 | 结构化输出 + 确定性断言 | 否 |
| Agent 轨迹 | 工具选择、参数、失败可见、授权范围 | 标准事件 + 结果 | 否 |
| 用户纵向旅程 | 普通用户能完成核心闭环 | GUI 操作 + 最终状态 | 否 |
| 真实集成 | 当前 Provider、研究源、宿主真的能用 | 真实调用、版本、成本、错误 | 否 |

优先检查确定性的结果，其次是 schema 和轨迹；模型评分只用于相关性、证据覆盖、表达质量这类主观项。被测 Agent 不能做自己的唯一裁判。

## 3. 结论词汇

- **Eval**：`PASS`、`FAIL`、`BLOCKED`、`NOT_RUN`、`INVALID`。后三者都不计入通过率。
- **发布清单**：`PASS`、`FAIL`、`BLOCKED_EXTERNAL`（仅限签名证书、本人 OAuth、法律或隐私决策、第三方生产账号）、`PRE_EXISTING_FAILURE`、`NOT_VERIFIED`。
- **功能三元记账**（每项分开写）：源码存在 `YES/NO` · 产品路径可达 `WORKS/PARTIAL/BROKEN` · 真人验收 `PASS/FAIL/NOT_TESTED`。

没有 trace 和结果的「看起来正常」不是 `PASS`。

## 4. 套件与试验次数

- `offeru-core-v1`：核心候选套件，20–50 个高价值真实任务；其中的 required tasks 必须全部实际执行并有效通过。
- `OfferU-EvolveBench v1`：长期档案、模糊目标、跨 Provider 泛化、安全硬门槛，单独计分。
- 私有真实用户基准：真实数据、Ground Truth 和人工评分只保存在仓库之外；没有通过 readiness gate 时写 `PRIVATE_EVAL_BASELINE_NOT_ESTABLISHED`。
- 确定性任务至少跑 1 次；涉及模型、网络、检索或 Agent 路由的 required task，从相同初态独立跑 3 次。
- Internal Beta 核心旅程最低要求连续 3/3；Public Release 关键旅程要求连续 10/10，外加至少 50 个扩展组合，首次运行通过率 ≥ 98%。重试后变绿不能掩盖不稳定。

**内测 Goal**：A 用真实内置 Agent 验收功能；B 让真实用户从零走完安装、档案、岗位、简历、投递准备、面试学习和回访。两者分开报告，A 通过不代表 B 或 Public Release 通过。

## 5. 宿主一致性


