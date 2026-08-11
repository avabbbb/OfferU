# OfferU Eval 手册

本目录是 OfferU 的验收事实入口。功能是否“可用”、Agent 是否“完整”、版本是否“可发布”，不再由功能清单、演示截图或单次聊天判断，而由可复现的 Eval 任务、轨迹证据和最终状态共同证明。

当前基线套件是 [`offeru-core-v1`](./offeru-core-v1.md)。在出现一份有效且满足验收规则的报告前，OfferU 的状态统一表述为：**内部 Alpha；核心能力尚未被正式 Eval 证明**。

需要手动交给 DeepSeek IDE/CLI Agent 时，直接使用 [`DeepSeek 深度测试提示词`](./deepseek-deep-test-prompt.md)；执行细则仍以 [`deepseek-runbook`](./deepseek-runbook.md) 和机器 schema 为准。需要在主 Agent 修复后持续做定向复测、全量回归和证据回传时，使用 [`DeepSeek Loop Eval 指导书`](./deepseek-loop-eval-guide.md)。

## 1. 四类事实源

不同问题使用不同事实源，不能混为一谈：

| 问题 | 权威来源 |
|---|---|
| 系统应该做什么 | [`CONTEXT.md`](../../CONTEXT.md) 与最新 accepted ADR |
| 当前暴露了什么能力 | 实时 `doctor`、`manifest`、`ops`、`schema` 输出 |
| 当前版本实际做到了什么 | 符合本手册的最新 Eval 报告及其证据 |
| 过去为什么这样设计 | [`docs/archive`](../archive/README.md) 与历史报告，仅供追溯 |

固定的 Operation 数量、模型名、CLI 版本和“已通过”描述都容易过时，不能写成长期产品承诺。

## 2. 核心术语

- **Task**：一个边界明确、可判定成败的测试任务。
- **Trial**：同一 Task 的一次独立执行。
- **Trajectory / Trace**：Agent 的消息、决策、工具调用、参数、重试和错误序列。
- **Outcome**：最终数据库、文件、UI 或外部系统状态。
- **Grader**：把证据映射为 `PASS` / `FAIL` 等状态的规则或评审者。
- **Suite**：带版本的一组 Tasks、fixtures、graders 和验收规则。
- **Baseline**：当前已接受版本的 Eval 结果。
- **Candidate**：等待与 baseline 比较的新版本结果。
## 3. Eval 证据层面

| 证据层面 | 证明对象 | 主要方法 | 是否允许模型单独判定 |
|---|---|---|---|
| 安全不变量 | 无越权写入、无凭据泄漏、无静默成功 | 状态差异、日志扫描、显式错误断言 | 否 |
| Operation 契约 | Registry、schema、dry-run、proposal/confirm | 结构化输出与确定性断言 | 否 |
| Agent 轨迹 | 选对工具、参数正确、失败可见、上下文充分 | Trace grader + outcome grader | 否 |
| 用户纵向旅程 | 普通用户能否从岗位到投递进展完成闭环 | 浏览器/GUI + 最终状态核验 | 否 |
| 真实集成 | 当前模型、研究源、邮件或 hosted executor 能否工作 | 真实 provider 调用、成本与错误证据 | 否 |

安全与 Operation 契约是底座，但不能替代用户旅程；“所有单元测试通过”不等于产品可用。用户旅程和真实集成也不能只看最终文案，必须检查工具轨迹和真实状态。

## 4. Grader 优先级

按以下顺序取证：

1. 确定性 outcome：数据库/文件/UI/Operation 状态是否符合预期。
2. Schema 与工具轨迹：调用了什么、参数是什么、是否越过 Registry。
3. 校准过的模型 grader：只评价相关性、证据覆盖、表达质量等主观维度。
4. 人工复核：用于校准模型 grader、处理边界案例和最终发布决策。

DeepSeek 可以执行测试、整理证据和提出判断，但当 DeepSeek 也是被测模型时，**不能同时成为唯一裁判**。关键 `PASS` 必须至少有一项确定性 outcome 或结构化轨迹证据；模型自评只能作为附加信号。

