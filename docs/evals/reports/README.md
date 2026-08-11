# Eval 报告

本目录只接收可追溯的 Eval 结果和明确标记的历史 pre-eval 快照。

## 命名

正式报告：`YYYY-MM-DD-<executor>-<suite-id>-<run-id>.md`

配套证据：`artifacts/<run-id>/`。截图、脱敏 trace 和机器可读输出必须以 Task ID 命名，不得存放凭据或真实个人敏感数据。

## 有效报告的最小结构

1. 运行身份：suite/version/run ID、commit、dirty state、执行 Agent/model。
2. 环境：OS、Python、Node、CLI、OfferU provider/model、隔离数据说明。
3. 总结：`PASS` / `FAIL` / `BLOCKED` / `NOT_RUN` / `INVALID` 数量、target scope 与 verdicts。
4. 每个 Task 的 trials、完整命令、退出码、耗时、trajectory evidence、outcome evidence。
5. 已脱敏的失败复现、限制、成本和下一步建议。
6. 一个与正文一致、能被 JSON parser 读取的 `eval-summary` JSON 代码块。

JSON 必须符合 [`report-schema.json`](../report-schema.json)。报告不能把跳过、阻塞、模拟返回或模型自评记成 `PASS`。正文、JSON、CLI 最终摘要或最终 artifacts 不一致时，整份报告为 `INVALID`。

## 当前记录

- [`2026-08-10-test-readiness-audit.md`](./2026-08-10-test-readiness-audit.md)：当前测试资产、数据隔离、Agent 完整性、长期职业模型和浏览器链路的只读就绪度审计；不是正式 baseline。
- [`2026-08-05-beta-readiness-pre-eval.md`](./2026-08-05-beta-readiness-pre-eval.md)：历史内测评估，缺少当前 schema 要求的完整证据，只能用来提取待复现任务。
- [`2026-07-30-runtime-acceptance.md`](./2026-07-30-runtime-acceptance.md)：历史运行时探测快照，不证明当前版本状态。
- [`2026-08-06-eval-report.md`](./2026-08-06-eval-report.md)：E1-E5 ad-hoc capability discovery，适合提取回归任务；不符合 `offeru-core-v1` 的 24 Task 与机器 schema，不能作为 baseline。

**当前仍没有有效正式 baseline。** 下一次运行应由修订后的 [`deepseek-runbook.md`](../deepseek-runbook.md) 驱动，满足机器 schema 和最终脱敏门，并覆盖 [`offeru-core-v1`](../offeru-core-v1.md)。
