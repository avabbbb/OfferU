# Triage Labels

工程技能使用五个标准角色表达 Issue 的处理状态。类型标签（例如 `bug`、`enhancement`）可以并存，但不能替代状态标签。

| Canonical role | GitHub label | Meaning |
| --- | --- | --- |
| `needs-triage` | `needs-triage` | 维护者需要评估 |
| `needs-info` | `needs-info` | 等待报告者补充信息 |
| `ready-for-agent` | `ready-for-agent` | 规格完整，可由 AFK Agent 独立领取 |
| `ready-for-human` | `ready-for-human` | 需要人工实现或决策 |
| `wontfix` | `wontfix` | 决定不处理 |

当技能提到某个 canonical role 时，必须使用表中对应的 GitHub label，不创建同义标签。
