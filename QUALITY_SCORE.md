# OfferU Public Release Quality Score

更新时间：2026-09-09

## Scoring rule

评分表示“距离 Public Release Gate 的证据化完成度”，不是代码质量印象。没有当前、可复现、覆盖整个要求的证据时，即使功能看起来存在也不能高分。`PASS` 需要在 `RELEASE_CHECKLIST.md` 中有权威证据；历史 Internal Beta 结果只提供有限分数。

| Domain | Score | Evidence grade | Main reason |
| --- | ---: | --- | --- |
| Onboarding | 68/100 | Isolated E2E + CI repeatability configured | 50/50 first-run 与 10/10 composite 通过；CI 已配置 10 个隔离 critical new-user runner 但未在远程执行；clean-machine 独立用户入口仍缺 |
| Today | 76/100 | Current browser task UX + E2E partial | Today 已显示持久化 CareerTask 的 status/progress/error，主要页面 actionable empty states 通过隔离浏览器矩阵，并通过 cancel 与 retry confirmation path；全事件 projection matrix 与 clean-machine 仍缺 |
| Pipeline | 65/100 | E2E partial | Job/Packet/Timeline 路径已在重复性套件通过；existing-user migration 与全 stage matrix 仍缺 |
| Job | 68/100 | E2E partial | 自动准备与 Job Context 在隔离浏览器路径通过；live research claim 与全失败矩阵不足 |
| Resume | 80/100 | Current browser + performance evidence | 手动编辑、Proposal、stale、version、PDF、失败重试、10/10 和性能 SLO 已有证据；clean Tauri UI、99.9% 长时 autosave 仍未验证 |
| Role Intelligence | 42/100 | Deterministic authority evidence | Runtime normalization、dedupe、cohort、Delta、Evidence Gap 和 persisted evidence 已有当前测试；至少一个 live provider 与 10-role matrix 缺失 |
| Interview | 72/100 | Current isolated E2E + recovery | Focus → Interview → Debrief → Learning 进入 10/10 组合路径；live provider、长时恢复和完整行为约束仍不足 |
| Profile / Memory | 68/100 | E2E partial | Learning Candidate 回流与 review 路径进入 10/10 组合路径；完整六态 lifecycle/history/conflict 未验证 |
| Agent Runtime | 76/100 | Current Codex live/lifecycle + Registry bridge + six-agent matrix | Codex `0.153.4` 已真实验证 live model、structured output、streaming、resume、cancel、cwd isolation，并通过 Operation Registry 只读读取 Career Context；六个候选 Agent 的 `NOT_VERIFIED`、`UNAVAILABLE`、`BLOCKED_AUTH`、`ERROR` 状态和 capability-aware provider selection 已有证据；其它 Provider 认证/模型、真实 Resume/Email/Profile downstream 和 Public Release clean-machine 仍缺 |
| Automation | 72/100 | Current task projection + real worker + architecture evidence | Inbox/CareerTask 实时投影、UI cancel/retry confirmation、双击/已提交后传输重试唯一性、100-cycle Replay worker、两个独立进程的 CareerTask/AutomationEvent claim、跨进程 auth/timeout/restart recovery contract、唯一 Event→Rule→CareerTask dispatcher 和 startup recovery boundary audit 已有实现/部分证据；Reliability-14 尚未执行，provider/network cancel/resume 和全部业务 mutation 并发仍不足 |
| Data Safety | 88/100 | Current deterministic migration + export/reset | Online Backup API、manifest/hash、三次恢复、restart、migration rollback、integrity、structured export redaction、Demo Reset scope 和 Settings/Doctor 路径均有当前报告 |
| Reliability | 89/100 | Current E2E + task UX + startup observability | 10/10、50/50、失败浏览器路径、双击/传输重试、真实 backend recovery/mutation matrix、100-cycle worker、双进程 claim、task status/control、startup recovery health/diagnostics 和 100-cycle RSS 门槛均有当前证据；Reliability-14 新增跨进程 failure/retry/restart 矩阵但尚未执行，CI 已配置 10 个隔离 critical new-user runner 但未远程执行；完整 worker/browser/network/restart 矩阵仍缺，2 小时是未执行的等价 endurance 方式 |
| Security | 69/100 | Security 11 partial | error ID、Registry-backed diagnostic、API/browser canary、确认的原始路径收口、Python `pip-audit` 与 npm audit、共用 JSON/Run artifact canary、最新 RustSec 普通 audit、Tauri permission contract、Python logger AST contract、云端类别同意、Gmail/IMAP 只读确认、邮箱撤回、隐私卫生计数、合成测试数据清理、Provider health 与 durable error projection 的直接 PII redaction、明确确认清理和 CI 浏览器诊断 artifact audit 配置已有当前证据；严格 RustSec unsound policy 仍被 `glib 0.18.5 / RUSTSEC-2024-0429` 阻塞，CI 下载目录复扫尚未在远程 runner 执行；正常工作区仍有 3 条历史旧正文，历史 artifact scrub、完整 runtime PII-data-flow、retention、真实 OAuth 和完整浏览器证据仍缺 | 
| Installer / Update | 60/100 | Packaging partial | `0.4.0` NSIS/MSI、sidecar、历史 installed smoke、卸载/重装和 release Doctor 通过；CI 新增 installer-only `desktop-installed-smoke` 但本轮未在 runner 验证；tag 打包/Draft Release 已有 `--require-ready` fail-closed gate，签名、updater、previous-release upgrade、clean OS UI 仍未验证 |

## Weighted release score

```text
Current unweighted average: 71/100
Release verdict: NOT READY
```

该平均分不能抵消硬 Gate。Data Safety、Security、Packaging、Live Runtime 或 E2E 任一未通过，最终状态都不能是 `OFFERU_PUBLIC_RELEASE_READY`。

2026-09-09 Local Agent Conformance 切片新增 Codex live/lifecycle、Registry grounding、六 Agent capability matrix、持久化能力投影、能力感知 Provider 选择和 390px/1440px Agent UI 证据，因此 Agent Runtime 从 66/100 调整为 76/100，整体未加权平均由 70/100 调整为 71/100。该证据不替代真实 Resume、邮箱 OAuth、Profile 长期演化、live Role Intelligence、签名、升级、clean-machine 和完整安全/隐私硬 Gate，Public Release 仍为 `NOT READY`。

## Recalculation trigger

每完成一个大型 Workstream 后：

1. 更新对应 `RELEASE_CHECKLIST.md` 项的状态与证据；
2. 只按新增的当前证据调整分数；
3. 更新 `STATUS.md` 的 Current Gate 与 Next action；
4. 继续最高优先级 Release blocker。
