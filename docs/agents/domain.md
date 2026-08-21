# OfferU 工程协作规则

本文件合并领域文档、Issue tracker 与 triage 约定。实现 Agent 先遵循根目录 `AGENTS.md`，再使用本页。

## 领域事实源

OfferU 采用一个领域上下文：

1. 先读根目录 [`CONTEXT.md`](../../CONTEXT.md)；
2. 再读 [`docs/adr/README.md`](../adr/README.md) 中相关编号；
3. 最后读 [`docs/README.md`](../README.md) 指向的对应主题设计。

Issue 标题、测试名称和实现说明使用 `CONTEXT.md` 的术语，并避开其中列出的误称。新概念若是实际领域缺口，先补 `CONTEXT.md`；难以逆转的架构取舍追加到同一 ADR 账本，不创建新的 ADR 文件。

发现实现或计划与现行 ADR 冲突时，明确写出 ADR 编号、冲突行为和影响。不得静默覆盖，也不得把 superseded 决策当作当前实现依据。

## Issue tracker

Issues 与 PRD 发布到当前 Git remote 对应的 GitHub Issues。所有操作使用仓库内的 `gh` CLI，以自动解析目标仓库。

```text
创建：gh issue create --title "..." --body-file <file>
读取：gh issue view <number> --comments
列表：gh issue list --state open --json number,title,body,labels,comments
评论：gh issue comment <number> --body "..."
标签：gh issue edit <number> --add-label "..."
关闭：gh issue close <number> --comment "..."
```

多行正文使用临时 body 文件，避免 PowerShell 转义改变内容；发布前确认 `gh auth status`。Pull Request 只承载代码评审，不进入需求分诊状态机。

技能要求“publish to the issue tracker”时创建 GitHub Issue；要求“fetch the relevant ticket”时用 `gh issue view <number> --comments`。GitHub 的 Issue 与 PR 共用编号，类型不明时先辨别。

## Triage 状态

每个 Issue 使用一个标准状态标签；`bug`、`enhancement` 等类型标签可以并存，但不能替代状态。

| Canonical role | GitHub label | 含义 |
| --- | --- | --- |
| `needs-triage` | `needs-triage` | 维护者尚未评估 |
| `needs-info` | `needs-info` | 等待报告者补充 |
| `ready-for-agent` | `ready-for-agent` | 规格完整，可由 Agent 独立领取 |
| `ready-for-human` | `ready-for-human` | 需要人工实现或决策 |
| `wontfix` | `wontfix` | 已决定不处理 |

不要创建同义状态标签。状态变化应由新增证据或明确决策驱动，不以 Agent 自述“完成”代替验收。

## 实现任务最小输入

一个 `ready-for-agent` 任务至少包含：

- 用户可见结果；
- 允许修改的文件范围；
- 相关 `CONTEXT` 术语和 ADR 编号；
- 现状证据与失败症状；
- 验收映射和用户需执行的命令；
- 明确不做的事项与外部权限。

实现只完成一个纵向切片。遇到 ADR 冲突、必须扩大范围、改变领域模型或新增外部权限时停止并提出一个阻塞问题。
