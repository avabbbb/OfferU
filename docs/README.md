# OfferU 文档导航

这里区分“产品应该怎样”“代码暴露了什么”和“当前版本已经证明什么”。不要再用旧路线图或静态功能表替代实测证据。

## 从哪里开始

| 你要回答的问题 | 入口 |
|---|---|
| OfferU 的领域模型、用户目标和产品边界是什么？ | [`CONTEXT.md`](../CONTEXT.md) |
| 当前架构为何这样设计？ | [`docs/adr`](./adr/) 中最新 accepted ADR |
| Agent、Registry 和执行器如何分工？ | [`Agent System`](./architecture/agent-system.md) |
| 当前版本是否真的可用、Agent 是否完整？ | [`Eval 手册`](./evals/README.md) 与最新有效报告 |
| 如何让 DeepSeek Agent 做真实测试？ | [`DeepSeek Eval Runbook`](./evals/deepseek-runbook.md) |
| 过去的设计和阶段计划在哪里？ | [`Archive`](./archive/README.md) |

## 当前事实链

```text
CONTEXT + accepted ADR
        定义预期行为
                ↓
实时 doctor / manifest / ops / schema
        定义当前可执行表面
                ↓
版本化 Eval suite + trace + outcome
        证明当前实际行为
                ↓
Eval 报告
        驱动下一修复或发布决策
```

当来源冲突时：

- 领域含义和预期行为以 `CONTEXT.md` 与最新 accepted ADR 为准。
- Operation、参数和动态数量以实时 Registry 为准。
- “已通过”“可内测”“Agent 完整”等运行事实只能由符合规范的最新 Eval 报告证明。
- 归档文件和 pre-eval 报告只提供历史线索，不覆盖前三项。

## 活跃文档

| 路径 | 维护内容 |
|---|---|
| [`architecture/agent-system.md`](./architecture/agent-system.md) | 当前 Agent 拓扑、责任边界与不变量 |
| [`evals/README.md`](./evals/README.md) | Eval 方法、状态、grader 和验收规则 |
| [`evals/offeru-core-v1.md`](./evals/offeru-core-v1.md) | 24 个核心产品与 Agent 完整性任务 |
| [`evals/deepseek-runbook.md`](./evals/deepseek-runbook.md) | DeepSeek IDE/CLI Agent 的真实执行协议 |
| [`evals/reports`](./evals/reports/README.md) | 正式结果与已降级标记的历史快照 |
| [`agents`](./agents/domain.md) | Issue、triage 和领域文档协作规则 |
| [`design/offeru-design-dna.json`](./design/offeru-design-dna.json) | 机器可读的视觉设计 DNA |

## ADR 规则

- ADR 保留完整历史，不删除 superseded 记录。
- 架构变化写新 ADR，不在 README 中悄悄改变决策。
- 当前实现冲突时，以最新 `accepted` ADR 为目标事实，并通过 Eval 暴露实现差距。
- 关键入口包括 [量化验收原则](./adr/0028-use-three-layer-quantitative-acceptance-gates.md)、[统一 Operation Registry](./adr/0029-one-operation-registry-for-gui-cli-tui-and-slash-skills.md)、[结构化 Skill Registry](./adr/0037-structured-skill-registry-is-the-single-source.md)、[主 Agent runtime](./adr/0046-use-pi-sdk-worker-for-main-agent-runtime.md) 和 [Vite/Tauri 前端](./adr/0047-use-vite-static-spa-for-tauri-frontend.md)。

## 文档生命周期

1. 用户目标或真实失败先固化为 Eval Task。
2. 架构决策进入 ADR；当前拓扑同步到 `architecture/agent-system.md`。
3. 实施计划只服务一个可验收纵向切片。
4. 切片结束后，保留必要 ADR/Task，阶段计划移入 archive。
5. 每次正式测试生成日期化报告，不覆盖历史结果。

README 只保留定位、启动方式、已经证明/尚未证明的状态和入口；动态计数从 CLI 发现，不在多份文档中复制。
