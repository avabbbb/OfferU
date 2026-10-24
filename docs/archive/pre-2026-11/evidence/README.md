# 验收证据

本目录存放**证据，不存放设计**。设计权威见 [docs/README.md](../README.md)，证据规则见 [09 · 质量与发布](../09-quality-and-release.md)。

| 路径 | 内容 |
| --- | --- |
| `report-schema.json` | 正式 Eval 报告中 `eval-summary` JSON 代码块的机器 schema |
| `evolve-bench-schema.json` | OfferU-EvolveBench 的 case schema |
| `reports/YYYY-MM-DD-<executor>-<suite-id>-<run-id>.md` | 能证明某个可定位 commit 当前行为的正式报告 |
| `reports/artifacts/<run-id>/<task-id>/...` | 脱敏截图、trace、机器输出（默认只保留在本地，不提交） |

## 报告最小结构

1. 运行身份：suite / version / run ID、commit、dirty 状态、执行宿主和模型。
2. 环境：OS、Python、Node、CLI、宿主和 adapter、provider 和 model、fixture 隔离。
3. 总结：各状态的数量、目标范围、明确的结论。
4. 每个 Task 的 trials、命令或交互、退出码、耗时、轨迹证据、结果证据。
5. 脱敏后的失败复现、限制、成本、下一步。
6. 与正文一致、能被 JSON parser 读取的 `eval-summary` 代码块，符合 `report-schema.json`。

出现以下任一情况，报告即为 `INVALID`：把跳过、阻塞、模拟返回或模型自评记成 `PASS`；正文、JSON、命令摘要或附件互相矛盾；没有记录 commit 或 dirty 状态；缺少必需的轨迹或结果证据；证据里有未脱敏的凭据或个人信息。

**当前没有有效的正式 baseline。** 2026-10 之前的报告已归档到 `docs/archive/pre-2026-10/evals/reports/`，只作为对应 commit 当时的历史证据。
