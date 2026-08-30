# OfferU Public Release Status

更新时间：2026-08-30

## Current release phase

```text
AUTONOMOUS_PRODUCTION_READINESS
```

## Current verdict

```text
OFFERU_PUBLIC_RELEASE_NOT_READY
```

`RESUME_WORKSPACE_BETA_READY` 是上一阶段的 Internal Beta 检查点，不是 Public Release 结论。当前仓库没有 signed installer、clean-machine、upgrade、migration、backup/restore、security、soak、live runtime 或 10/10 E2E 的正式 Release 证据，因此不得宣称 Public Release Ready。

## Current Gate

```text
DATA_SAFETY_01
consistent SQLite backup → verified restore staging → restart recovery
```

状态：`FAIL`

原因：当前公开步骤只是在停服后复制 SQLite 文件，未使用一致性快照，未包含资产/版本 manifest，未执行恢复后完整性检查，也没有连续 3 次 backup/restore 证据。

## Release dashboard

| Gate | Status | Current evidence |
| --- | --- | --- |
| Core Product | NOT_VERIFIED | Internal Beta Replay/Fixture 路径曾通过；没有 Public RC 级 10/10 与 50-run 证据 |
| Data Safety | FAIL | 一致性 backup/restore/migration matrix 尚未通过 |
| Security | NOT_VERIFIED | 无 canary、dependency、permission、logging、CSP 全套报告 |
| Reliability | NOT_VERIFIED | 无正式 restart matrix、2h/100-cycle soak 与 RSS 报告 |
| Packaging | FAIL | Tauri release launcher 仍依赖 repo 与 `.venv312`，无可发布 sidecar/installer |
| Live Runtime | NOT_VERIFIED | Replay 可用；没有至少一个真实 Agent Runtime `LIVE_PASS` |
| E2E | NOT_VERIFIED | 无当前 commit 的正式 Eval baseline、10/10 critical path 或 50-run report |

## Last passing checkpoint

```text
RESUME_WORKSPACE_BETA_READY
scope: isolated SQLite + Replay/Fixture Internal Beta
date: 2026-08-30
```

上一检查点记录了 Onboarding、Job preparation、Resume Workspace、Interview、Learning、失败可见、重复防护和重启持久化的本地内测结果，并记录了后端 `265 passed`、前端 typecheck/build 通过。其浏览器脚本与部分证据位于临时目录，且没有与当前 commit 对应的正式 Eval report，因此只作为实现线索，不能作为 Public Release PASS 继承。

## Evidence policy

- `PASS`：当前可定位 commit 的权威证据覆盖整个 Gate；
- `FAIL`：已知实现或运行事实违反 Gate；
- `BLOCKED_EXTERNAL`：仅限签名证书、本人 OAuth、法律/隐私决策或第三方生产账号；
- `PRE_EXISTING_FAILURE`：已确认在本 Release 改动前存在，但仍需在 Release 前处理；
- `NOT_VERIFIED`：没有足够证据；不得按 PASS 计算。

临时终端输出、`C:\temp` 脚本、历史聊天结论、单次测试和静态代码存在性不能单独证明 Release Gate。

## Next action

```text
1. 完成 SQLite Online Backup API 一致性备份、manifest/hash、integrity check 与安全 restore staging。
2. 把操作接入 Operation Registry 和 Settings 可见路径。
3. 建立隔离旧库与真实恢复的确定性测试；按项目约束记录尚未执行的命令。
4. 更新 STATUS / QUALITY_SCORE，继续下一个最高优先级 Data Safety / Security blocker。
```

## External requirements (not yet the current blocker)

- Windows/macOS 合法代码签名证书；
- 若选择 Codex/Gmail 等生产集成，需要使用者完成对应 OAuth；
- 隐私披露、数据处理与公开发布策略需要产品所有者最终确认；
- 实时第三方研究若作为正式 claim，需要真实 Provider 账号/配额。

这些外部事项当前不构成停止理由，因为仓库内仍有大量可以自主完成的 Data Safety、Security、Reliability、E2E 和 Packaging 工作。