## 5. Suite 与试验次数

- **Capability suite** 探索系统能否完成新任务，允许保留困难任务和较低通过率；主要看 `pass@1`、失败类型和能力上限。
- **Regression suite** 保护已经证明的核心行为；任务稳定后才进入该套件。
- 初始套件应来自真实用户目标和历史失败，保持 20–50 个高价值任务，不追求虚高题量。
- 确定性任务至少运行 1 次；涉及模型、网络、检索或 Agent 路由的核心任务运行 3 次。
- `pass@1` 表示单次成功概率；`pass^3` 表示连续 3 次全部成功的可靠性。核心旅程以 `pass^3` 为发布信号。

## 6. 状态定义

| 状态 | 含义 |
|---|---|
| `PASS` | 所有必需断言都有证据，且达到指定 trial 条件 |
| `FAIL` | 测试实际执行，出现可复现的产品、契约或质量失败 |
| `BLOCKED` | 外部凭据、隔离环境或服务缺失，尚未测到目标行为 |
| `NOT_RUN` | 未执行；必须写明原因，不能计入通过率 |
| `INVALID` | fixture、grader、证据或执行过程无效，结果作废 |

`BLOCKED` 不是 `FAIL`，但两者都不能让相关验收范围通过。没有 trace/outcome 的“看起来正常”一律不是 `PASS`。

## 7. OfferU Core 验收规则

`offeru-core-v1` 必须同时满足：

- 所有 `required` 任务都实际执行并有效 `PASS`；不得出现 `BLOCKED`、`NOT_RUN` 或 `INVALID`。
- 所有非确定性 `required` 任务连续 3/3 通过。
- 只有对外声称某项真实集成可用时，其对应 `integration` 任务才必须执行并通过。
- Mutation 只能经过 Operation Registry、proposal 和用户确认；无隐藏写入、自动投递或自动发送。
- Provider/Agent 失败必须形成可见的失败状态，禁止空结果伪装完成。
- 主观质量项由校准 grader 评分，并抽样人工复核；它不能覆盖任何确定性失败。

Capability 分数用于排序下一步实验，不直接抵消必测任务或真实集成的失败。

## 8. 标准工作流

```text
用户目标/线上失败
  -> 固化 Task + fixture + grader
  -> 运行 baseline
  -> 阅读失败轨迹
  -> 只修一个可验收切片
  -> 运行 candidate + regression
  -> 生成报告
  -> 人工决定：发布 / 修复 / 补证据 / 调整 Eval
```

每次运行必须记录：commit、dirty files、OS、Python/Node/CLI、provider/model、suite 版本、命令、退出码、耗时、trial、脱敏后的 trace、最终状态、限制和成本。报告放在 [`reports/`](./reports/README.md)。

## 9. 维护规则

- 修改用户可见行为时，先更新/新增 Task，再改实现。
- 一个历史失败修复并稳定通过后，加入 regression suite。
- Eval 失败只能在有复现步骤和证据时进入工程 backlog。
- 不为了提高分数删除困难样例；如果 task/grader 无效，标记 `INVALID` 并说明修订。
- 报告严禁包含 API Key、Cookie、OAuth token、真实邮件正文或非必要个人信息。
- 本地 Eval 资产是事实源，不绑定即将停用的托管平台。

## 10. 方法来源

- [Anthropic: Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)
- [OpenAI: Working with evals](https://developers.openai.com/api/docs/guides/evals)
- [OpenAI: Trace grading](https://developers.openai.com/api/docs/guides/trace-grading)
- [OpenAI: Building a trustworthy third-party eval](https://openai.com/index/trustworthy-third-party-evaluations-foundations/)
- [DeepSeek: JSON Output](https://api-docs.deepseek.com/guides/json_mode/)
- [DeepSeek: Strict Mode for function calling](https://api-docs.deepseek.com/guides/tool_calls)

OpenAI 已公告其 legacy Evals 平台将在 2026 年 10 月 31 日只读、11 月 30 日关闭，因此 OfferU 采用可移植的本地 suite/report 格式，只借鉴方法，不形成平台依赖。
