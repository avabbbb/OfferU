# Eval 报告

本目录只接收能够证明一个可定位 commit 当前行为的正式 Eval 报告。预评估、测试计划、聊天总结、只读审计和已失效运行记录不放在这里；需要追溯时使用 Git 历史。

## 命名

正式报告：

```text
YYYY-MM-DD-<executor>-<suite-id>-<run-id>.md
```

配套证据：

```text
artifacts/<run-id>/<task-id>/...
```

截图、脱敏 trace 和机器输出按 Task ID 组织，不得保存凭据或真实个人敏感数据。

## 最小结构

1. 运行身份：suite/version/run ID、commit、dirty state、执行 Harness/model。
2. 环境：OS、Python、Node、CLI、Harness/adapter、provider/model、fixture 隔离。
3. 总结：各状态数量、target scope 与明确 verdict。
4. 每个 Task 的 trials、命令或交互、退出码、耗时、trajectory evidence 与 outcome evidence。
5. 脱敏失败复现、限制、成本和下一步。
6. 与正文一致、可被 JSON parser 读取的 `eval-summary` JSON 代码块。

JSON 必须符合 [`report-schema.json`](../report-schema.json)。以下任一情况会使报告成为 `INVALID`：

- 把跳过、阻塞、模拟返回或模型自评记成 `PASS`；
- 正文、JSON、命令摘要或 artifacts 相互矛盾；
- 未记录 commit/dirty state，无法定位被测代码；
- 缺少必需的轨迹或 outcome 证据；
- 证据包含未经脱敏的凭据或个人信息。

## 当前基线

**当前没有有效正式 baseline，目录中也不保留旧报告作为占位。**

下一份报告必须覆盖 [`offeru-core-v1`](../offeru-core-v1.md)，符合机器 schema，并由实际执行证据而不是历史结论建立新的 baseline。
