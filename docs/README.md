# OfferU 文档导航

OfferU 只维护一套现行设计。领域含义、架构决策、目标设计、当前代码和运行证据分层管理，避免旧计划被误读成已完成能力。

## 事实优先级

```text
CONTEXT.md
  领域词汇与产品不变量
        ↓
docs/adr/README.md
  已接受与已取代的架构决策
        ↓
10 份主题设计
  目标模块、协议、交互和迁移顺序
        ↓
实时 CLI manifest / Operation Registry
  当前代码真正暴露的能力
        ↓
版本化 Eval + 有效报告
  当前版本真正通过的行为
```

发生冲突时：

- 领域含义以 [`CONTEXT.md`](../CONTEXT.md) 为准；
- 架构取舍以[决策账本](./adr/README.md)中最新 accepted 条目为准；
- 动态参数与能力以实时 Registry 和 capability probe 为准；
- “已可用”“可内测”“支持某 Harness”等结论只能由当前有效 Eval 证明。

## 10 份活跃设计

| # | 文档 | 唯一职责 |
| --- | --- | --- |
| 1 | [Agent 系统总览](./architecture/agent-system.md) | 全局拓扑、事实源、主控权与迁移状态 |
| 2 | [Agent 操作控制面](./architecture/agent-control-plane.md) | OfferU 内部深模块、接口与责任边界 |
| 3 | [Agent Bridge 协议](./architecture/agent-bridge-protocol.md) | CLI-first stdio JSONL、消息与错误契约 |
| 4 | [Harness 接入](./architecture/harness-integrations.md) | DSH、Codex、Claude Code、OpenCode、Pi 的 adapter 与一致性门 |
| 5 | [Operation 与安全](./architecture/operation-security.md) | 授权、确认、隔离、事实门与失败策略 |
| 6 | [Run 生命周期](./architecture/run-lifecycle.md) | Task/Run/Session、事件、恢复、中断与交接 |
| 7 | [工作台交互](./architecture/workbench-interaction.md) | DSH Web / Harness 原生界面、控制栏与用户确认 |
| 8 | [浏览器扩展](./architecture/browser-extension.md) | 岗位采集、安全填表与回执候选 |
| 9 | [SiteRulePack v1](./architecture/site-rule-pack-v1.md) | 浏览器站点规则的机器契约 |
| 10 | [迁移路线](./implementation/migration-roadmap.md) | 从 Pi 内置主 Agent 到外部 Harness 的纵向切片 |

辅助事实源不计入 10 份设计：

- [决策账本](./adr/README.md)：ADR 编号、结论与取代关系；
- [工程协作规则](./agents/domain.md)：Issue、triage 与领域文档规范；
- [Eval 手册](./evals/README.md)：验收方法、套件与报告格式；
- [视觉 Design DNA](./design/offeru-design-dna.json)：机器可读视觉令牌。

## 当前目标与实现状态

已接受的目标架构是：

- 外部 Coding Agent Harness 持有唯一主控 Loop；
- OfferU 是本地确定性操作台与控制面；
- 业务接入 CLI-first，不提供 MCP 业务入口；
- DeepSeek Harness 与 Codex 优先，DSH Web 是第一个主交互面；
- Claude Code、OpenCode 与 Pi 通过同一行为契约后再声明支持。

这不是完成度声明。当前代码仍含 Pi Worker 主路径、Pi 命名 API、旧 CLI `confirm` 和其他迁移期入口。DSH plugin、新 Bridge 与 Codex adapter 尚未通过纵向切片验收，实际差距以[迁移路线](./implementation/migration-roadmap.md)为准。

## 文档生命周期

Git 历史就是归档；仓库内不再维护 `docs/archive`。

1. 新领域词汇或不变量直接更新 `CONTEXT.md`。
2. 难以逆转的决策追加到 `docs/adr/README.md`，不再新建独立 ADR 文件。
3. 现行架构细节更新对应主题页，不创建日期化“新版设计”。
4. 当前实施顺序只更新 `migration-roadmap.md`；完成后去掉操作噪音，保留验收门。
5. 一次性研究、审计、会议记录和被取代计划在提炼有效结论后删除。
6. Eval 目录只保留可复现 suite、报告契约和仍能证明当前 commit 的正式报告。
7. 新活跃设计必须说明为什么不能并入现有 10 个主题，否则不创建。

删除旧文档前，将仍有效的领域词汇写入 `CONTEXT.md`、长期决策写入 ADR 账本、验收规则写入 Eval。删除只移除重复表述，不删除事实源。

## 常用只读入口

在 `backend` 目录读取当前实现表面：

```powershell
.\.venv312\Scripts\python.exe -m app.cli doctor --pretty
.\.venv312\Scripts\python.exe -m app.cli manifest --pretty
.\.venv312\Scripts\python.exe -m app.cli ops --pretty
.\.venv312\Scripts\python.exe -m app.cli schema <operation_name> --pretty
.\.venv312\Scripts\python.exe -m app.cli run agent_playbook --arg detail=full --pretty
```

这些命令描述的是迁移中的当前代码。目标 Bridge 命令与兼容规则以 [Agent Bridge 协议](./architecture/agent-bridge-protocol.md)为准。
