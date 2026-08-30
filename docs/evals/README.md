# OfferU Eval 手册

本目录是 OfferU 的验收事实入口。功能是否可用、Harness 是否受支持、版本是否可供内测，必须由可复现任务、脱敏轨迹和最终业务状态共同证明，不能由功能清单、截图、构建成功或模型自评决定。

当前基础候选套件是 [`offeru-core-v1`](./offeru-core-v1.md)，Public Release 总 Gate 见 [`RELEASE_CHECKLIST.md`](../../RELEASE_CHECKLIST.md)。在产生符合本手册与 [`report-schema.json`](./report-schema.json) 的有效 Public Release 报告前，统一表述为：**Internal Beta 检查点存在；Public Release NOT READY；尚无正式 Public Release baseline**。

## 事实源分工

| 问题 | 权威来源 |
| --- | --- |
| 系统应该做什么 | [`CONTEXT.md`](../../CONTEXT.md) 与最新 accepted ADR |
| 目标架构如何工作 | [10 份活跃设计](../README.md) |
| 当前暴露了什么 | 实时 `doctor`、`manifest`、`ops`、`schema` 与 capability probe |
| 当前版本做到了什么 | 与当前 commit 对应的有效 Eval 报告和 artifacts |
| 过去为何改变 | Git 历史；不作为当前能力证明 |

固定 Operation 数量、模型名、Harness 版本和“已通过”描述容易漂移，不应写成长期承诺。

## 核心术语

- **Task**：边界明确、可判定成败的验收任务。
- **Trial**：同一 Task 从相同初态开始的一次独立执行。
- **Trajectory / Trace**：消息、决策、工具调用、参数、重试和错误序列。
- **Outcome**：最终数据库、文件、UI、Run 或外部系统状态。
- **Grader**：把证据映射为 `PASS`、`FAIL` 等状态的规则或评审者。
- **Suite**：版本化 Tasks、fixtures、graders 与验收规则。
- **Baseline**：维护者接受、可与当前版本比较的有效结果。

## 证据层

| 层面 | 必须证明 | 首选证据 | 模型能否单独判定 |
| --- | --- | --- | --- |
| 安全不变量 | 无越权写入、泄密或静默成功 | 状态差异、审计、显式错误 | 否 |
| Operation 契约 | Registry、schema、提案、确认与幂等 | 结构化输出和确定性断言 | 否 |
| Harness 轨迹 | 工具选择、参数、失败可见和授权范围 | 标准事件 + outcome | 否 |
| 用户纵向旅程 | 普通用户能完成核心闭环 | GUI 操作 + 最终状态 | 否 |
| 真实集成 | 当前 provider、研究源或 Harness 真能工作 | 真实调用、版本、成本与错误 | 否 |

优先检查确定性 outcome，其次检查 schema 与轨迹；模型 grader 只评价相关性、证据覆盖和表达质量等主观项。若被测 Harness 同时生成评语，它不能成为自己的唯一裁判。

## Harness 一致性

DSH、Codex、Claude Code、OpenCode 和 Pi 共用同一业务任务与安全断言，但保留各自 adapter 证据：

- executable、真实版本、adapter 版本和 capability report；
- 原生 session、interrupt、resume 与事件流是否真实可用；
- Run 工件隔离是否经过验证，而非只声明支持；
- OfferU Operation 是否全部经 Bridge 与 Registry；
- mutation 是否只形成提案并在工作台独立确认；
- 断连、过期、未知结果和恢复是否失败关闭。

某 Harness 只有在其必需 conformance tasks 全部有效通过后才能写入“支持列表”。另一个 Harness 的通过结果不能继承。

## 状态定义

| 状态 | 含义 |
| --- | --- |
| `PASS` | 所有必需断言都有有效证据并达到 trial 要求 |
| `FAIL` | 实际执行后出现可复现的产品、契约或质量失败 |
| `BLOCKED` | 外部凭据、隔离环境或服务缺失，尚未测到目标行为 |
| `NOT_RUN` | 未执行，并记录原因 |
| `INVALID` | fixture、grader、证据或执行过程无效，结果作废 |

`BLOCKED`、`NOT_RUN` 与 `INVALID` 都不能计入通过率。没有 trace/outcome 的“看起来正常”不是 `PASS`。

## Suite 与试验次数

- Capability tasks 探索新能力边界；Regression tasks 保护已证明行为。
- 初始 suite 保留 20–50 个高价值真实任务，不追求题量。
- 确定性任务至少运行一次。
- 涉及模型、网络、检索或 Agent 路由的 required task 从相同 fixture 初态独立运行三次。
- Internal Beta 核心旅程以连续 3/3 作为最低可靠性信号；Public Release critical journey 必须连续 10/10，并完成至少 50 个扩展组合、first-run pass ≥98%。一次成功不能外推稳定支持，retry 后变绿不能掩盖 flaky。

`offeru-core-v1` 的 required tasks 必须全部实际执行并有效通过。Integration tasks 只有在对外声称对应真实集成可用时才进入目标范围，但声称时不得跳过。

## 标准流程

```text
用户目标或已知失败
  -> 固化 Task + fixture + grader
  -> 运行 baseline/candidate
  -> 检查轨迹与 outcome
  -> 只修一个纵向切片
  -> 定向复测 + regression
  -> 生成 schema-valid 报告
  -> 人工决定：接受 / 修复 / 补证据
```

每次运行记录：

- suite/version/run ID、commit 与 dirty state；
- OS、Python、Node、Harness、adapter、provider/model；
- fixture 和真实数据隔离说明；
- 完整命令或可复现交互、退出码、耗时和 trial；
- 脱敏后的标准事件、Operation 轨迹与最终 outcome；
- 限制、成本、失败复现和人工 verdict。

报告格式见 [`reports/README.md`](./reports/README.md)。报告及 artifacts 严禁包含 API Key、Cookie、OAuth token、真实邮件正文或不必要的个人信息。

## 维护规则

- 用户可见行为改变时，先更新 Task 或 grader，再改实现。
- 历史失败修复并稳定通过后，加入 regression suite。
- 不为提高分数删除困难样例；无效任务应标记 `INVALID` 并解释修订。
- 日期化报告只有在仍对应当前可定位 commit 且满足 schema 时才保留。
- 过期报告删除后从 Git 历史追溯，不在仓库内另建 archive。
